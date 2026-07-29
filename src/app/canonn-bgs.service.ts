import { Injectable } from '@angular/core';
import { BUILD_ID } from './build-info';

/** Base URL for the Canonn cloud-function query API. */
const QUERY_BASE = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query';
const BGS_ENDPOINT = `${QUERY_BASE}/canonnbgs`;
const ARCHITECTS_ENDPOINT = `${QUERY_BASE}/canonnbgs/architects`;
const TYPEAHEAD_ENDPOINT = `${QUERY_BASE}/typeahead`;

/** Default per-request timeout for remote API calls (ms). */
const HTTP_TIMEOUT_MS = 20000;
/** Number of automatic retries for transient failures. */
const HTTP_RETRY_COUNT = 2;

/** Records per BGS page, per the API contract. */
export const BGS_PAGE_SIZE = 50;

/** localStorage key the architects lookup is persisted under. */
const ARCHITECTS_CACHE_KEY = 'canonn-bgs:architects-cache:v1';
/** How long the architects lookup is cached before it's refetched. */
const ARCHITECTS_CACHE_DURATION_MS = 2 * 60 * 60 * 1000;

export const CANONN_FACTION = 'Canonn';
export const CDSR_FACTION = 'Canonn Deep Space Research';

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
}

interface BgsSystemRecord {
  name: string;
  controlling_minor_faction: string | null;
  minor_faction_presences?: MinorFactionPresence[];
  is_colonised: boolean;
  is_being_colonised: boolean;
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

/** One row of the rendered table. */
export interface BgsRow {
  systemName: string;
  controllingFaction: string | null;
  /** Canonn faction influence, as a 0-100 percentage; null if Canonn has no presence in the system. */
  canonnInfluence: number | null;
  /** Canonn Deep Space Research faction influence, as a 0-100 percentage; null if absent. */
  cdsrInfluence: number | null;
  architect: string | null;
  preferredFaction: string | null;
  /** Every minor faction present in the system, sorted by influence descending (highest first). */
  factions: FactionInfluence[];
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

interface ArchitectInfo {
  architect: string;
  preferredFaction: string;
}

interface ArchitectsCachePayload {
  fetchedAt: number;
  /** The build that wrote this cache; a mismatch (a new build was deployed) invalidates it. */
  buildId: string;
  entries: [string, ArchitectInfo][];
}

/**
 * Fetches the Canonn BGS dataset: a paged table of systems with their controlling
 * faction, Canonn/CDSR influence, and (via a separate lookup) architect details.
 *
 * Caching:
 * - The search token is fetched once per session and reused for every page.
 * - Each fetched page is memoised in memory so revisiting it (Previous/Next) is free.
 * - The architects lookup is fetched once (across all its pages) and persisted in
 *   localStorage for {@link ARCHITECTS_CACHE_DURATION_MS}, since it changes far less
 *   often than BGS influence.
 */
@Injectable({ providedIn: 'root' })
export class CanonnBgsService {
  private tokenPromise?: Promise<string>;
  private readonly pagePromises = new Map<number, Promise<BgsPage>>();
  private architectsPromise?: Promise<Map<string, ArchitectInfo>>;

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
    const [token, architects] = await Promise.all([this.getToken(), this.getArchitects()]);
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
    // The architects list only covers systems founded via the colonisation initiative;
    // a system that was never (or isn't yet being) colonised can't have one.
    const isColony = record.is_colonised || record.is_being_colonised;
    return {
      systemName: record.name,
      controllingFaction: record.controlling_minor_faction ?? null,
      canonnInfluence,
      cdsrInfluence,
      architect: isColony ? (info?.architect || null) : 'Not a colony',
      preferredFaction: isColony
        ? (info?.preferredFaction || null)
        : this.dominantCanonnFaction(canonnInfluence, cdsrInfluence),
      factions: [...presences]
        .sort((a, b) => b.influence - a.influence)
        .map(p => ({ name: p.name, influencePercent: p.influence * 100 })),
      x: record.x,
      y: record.y,
      z: record.z,
    };
  }

  private influencePercent(presences: readonly MinorFactionPresence[], factionName: string): number | null {
    const presence = presences.find(p => p.name === factionName);
    return presence ? presence.influence * 100 : null;
  }

  /** For non-colony systems: whichever of Canonn/CDSR has more influence here, or null if neither is present. */
  private dominantCanonnFaction(canonnInfluence: number | null, cdsrInfluence: number | null): string | null {
    if (canonnInfluence === null && cdsrInfluence === null) {
      return null;
    }
    if (cdsrInfluence === null || (canonnInfluence !== null && canonnInfluence >= cdsrInfluence)) {
      return CANONN_FACTION;
    }
    return CDSR_FACTION;
  }

  private getToken(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.resilientGet<string>(BGS_ENDPOINT);
    }
    return this.tokenPromise;
  }

  /** Loads the architect/preferred-faction lookup at most once per session (see class doc). */
  private getArchitects(): Promise<Map<string, ArchitectInfo>> {
    if (!this.architectsPromise) {
      this.architectsPromise = this.loadArchitects().catch(error => {
        // Clear the memo so a later page fetch can retry instead of failing forever.
        this.architectsPromise = undefined;
        throw error;
      });
    }
    return this.architectsPromise;
  }

  private async loadArchitects(): Promise<Map<string, ArchitectInfo>> {
    const cached = this.readArchitectsCache();
    if (cached) {
      return cached;
    }

    const map = new Map<string, ArchitectInfo>();
    for (let page = 0; ; page++) {
      const records = await this.resilientGet<ArchitectRecord[]>(`${ARCHITECTS_ENDPOINT}/${page}`);
      if (records.length === 0) {
        break;
      }
      for (const record of records) {
        map.set(record['System Name'], {
          architect: record['Architect Name'],
          preferredFaction: record['Preferred Faction'],
        });
      }
    }

    this.writeArchitectsCache(map);
    return map;
  }

  private readArchitectsCache(): Map<string, ArchitectInfo> | null {
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
      return new Map(payload.entries);
    } catch {
      return null;
    }
  }

  private writeArchitectsCache(map: ReadonlyMap<string, ArchitectInfo>): void {
    try {
      const payload: ArchitectsCachePayload = { fetchedAt: Date.now(), buildId: BUILD_ID, entries: [...map.entries()] };
      localStorage.setItem(ARCHITECTS_CACHE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full/unavailable (e.g. private browsing) — the in-memory map still serves this session.
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new HttpError(response.status, response.statusText || `HTTP ${response.status}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
