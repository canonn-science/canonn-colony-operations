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

/**
 * Fallback page size, used only until the API's actual page size is known (see
 * {@link CanonnBgsService.resolvePageSize}); also the client's default page-size selection.
 * Not authoritative — the Cloud Function's real per-page record count isn't a fixed contract
 * (issue #7) and is inferred per-session from page 0's response instead.
 */
export const BGS_PAGE_SIZE = 50;

/** localStorage key the architect registry is persisted under. */
const ARCHITECTS_CACHE_KEY = 'canonn-bgs:architects-cache:v2';
/** How long the architect registry is cached before it's refetched. */
const ARCHITECTS_CACHE_DURATION_MS = 2 * 60 * 60 * 1000;

export const CANONN_FACTION = 'Canonn';
export const CDSR_FACTION = 'Canonn Deep Space Research';
const CANONN_FACTION_NAMES: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);

/**
 * BGS state names that count as "at war" / "in an election" for the State column's icons,
 * pre-normalised per {@link normalizeStateName} (issue #6, R4) so raw entries can be compared
 * against these sets after normalising them the same way.
 */
const WAR_STATES: ReadonlySet<string> = new Set(['war', 'civilwar']);
const ELECTION_STATES: ReadonlySet<string> = new Set(['election']);

/**
 * Normalises a BGS state name for comparison (issue #6, R4): Spansh humanises state names
 * inconsistently across sources (`"CivilWar"` vs `"Civil War"`), so raw strings are never
 * compared directly.
 */
function normalizeStateName(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

/**
 * A `pending_states` entry may be a bare state name, or (per issue #6, R10) an object
 * carrying an optional `trend` alongside it — observed values are `0`, and render must not
 * depend on it being present or non-zero, so it's read only to extract `state`.
 */
interface PendingStateEntry {
  state: string;
  trend?: number;
}

/** The state name out of a `pending_states` entry, whichever shape it came in as. */
function pendingEntryStateName(entry: string | PendingStateEntry): string {
  return typeof entry === 'string' ? entry : entry.state;
}

interface MinorFactionPresence {
  name: string;
  influence: number;
  /** Current state(s), e.g. "Boom", "War". Authoritative — see issue #6. */
  active_states?: string[];
  /** Upcoming state(s) not yet in effect, e.g. a war or election about to start. */
  pending_states?: (string | PendingStateEntry)[];
  /** State(s) that just ended and are in a post-state cooldown, e.g. a war that just concluded. */
  recovering_states?: string[];
  /**
   * Legacy single-state scalar (a passthrough of the game journal's FactionState). Lags a
   * tick or can report a conflict that's already resolved — read only for anomaly detection
   * against `active_states`, never to derive a user-visible conflict indicator (issue #6, R1).
   */
  state?: string;
}

interface BgsSystemRecord {
  name: string;
  controlling_minor_faction: string | null;
  minor_faction_presences?: MinorFactionPresence[];
  x: number;
  y: number;
  z: number;
  /** When this system's data was last updated, e.g. "2026-08-06 19:52:24+00". Not strict ISO 8601 — see {@link parseUpdatedAt}. */
  updated_at?: string | null;
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
  /** True when the war's two parties are Canonn and CDSR themselves — renders the Canonn icon instead of the gun. */
  warIsCanonnVsCanonn: boolean;
  /** Whether Canonn or CDSR is (or is about to be) in an election here — drives the ballot-box icon. */
  electionState: FactionStateStatus;
  /** Tooltip text for the election icon, or null if electionState is null. */
  electionDetails: string | null;
  /** True when the election's two parties are Canonn and CDSR themselves — renders the Canonn icon instead of the ballot box. */
  electionIsCanonnVsCanonn: boolean;
  /** Galactic coordinates (light-years), used to compute the Distance column. */
  x: number;
  y: number;
  z: number;
  /** Raw `updated_at` from the API, as-is; the Freshness column derives its pill from this. */
  updatedAt: string | null;
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
 * Logs a structured anomaly record (issue #6, R8) for a faction whose legacy `state` or
 * `active_states`/`pending_states` disagree with what the modern arrays can actually
 * corroborate. This is a general "is Spansh's legacy field still drifting from the modern
 * one" signal, independent of which faction it's about — it runs for every faction in the
 * system (see {@link summarizeFactionState}), not just Canonn/CDSR, since the point is to
 * catch upstream data-quality regressions generally, not only where we happen to render.
 * `recovering_states` is included here (never in the render) so a resolved conflict's
 * evidence isn't lost. `severity: 'info'` is used for R9's unpaired-pending case, which the
 * issue calls out as lower-severity than an outright R2/R3 rejection — dev-only either way,
 * this never reaches render. `snapshot_time` stands in for the issue's `timestamps.factions`
 * (this API's per-record `updated_at` is the closest coherent equivalent we get); there's no
 * `id64` in this API's system records at all, so it's omitted rather than fabricated.
 */
function logConflictStateAnomaly(
  systemName: string,
  snapshotTime: string | null,
  presence: MinorFactionPresence,
  reason: string,
  severity: 'warning' | 'info' = 'warning',
): void {
  const record = {
    system: systemName,
    snapshot_time: snapshotTime,
    faction: presence.name,
    state: presence.state,
    active_states: presence.active_states ?? [],
    pending_states: (presence.pending_states ?? []).map(pendingEntryStateName),
    recovering_states: presence.recovering_states ?? [],
    reason,
  };
  if (severity === 'info') {
    logger.log('BGS conflict-state anomaly', record);
  } else {
    logger.warn('BGS conflict-state anomaly', record);
  }
}

/** Every faction in the system whose own `active_states` includes `normalized`. */
function activeCorroborators(presences: readonly MinorFactionPresence[], normalized: string): MinorFactionPresence[] {
  return presences.filter(p => (p.active_states ?? []).some(s => normalizeStateName(s) === normalized));
}

/** Every faction in the system whose own `pending_states` includes `normalized`. */
function pendingCorroborators(presences: readonly MinorFactionPresence[], normalized: string): MinorFactionPresence[] {
  return presences.filter(p =>
    (p.pending_states ?? []).some(entry => normalizeStateName(pendingEntryStateName(entry)) === normalized),
  );
}

/** True when `corroborators` is exactly Canonn and CDSR — the "vs each other" case. */
function isCanonnOnlyPair(corroborators: readonly MinorFactionPresence[]): boolean {
  return corroborators.length === 2 && corroborators.every(c => CANONN_FACTION_NAMES.has(c.name));
}

/**
 * "Canonn vs Varati Ring" — every faction sharing the conflict state, Canonn/CDSR first,
 * so the tooltip names who's actually fighting rather than just which of our own factions
 * is involved. A lone corroborator (an unpaired pending state) renders as just its own name.
 */
function describeConflict(corroborators: readonly MinorFactionPresence[]): string {
  return [...corroborators]
    .sort((a, b) => {
      const aIsCanonn = CANONN_FACTION_NAMES.has(a.name) ? 0 : 1;
      const bIsCanonn = CANONN_FACTION_NAMES.has(b.name) ? 0 : 1;
      return aIsCanonn - bIsCanonn || a.name.localeCompare(b.name);
    })
    .map(c => c.name)
    .join(' vs ');
}

/**
 * Checks Canonn's and CDSR's presences for a matching conflict state (war or election),
 * active or pending (about to start next tick), and along the way runs the R8 anomaly
 * diagnostics for every faction in the system. Implements issue #6's rules:
 *  - R1/R2: only `active_states`/`pending_states` drive the render. The legacy `state`
 *    scalar is read only to detect anomalies (R8) — it never decides active/pending status
 *    on its own.
 *  - R3: an active conflict needs at least one other faction in the same system
 *    corroborating the same (normalised) state in its own `active_states` — a lone
 *    combatant is impossible and is suppressed (and logged as an anomaly).
 *  - R4: state names are compared after normalising (lowercase, non-alphanumerics stripped).
 *  - R9: `recovering_states` never renders — active wins if a system somehow has both an
 *    active and a pending entry for the same conflict. Pending entries aren't subject to
 *    R3's two-party requirement, but an unpaired one still gets a lower-severity anomaly.
 *  - R10: a `pending_states` entry may be a bare string or `{state, trend}` — `trend` is
 *    never read.
 * Details are one line per distinct conflict, e.g. `"War: Canonn vs Varati Ring"` — naming
 * who's actually fighting rather than just which of our own factions is involved — for the
 * icon's tooltip.
 *
 * Also reports `isCanonnVsCanonn`: true when the only two factions sharing the state are
 * Canonn and CDSR themselves. We only care about conflicts Canonn/CDSR are a party to (see
 * the render loop's `CANONN_FACTION_NAMES` filter below); when the *other* party also turns
 * out to be Canonn/CDSR, that's a distinct case worth flagging on its own icon rather than
 * showing as an ordinary war/election against a third-party faction.
 */
function summarizeFactionState(
  systemName: string,
  snapshotTime: string | null,
  presences: readonly MinorFactionPresence[],
  conflictStates: ReadonlySet<string>,
): { status: FactionStateStatus; details: string | null; isCanonnVsCanonn: boolean } {
  // R8 diagnostics: every faction, not just Canonn/CDSR.
  for (const presence of presences) {
    const rawActiveStates = presence.active_states ?? [];
    for (const rawState of rawActiveStates) {
      const normalized = normalizeStateName(rawState);
      if (!conflictStates.has(normalized)) {
        continue;
      }
      if (activeCorroborators(presences, normalized).length < 2) {
        logConflictStateAnomaly(systemName, snapshotTime, presence, `R3: no second faction corroborates active "${rawState}"`);
      }
    }

    for (const entry of presence.pending_states ?? []) {
      const stateName = pendingEntryStateName(entry);
      const normalized = normalizeStateName(stateName);
      if (!conflictStates.has(normalized)) {
        continue;
      }
      if (pendingCorroborators(presences, normalized).length < 2) {
        logConflictStateAnomaly(systemName, snapshotTime, presence, `R9: unpaired pending "${stateName}"`, 'info');
      }
    }

    // R1/R2 anomaly: the legacy `state` scalar names a conflict not corroborated by
    // active_states. `recovering_states` doesn't get this same treatment since it's not a
    // legacy field disagreeing with a modern one — R9 just never renders it (but is still
    // included in the anomaly record above, as evidence).
    if (presence.state && conflictStates.has(normalizeStateName(presence.state))) {
      const corroborated = rawActiveStates.some(s => normalizeStateName(s) === normalizeStateName(presence.state!));
      if (!corroborated) {
        logConflictStateAnomaly(systemName, snapshotTime, presence, `R2: legacy state "${presence.state}" absent from active_states`);
      }
    }
  }

  // Render: Canonn/CDSR only — a war or election we're not a party to isn't shown. Details
  // are keyed by (state, corroborator set) and deduped, since Canonn and CDSR being on the
  // same side of the same conflict would otherwise produce the same "X vs Y" line twice.
  const active: string[] = [];
  const pending: string[] = [];
  const seenActive = new Set<string>();
  const seenPending = new Set<string>();
  let activeIsCanonnVsCanonn = false;
  let pendingIsCanonnVsCanonn = false;

  for (const presence of presences) {
    if (!CANONN_FACTION_NAMES.has(presence.name)) {
      continue;
    }

    for (const rawState of presence.active_states ?? []) {
      const normalized = normalizeStateName(rawState);
      if (!conflictStates.has(normalized)) {
        continue;
      }
      const corroborators = activeCorroborators(presences, normalized);
      if (corroborators.length < 2) {
        continue;
      }
      const key = `${normalized}|${corroborators.map(c => c.name).sort().join(',')}`;
      if (!seenActive.has(key)) {
        seenActive.add(key);
        active.push(`${rawState}: ${describeConflict(corroborators)}`);
      }
      if (isCanonnOnlyPair(corroborators)) {
        activeIsCanonnVsCanonn = true;
      }
    }

    for (const entry of presence.pending_states ?? []) {
      const stateName = pendingEntryStateName(entry);
      const normalized = normalizeStateName(stateName);
      if (!conflictStates.has(normalized)) {
        continue;
      }
      const corroborators = pendingCorroborators(presences, normalized);
      const key = `${normalized}|${corroborators.map(c => c.name).sort().join(',')}`;
      if (!seenPending.has(key)) {
        seenPending.add(key);
        pending.push(`${stateName}: ${describeConflict(corroborators)} (pending)`);
      }
      if (isCanonnOnlyPair(corroborators)) {
        pendingIsCanonnVsCanonn = true;
      }
    }
  }

  if (active.length > 0) {
    return { status: 'active', details: active.join('\n'), isCanonnVsCanonn: activeIsCanonnVsCanonn };
  }
  if (pending.length > 0) {
    return { status: 'pending', details: pending.join('\n'), isCanonnVsCanonn: pendingIsCanonnVsCanonn };
  }
  return { status: null, details: null, isCanonnVsCanonn: false };
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
  /** The API's actual per-page record count, learned from page 0's response — see {@link resolvePageSize}. */
  private discoveredPageSize: number | null = null;
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
    const pageSize = this.resolvePageSize(page, response.results.length);
    return {
      page,
      rows: response.results.map(record => this.toRow(record, architects)),
      totalCount: response.count,
      totalPages: Math.max(1, Math.ceil(response.count / pageSize)),
    };
  }

  /**
   * The API's per-page record count isn't a fixed contract (issue #7: it changed from 50 to
   * 500 without notice, and {@link BGS_PAGE_SIZE} being hardcoded against the old value made
   * every page past the new, much-shorter last page 404). Page 0 is guaranteed full unless the
   * whole dataset fits on one page — in which case the size doesn't matter, since `totalPages`
   * comes out to 1 either way — so it's the one response trusted to reveal the true page size,
   * and that's reused for every later page. A later page's own `results.length` is deliberately
   * *not* used for this, since a later page fetched on its own (e.g. a prefetch) may be the
   * short last page and would otherwise be mistaken for the true page size.
   */
  private resolvePageSize(page: number, resultsLength: number): number {
    if (page === 0 && resultsLength > 0) {
      this.discoveredPageSize = resultsLength;
    }
    return this.discoveredPageSize ?? (resultsLength > 0 ? resultsLength : BGS_PAGE_SIZE);
  }

  private toRow(record: BgsSystemRecord, architects: ReadonlyMap<string, ArchitectInfo>): BgsRow {
    const presences = record.minor_faction_presences ?? [];
    const info = architects.get(record.name);
    const canonnInfluence = this.influencePercent(presences, CANONN_FACTION);
    const cdsrInfluence = this.influencePercent(presences, CDSR_FACTION);
    const snapshotTime = record.updated_at ?? null;
    const war = summarizeFactionState(record.name, snapshotTime, presences, WAR_STATES);
    const election = summarizeFactionState(record.name, snapshotTime, presences, ELECTION_STATES);
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
      warIsCanonnVsCanonn: war.isCanonnVsCanonn,
      electionState: election.status,
      electionDetails: election.details,
      electionIsCanonnVsCanonn: election.isCanonnVsCanonn,
      x: record.x,
      y: record.y,
      z: record.z,
      updatedAt: record.updated_at ?? null,
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
