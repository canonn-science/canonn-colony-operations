import { Injectable } from '@angular/core';
import { BUILD_ID } from './build-info';
import {
  AFFILIATION_NOT_A_COLONY,
  ARCHITECT_FORM_ACTION,
  ArchitectSubmission,
  buildArchitectFormBody,
} from './data/architect-form';
import {
  ArchitectInfo,
  ArchitectRegistryRow,
  buildArchitectInfoMap,
} from './data/architect-registry';
import { logger } from './data/logger';

/** Base URL for the Canonn cloud-function query API. */
const QUERY_BASE = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query';
const BGS_ENDPOINT = `${QUERY_BASE}/canonnbgs`;
const ARCHITECTS_ENDPOINT = `${QUERY_BASE}/canonnbgs/architects`;
const TYPEAHEAD_ENDPOINT = `${QUERY_BASE}/typeahead`;

/**
 * The architects Cloud Function endpoint is itself backed by this published Google Sheet
 * (a Form-response registry) — fetching it directly is a single request instead of paging
 * through the Cloud Function, so it's tried first. It's unauthenticated, published-to-web
 * Google infrastructure with no documented stability contract (no ETag/Last-Modified either,
 * so there's no cheap way to check for changes without fetching), so any failure — CORS,
 * network, an unrecognised layout — just falls back to the Cloud Function API below.
 */
const ARCHITECTS_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vS5TMBu2KJQBaNqSBropWVdXUcOjz-wJe57e8h4pRPzr7zZ066yjO-H2Z7hqZe-fOVSpzy-7dzAqU2z/pub?gid=1448295597&single=true&output=tsv';
/** Short timeout for the sheet fetch — it's a fast-path attempt, not a resilient one; fail quick and fall back. */
const ARCHITECTS_SHEET_TIMEOUT_MS = 8000;

/** Default per-request timeout for remote API calls (ms). */
const HTTP_TIMEOUT_MS = 20000;
/** Number of automatic retries for transient failures. */
const HTTP_RETRY_COUNT = 2;
/** Timeout for a form submission (ms). Not retried — see {@link CanonnBgsService.submitAssignment}. */
const FORM_SUBMIT_TIMEOUT_MS = 15000;

/** Records per BGS page, per the API contract. */
export const BGS_PAGE_SIZE = 50;

/** localStorage key the architect registry is persisted under. */
const ARCHITECTS_CACHE_KEY = 'canonn-bgs:architects-cache:v2';
/** How long the architect registry is cached before it's refetched. */
const ARCHITECTS_CACHE_DURATION_MS = 2 * 60 * 60 * 1000;

export const CANONN_FACTION = 'Canonn';
export const CDSR_FACTION = 'Canonn Deep Space Research';
const CANONN_FACTION_NAMES: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);

/** BGS state names that count as "at war" for the State column's gun icon. */
const WAR_STATES: ReadonlySet<string> = new Set(['War', 'Civil War']);
const ELECTION_STATE = 'Election';

/**
 * Error thrown by {@link CanonnBgsService}'s HTTP helpers for non-2xx responses.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Resolves after `ms` milliseconds. Used for retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface MinorFactionPresence {
  name: string;
  influence: number;
  /** Current state(s), e.g. "Boom", "War"; falls back to `state` when this is absent. */
  active_states?: string[];
  /** Upcoming state(s) not yet in effect, e.g. a war or election about to start. */
  pending_states?: string[];
  /** State(s) that just ended and are in a post-state cooldown, e.g. a war that just concluded. */
  recovering_states?: string[];
  state?: string;
}

interface BgsSystemRecord {
  name: string;
  controlling_minor_faction: string | null;
  minor_faction_presences?: MinorFactionPresence[];
  x: number;
  y: number;
  z: number;
}

interface BgsPageResponse {
  count: number;
  from: number;
  results: BgsSystemRecord[];
}

interface ArchitectRecord {
  'System Name': string;
  'Architect Name': string;
  'Canonn Architect': string;
  'Preferred Faction': string;
}

/** A typeahead match, with the coordinates needed to sort by distance from it. */
export interface TypeaheadSystem {
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface TypeaheadResponse {
  min_max?: TypeaheadSystem[];
  values?: string[];
}

/** A minor faction's presence in a system, for the Factions column's mini bar chart. */
export interface FactionInfluence {
  name: string;
  /** 0-100 percentage. */
  influencePercent: number;
}

/** Whether a war/election affecting Canonn or CDSR is already happening or just upcoming. */
export type FactionStateStatus = 'active' | 'pending' | null;

/** One row of the rendered table. */
export interface BgsRow {
  systemName: string;
  controllingFaction: string | null;
  /** Canonn faction influence, as a 0-100 percentage; null if Canonn has no presence in the system. */
  canonnInfluence: number | null;
  /** Canonn Deep Space Research faction influence, as a 0-100 percentage; null if absent. */
  cdsrInfluence: number | null;
  architect: string | null;
  /** Recorded as "Nobody — the system is not a colony": shown blank rather than offering Assign again. */
  notAColony: boolean;
  preferredFaction: string | null;
  /** Every minor faction present in the system, sorted by influence descending (highest first). */
  factions: FactionInfluence[];
  /** Whether Canonn or CDSR is (or is about to be) at war here — drives the State column's gun icon. */
  warState: FactionStateStatus;
  /** Tooltip text for the war icon (one line per contributing faction), or null if warState is null. */
  warDetails: string | null;
  /** Whether Canonn or CDSR is (or is about to be) in an election here — drives the ballot-box icon. */
  electionState: FactionStateStatus;
  /** Tooltip text for the election icon, or null if electionState is null. */
  electionDetails: string | null;
  /** Galactic coordinates (light-years), used to compute the Distance column. */
  x: number;
  y: number;
  z: number;
}

export interface BgsPage {
  page: number;
  rows: BgsRow[];
  totalCount: number;
  totalPages: number;
}

interface ArchitectsCachePayload {
  fetchedAt: number;
  /** The build that wrote this cache; a mismatch (a new build was deployed) invalidates it. */
  buildId: string;
  rows: ArchitectRegistryRow[];
}

/**
 * A copy of `row` showing the architect details of a just-submitted assignment, so the table
 * reflects the submission immediately instead of waiting for Google to republish the registry.
 */
export function rowWithAssignment(row: BgsRow, submission: ArchitectSubmission): BgsRow {
  return {
    ...row,
    architect: submission.architect || null,
    notAColony: submission.affiliation === AFFILIATION_NOT_A_COLONY,
    preferredFaction: submission.preferredFaction || null,
  };
}

/**
 * Parses the architects Google Form response sheet: tab-separated, header row first, columns
 * matched by name (not position) so a reordered/added column in the sheet doesn't break this.
 * Rows are returned in sheet order (oldest first), which is what makes "the last row wins"
 * and the dialog's "most recent answer" defaults work. Returns an empty array (which the
 * caller treats as "couldn't use this") if the expected columns aren't found at all.
 */
function parseArchitectsTsv(text: string): ArchitectRegistryRow[] {
  const rows: ArchitectRegistryRow[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.length > 0);
  if (lines.length === 0) {
    return rows;
  }

  const header = lines[0].split('\t');
  const systemNameIndex = header.indexOf('System Name');
  const architectNameIndex = header.indexOf('Architect Name');
  const preferredFactionIndex = header.indexOf('Preferred Faction');
  // Optional: the Cloud Function's copy of the data has it, but it's not load-bearing for the table.
  const affiliationIndex = header.indexOf('Canonn Architect');
  if (systemNameIndex === -1 || architectNameIndex === -1 || preferredFactionIndex === -1) {
    return rows;
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const systemName = cells[systemNameIndex]?.trim();
    if (!systemName) {
      continue;
    }
    rows.push({
      systemName,
      architect: cells[architectNameIndex]?.trim() ?? '',
      affiliation: affiliationIndex === -1 ? '' : (cells[affiliationIndex]?.trim() ?? ''),
      preferredFaction: cells[preferredFactionIndex]?.trim() ?? '',
    });
  }
  return rows;
}

/**
 * Checks Canonn's and CDSR's presences for a matching state (war or election), active,
 * pending (about to start next tick), or recovering (just ended, in its post-state
 * cooldown) — the latter two both render as the "not currently active" (grey) icon.
 * Active wins over the others if a system somehow has both (e.g. one of the two factions
 * is already at war while the other merely has it pending). Details list every
 * contributing faction/state pair, for the icon's tooltip.
 */
function summarizeFactionState(
  presences: readonly MinorFactionPresence[],
  matchesState: (state: string) => boolean,
): { status: FactionStateStatus; details: string | null } {
  const active: string[] = [];
  const notYetActive: string[] = [];

  for (const presence of presences) {
    if (!CANONN_FACTION_NAMES.has(presence.name)) {
      continue;
    }
    const activeStates = presence.active_states ?? (presence.state ? [presence.state] : []);
    for (const state of activeStates) {
      if (matchesState(state)) {
        active.push(`${presence.name}: ${state}`);
      }
    }
    for (const state of presence.pending_states ?? []) {
      if (matchesState(state)) {
        notYetActive.push(`${presence.name}: ${state} (pending)`);
      }
    }
    for (const state of presence.recovering_states ?? []) {
      if (matchesState(state)) {
        notYetActive.push(`${presence.name}: ${state} (recovering)`);
      }
    }
  }

  if (active.length > 0) {
    return { status: 'active', details: active.join('\n') };
  }
  if (notYetActive.length > 0) {
    return { status: 'pending', details: notYetActive.join('\n') };
  }
  return { status: null, details: null };
}

/**
 * Fetches the Canonn BGS dataset: a paged table of systems with their controlling
 * faction, Canonn/CDSR influence, and (via a separate lookup) architect details.
 *
 * Caching:
 * - The search token is fetched once per session and reused for every page.
 * - Each fetched page is memoised in memory so revisiting it (Previous/Next) is free.
 * - The architect registry is fetched once (across all its pages) and persisted in
 *   localStorage for {@link ARCHITECTS_CACHE_DURATION_MS}, since it changes far less
 *   often than BGS influence.
 */
@Injectable({ providedIn: 'root' })
export class CanonnBgsService {
  private tokenPromise?: Promise<string>;
  private readonly pagePromises = new Map<number, Promise<BgsPage>>();
  private registryPromise?: Promise<ArchitectRegistryRow[]>;
  /** The resolved registry, once loaded — what {@link recordAssignment} appends to. */
  private registryRows: ArchitectRegistryRow[] | null = null;
  /** When the registry was fetched, preserved across local edits so it still expires on schedule. */
  private registryFetchedAt = 0;
  /** {@link registryRows} collapsed to one entry per system; rebuilt when the registry changes. */
  private architectInfo: Map<string, ArchitectInfo> | null = null;

  /** Fetches a page of BGS results (0-based), from cache if it's already been loaded. */
  getPage(page: number): Promise<BgsPage> {
    let promise = this.pagePromises.get(page);
    if (!promise) {
      promise = this.fetchPage(page);
      this.pagePromises.set(page, promise);
      // Don't poison the cache with a failed fetch — let a later call retry.
      promise.catch(() => this.pagePromises.delete(page));
    }
    return promise;
  }

  /** Fire-and-forget prefetch for the next page; failures are silent and just retried on real navigation. */
  prefetchPage(page: number): void {
    void this.getPage(page).catch(() => {});
  }

  /** Name-suggestion + coordinate lookup, for the "sort by distance from system" search box. */
  typeahead(query: string): Promise<TypeaheadResponse> {
    return this.resilientGet<TypeaheadResponse>(`${TYPEAHEAD_ENDPOINT}?q=${encodeURIComponent(query)}`);
  }

  /**
   * Every Architect Registry submission, oldest first — the Assign dialog's source for
   * architect-name suggestions and for what a known architect last answered.
   */
  getArchitectRegistry(): Promise<readonly ArchitectRegistryRow[]> {
    return this.getRegistry();
  }

  /**
   * Submits a filled-in Assign dialog to the Architect Registry form.
   *
   * Google Forms sends no CORS headers, so this has to go out as an opaque `no-cors` request:
   * the submission is recorded, but the response is unreadable. A rejection therefore means
   * "the request never left the browser" (offline, blocked, timed out) — which is the failure
   * worth offering a retry for — while a resolve means "accepted by Google as far as we can
   * tell". It's deliberately not retried automatically: a retried POST that actually succeeded
   * the first time would add a duplicate row to the registry.
   */
  async submitAssignment(submission: ArchitectSubmission): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORM_SUBMIT_TIMEOUT_MS);
    try {
      await fetch(ARCHITECT_FORM_ACTION, {
        method: 'POST',
        mode: 'no-cors',
        // A CORS-safelisted content type, so the request needs no preflight (which would fail).
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: buildArchitectFormBody(submission).toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Folds a just-submitted assignment into everything already loaded — the registry, the
   * system lookup derived from it, the memoised BGS pages and the persisted cache — so the
   * new architect shows up straight away, and survives a reload, without waiting for Google
   * to republish the sheet. The cache's original fetch time is kept, so the authoritative
   * data is still refetched on the usual schedule.
   */
  recordAssignment(submission: ArchitectSubmission): void {
    const row: ArchitectRegistryRow = {
      systemName: submission.systemName,
      architect: submission.architect,
      affiliation: submission.affiliation,
      preferredFaction: submission.preferredFaction,
    };

    if (this.registryRows) {
      this.registryRows.push(row);
      this.architectInfo = buildArchitectInfoMap(this.registryRows);
      this.writeArchitectsCache(this.registryRows, this.registryFetchedAt);
    }

    for (const [page, promise] of [...this.pagePromises]) {
      const patched = promise.then(result => ({
        ...result,
        rows: result.rows.map(r => (r.systemName === submission.systemName ? rowWithAssignment(r, submission) : r)),
      }));
      patched.catch(() => this.pagePromises.delete(page));
      this.pagePromises.set(page, patched);
    }
  }

  /**
   * Fetches every page of the BGS dataset (reusing whatever's already cached) and
   * returns all rows concatenated in their natural order. Used when the table switches
   * into a full-dataset sort (by distance or by influence), which needs every row.
   * `onProgress`, if given, is called as each page arrives so the UI can show a meter.
   */
  async getAllRows(onProgress?: (loaded: number, total: number) => void): Promise<BgsRow[]> {
    const first = await this.getPage(0);
    const total = first.totalPages;
    const pagesByIndex = new Array<BgsRow[]>(total);
    let loaded = 0;
    onProgress?.(0, total);
    await Promise.all(
      Array.from({ length: total }, (_unused, page) =>
        this.getPage(page).then(result => {
          pagesByIndex[page] = result.rows;
          loaded++;
          onProgress?.(loaded, total);
        }),
      ),
    );
    return pagesByIndex.flat();
  }

  private async fetchPage(page: number): Promise<BgsPage> {
    const [token, architects] = await Promise.all([this.getToken(), this.getArchitectInfo()]);
    const response = await this.resilientGet<BgsPageResponse>(`${BGS_ENDPOINT}/${token}/${page}`);
    return {
      page,
      rows: response.results.map(record => this.toRow(record, architects)),
      totalCount: response.count,
      totalPages: Math.max(1, Math.ceil(response.count / BGS_PAGE_SIZE)),
    };
  }

  private toRow(record: BgsSystemRecord, architects: ReadonlyMap<string, ArchitectInfo>): BgsRow {
    const presences = record.minor_faction_presences ?? [];
    const info = architects.get(record.name);
    const canonnInfluence = this.influencePercent(presences, CANONN_FACTION);
    const cdsrInfluence = this.influencePercent(presences, CDSR_FACTION);
    const war = summarizeFactionState(presences, state => WAR_STATES.has(state));
    const election = summarizeFactionState(presences, state => state === ELECTION_STATE);
    return {
      systemName: record.name,
      controllingFaction: record.controlling_minor_faction ?? null,
      canonnInfluence,
      cdsrInfluence,
      // Spansh's colonisation flags are unreliable, so any system without a registered
      // architect is assignable — never blocked behind a "Not a colony" indicator. A
      // registry row that itself answers "not a colony" is different: that's a confirmed
      // answer, so it's shown blank rather than inviting another Assign.
      architect: info?.architect || null,
      notAColony: info?.affiliation === AFFILIATION_NOT_A_COLONY,
      preferredFaction: info?.preferredFaction || null,
      factions: [...presences]
        .sort((a, b) => b.influence - a.influence)
        .map(p => ({ name: p.name, influencePercent: p.influence * 100 })),
      warState: war.status,
      warDetails: war.details,
      electionState: election.status,
      electionDetails: election.details,
      x: record.x,
      y: record.y,
      z: record.z,
    };
  }

  private influencePercent(presences: readonly MinorFactionPresence[], factionName: string): number | null {
    const presence = presences.find(p => p.name === factionName);
    return presence ? presence.influence * 100 : null;
  }

  private getToken(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.resilientGet<string>(BGS_ENDPOINT);
    }
    return this.tokenPromise;
  }

  /** The system -> architect lookup the table's rows are built from, derived from the registry once. */
  private async getArchitectInfo(): Promise<ReadonlyMap<string, ArchitectInfo>> {
    const rows = await this.getRegistry();
    if (!this.architectInfo) {
      this.architectInfo = buildArchitectInfoMap(rows);
    }
    return this.architectInfo;
  }

  /** Loads the architect registry at most once per session (see class doc). */
  private getRegistry(): Promise<ArchitectRegistryRow[]> {
    if (!this.registryPromise) {
      this.registryPromise = this.loadRegistry().catch(error => {
        // Clear the memo so a later page fetch can retry instead of failing forever.
        this.registryPromise = undefined;
        throw error;
      });
    }
    return this.registryPromise;
  }

  private async loadRegistry(): Promise<ArchitectRegistryRow[]> {
    const cached = this.readArchitectsCache();
    if (cached) {
      this.registryRows = cached.rows;
      this.registryFetchedAt = cached.fetchedAt;
      return cached.rows;
    }

    const rows = (await this.loadRegistryFromSheet()) ?? (await this.loadRegistryFromApi());
    this.registryRows = rows;
    this.registryFetchedAt = Date.now();
    this.writeArchitectsCache(rows, this.registryFetchedAt);
    return rows;
  }

  /**
   * Fast path: fetch the published Google Sheet directly (one request) and parse it
   * ourselves. Returns null — never throws — on any failure, so the caller falls back
   * to {@link loadRegistryFromApi} unconditionally.
   */
  private async loadRegistryFromSheet(): Promise<ArchitectRegistryRow[] | null> {
    try {
      const text = await this.fetchTextOnce(ARCHITECTS_SHEET_URL, ARCHITECTS_SHEET_TIMEOUT_MS);
      const rows = parseArchitectsTsv(text);
      if (rows.length === 0) {
        return null;
      }
      return rows;
    } catch (error) {
      logger.warn('Architects sheet fetch failed, falling back to the Cloud Function API.', error);
      return null;
    }
  }

  /** Reliable path: page through the Cloud Function's own architects endpoint. */
  private async loadRegistryFromApi(): Promise<ArchitectRegistryRow[]> {
    const rows: ArchitectRegistryRow[] = [];
    for (let page = 0; ; page++) {
      const records = await this.resilientGet<ArchitectRecord[]>(`${ARCHITECTS_ENDPOINT}/${page}`);
      if (records.length === 0) {
        break;
      }
      for (const record of records) {
        rows.push({
          systemName: record['System Name'],
          architect: record['Architect Name'],
          affiliation: record['Canonn Architect'] ?? '',
          preferredFaction: record['Preferred Faction'],
        });
      }
    }
    return rows;
  }

  private readArchitectsCache(): { rows: ArchitectRegistryRow[]; fetchedAt: number } | null {
    try {
      const raw = localStorage.getItem(ARCHITECTS_CACHE_KEY);
      if (!raw) {
        return null;
      }
      const payload = JSON.parse(raw) as ArchitectsCachePayload;
      // A new build was deployed since this was cached — treat it as stale regardless of age,
      // so a fix or data-shape change ships to every visitor immediately, not after 2 hours.
      if (payload.buildId !== BUILD_ID) {
        return null;
      }
      if (Date.now() - payload.fetchedAt >= ARCHITECTS_CACHE_DURATION_MS) {
        return null;
      }
      return { rows: payload.rows, fetchedAt: payload.fetchedAt };
    } catch {
      return null;
    }
  }

  private writeArchitectsCache(rows: readonly ArchitectRegistryRow[], fetchedAt: number): void {
    try {
      const payload: ArchitectsCachePayload = { fetchedAt, buildId: BUILD_ID, rows: [...rows] };
      localStorage.setItem(ARCHITECTS_CACHE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full/unavailable (e.g. private browsing) — the in-memory rows still serve this session.
    }
  }

  /**
   * Performs an HTTP GET with a timeout and exponential-backoff retry so that
   * transient network errors and slow/hung requests don't permanently break
   * the feature. Callers still receive the error if all retries fail.
   */
  private async resilientGet<T>(url: string, timeoutMs: number = HTTP_TIMEOUT_MS): Promise<T> {
    let lastError: unknown;
    // One initial attempt plus HTTP_RETRY_COUNT retries.
    for (let attempt = 0; attempt <= HTTP_RETRY_COUNT; attempt++) {
      try {
        return await this.fetchJson<T>(url, timeoutMs);
      } catch (error) {
        lastError = error;
        // Don't retry client errors — they won't succeed on a retry. Timeouts (aborts)
        // and network/5xx errors are still retried with backoff.
        const status = error instanceof HttpError ? error.status : undefined;
        if (status !== undefined && status >= 400 && status < 500) {
          throw error;
        }
        if (attempt === HTTP_RETRY_COUNT) {
          break;
        }
        const retryIndex = attempt + 1;
        await delay(Math.min(1000 * 2 ** (retryIndex - 1), 8000));
      }
    }
    throw lastError;
  }

  private async fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    return JSON.parse(await this.fetchTextOnce(url, timeoutMs)) as T;
  }

  /** A single fetch attempt (no retry) with a timeout; throws on any non-2xx or network failure. */
  private async fetchTextOnce(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new HttpError(response.status, response.statusText || `HTTP ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
