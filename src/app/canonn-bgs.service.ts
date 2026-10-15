import { Injectable, signal } from '@angular/core';
import {
  AFFILIATION_NOT_A_COLONY,
  ARCHITECT_FORM_ACTION,
  ArchitectSubmission,
  buildArchitectFormBody,
} from './data/architect-form';
import { ArchitectInfo, ArchitectRegistryRow } from './data/architect-registry';
import { isHomeSystem } from './data/home-systems';
import { ApiTrend, InfluenceChange, influenceChangeFrom } from './data/influence-change';
import { HistoryRow } from './data/influence-history';
import { logger } from './data/logger';
import {
  BgsConfig,
  PriorityAssessment,
  PriorityConflict,
  PriorityInputs,
  PriorityStates,
  PriorityTrend,
  cleanCell,
  computePriority,
} from './data/priority';
import { PriorityWatchlistEntry } from './data/priority-watchlist';

/** Base URL for the Canonn cloud-function query API. */
const QUERY_BASE = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query';
/**
 * The BGS tracker's read API. Asked for `view=all`, it sends every system's summary in one
 * gzipped response, together with the `config` the priority score needs. (Not `slim=1`: that
 * leaves out the `sparkline` the influence columns draw, for a saving of a few percent.)
 */
const BGS_SYSTEMS_URL = `${QUERY_BASE}/bgs/systems?view=all`;
const TYPEAHEAD_ENDPOINT = `${QUERY_BASE}/typeahead`;

/** Default per-request timeout for remote API calls (ms). */
const HTTP_TIMEOUT_MS = 20000;
/** Number of automatic retries for transient failures. */
const HTTP_RETRY_COUNT = 2;
/** Timeout for a form submission (ms). Not retried — see {@link CanonnBgsService.submitAssignment}. */
const FORM_SUBMIT_TIMEOUT_MS = 15000;

/** Timeout for the whole-list fetch (ms) — one response carrying every system, so well over a page's worth. */
const SYSTEMS_TIMEOUT_MS = 60000;
/** How long a loaded list is served before the next request for it fetches a fresh one (ms). */
export const SYSTEMS_MAX_AGE_MS = 10 * 60 * 1000;

/** localStorage key a just-submitted assignment is remembered under until the API's list shows it. */
const RECENT_ASSIGNMENTS_KEY = 'canonn-bgs:recent-assignments:v1';
/** How long a submission is remembered at most — the tracker normally picks a sheet row up well within this. */
const RECENT_ASSIGNMENT_TTL_MS = 2 * 60 * 60 * 1000;

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
 * Retreat is a single-faction state — a faction retreats on its own, with no opposing party
 * — unlike war/election. See {@link StateSetConfig.requiresCorroboration}.
 */
const RETREAT_STATES: ReadonlySet<string> = new Set(['retreat']);
/**
 * Also single-faction, like retreat. Not rendered as a State-column icon (deferred per the
 * feature spec) — only read internally, to score the priority table's "expansion unwanted"
 * trigger.
 */
const EXPANSION_STATES: ReadonlySet<string> = new Set(['expansion']);

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

/**
 * A state as the API sends it: `{State: "War"}` for an active/recovering one, `{State, Trend}`
 * for a pending one. A bare string is also accepted. Read only through {@link stateEntryName}.
 */
type ApiStateEntry = string | { State?: string | null; state?: string | null; Trend?: number; trend?: number };

/** The state name out of an API state entry, whichever shape it came in as; null if it has none. */
function stateEntryName(entry: ApiStateEntry | null | undefined): string | null {
  if (typeof entry === 'string') {
    return entry || null;
  }
  return entry?.State ?? entry?.state ?? null;
}

/** The non-empty state names in an API state list. */
function stateNames(entries: readonly ApiStateEntry[] | null | undefined): string[] {
  return (entries ?? []).map(stateEntryName).filter((name): name is string => name !== null);
}

/** One faction in a system, as the API's `minor_faction_presences` array describes it. */
interface ApiFactionPresence {
  name: string;
  allegiance?: string | null;
  government?: string | null;
  /** 0-1 fraction. */
  influence: number;
  state?: string | null;
  active_states?: ApiStateEntry[] | null;
  pending_states?: ApiStateEntry[] | null;
  recovering_states?: ApiStateEntry[] | null;
}

/** The latest architect submission for a system, as recorded by the tracker. */
interface ApiArchitect {
  architect_name?: string | null;
  canonn_architect?: string | null;
  preferred_faction?: string | null;
}

/** A Priority Watchlist entry as the tracker holds it (`bgs_overrides`). */
interface ApiOverride {
  faction?: string | null;
  position?: number | null;
  details?: string | null;
}

interface MinorFactionPresence {
  name: string;
  allegiance?: string;
  government?: string;
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

/** One system's summary from `/bgs/systems`; only the fields this app reads are listed. */
interface BgsSystemRecord {
  name: string;
  /** The system's id64, as a string — it is bigger than JavaScript can hold exactly as a number. */
  system_address?: string | null;
  controlling_faction: string | null;
  /** Every faction in the newest snapshot, highest influence first. Empty for a system the tracker has no snapshot of. */
  minor_faction_presences?: ApiFactionPresence[] | null;
  x: number;
  y: number;
  z: number;
  /** When the tracker last saw this system, as ISO 8601 with a `Z`. */
  last_seen?: string | null;
  architect?: ApiArchitect | null;
  bgs_override?: ApiOverride | null;
  /** Each tracked faction's influence history — an input to the priority score. */
  trend?: Record<string, PriorityTrend & ApiTrend> | null;
  /** Each tracked faction's influence over the last weeks as 0-1 fractions, oldest first. */
  sparkline?: Record<string, number[]> | null;
  /** Each tracked faction's average influence before the latest day, as a 0-1 fraction; null where it has none. */
  avg_influence?: Record<string, number | null> | null;
  /** The tracked factions' active and pending states — an input to the priority score. */
  states?: PriorityStates[] | null;
  /** The system's open conflicts — an input to the priority score. */
  conflicts?: PriorityConflict[] | null;
  /** Hours since the system was last seen, as of the response's `generated_at`; null if never. */
  data_age_hours?: number | null;
  /** Number of astronomical bodies scanned in the system. */
  body_count?: number | null;
  population?: number | null;
  /** Total stations in the system (all of them, not just Canonn's). Higher wins a priority tie. */
  station_count?: number | null;
  /** Every station in the system; those with "canonn" in their name make the system Canonn-led. */
  canonn_assets?: CanonnAsset[] | null;
  /** Powers pledged to this system (empty or absent if none). */
  power?: string[] | null;
  /** The system's powerplay state, e.g. "Exploited", "Fortified", "Stronghold", "Unoccupied". */
  power_state?: string | null;
  /** The power holding control here, if any. */
  controlling_power?: string | null;
  /** Control progress towards the controlling power, as a 0-1 fraction. */
  power_state_control_progress?: number | null;
  /** Reinforcement points the controlling power has put into the system. */
  power_state_reinforcement?: number | null;
  /** Undermining points rival powers have put into the system. */
  power_state_undermining?: number | null;
  /** Progress of each power contesting the system, as a 0-1 fraction. */
  power_conflict_progress?: { power: string; progress: number }[] | null;
}

/** The system's powerplay state, for the system info dialog. Null on a row means no power is recorded here. */
export interface PowerplayDetail {
  /** Every power pledged to the system, in the API's order. */
  powers: string[];
  /** The power holding control, or null if none does. */
  controllingPower: string | null;
  /** e.g. "Exploited", "Fortified", "Stronghold", "Unoccupied"; null if the API omits it. */
  state: string | null;
  /** Control progress as a percentage, 0-100; null if the API omits it. */
  controlProgressPercent: number | null;
  reinforcement: number | null;
  undermining: number | null;
  /** Contesting powers and their progress as a percentage, highest first. */
  conflictProgress: { power: string; progressPercent: number }[];
}

/** A station or installation in a system, as the API's `canonn_assets` array describes it. */
export interface CanonnAsset {
  name: string;
  type: string;
  controlling_minor_faction: string | null;
}

/** `/bgs/systems?view=all`: every system, and the constants the client needs to score and sort them. */
interface BgsAllResponse {
  data: BgsSystemRecord[];
  total: number;
  /** When the server built this, UTC with no `Z`. */
  generated_at?: string;
  config?: BgsConfig;
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

/** A station in a system, as the system info dialog lists it. */
export interface StationDetail {
  name: string;
  type: string | null;
  controllingFaction: string | null;
}

/** A minor faction present in a system, with the detail the system dialog's faction table shows. */
export interface FactionDetail {
  name: string;
  allegiance: string | null;
  government: string | null;
  /** 0-100 percentage. */
  influencePercent: number;
  /** The faction's current state(s), e.g. "Boom", "War" — empty if none. */
  activeStates: string[];
}

/** Whether a war/election affecting Canonn or CDSR is already happening or just upcoming. */
export type FactionStateStatus = 'active' | 'pending' | null;

/** One row of the rendered table. */
export interface BgsRow {
  systemName: string;
  /** The system's id64 as a string (never a number: it exceeds JavaScript's safe integers); '' if the API sent none. */
  systemAddress: string;
  controllingFaction: string | null;
  /** Canonn faction influence, as a 0-100 percentage; null if Canonn has no presence in the system. */
  canonnInfluence: number | null;
  /** Canonn Deep Space Research faction influence, as a 0-100 percentage; null if absent. */
  cdsrInfluence: number | null;
  architect: string | null;
  /** Recorded as "Nobody — the system is not a colony": shown blank rather than offering Assign again. */
  notAColony: boolean;
  /**
   * The faction this system should be worked for: the Architect Registry's Preferred Faction
   * if one is recorded; otherwise, when the system has a station with "canonn" in its name,
   * whichever of Canonn/CDSR has more influence here (see {@link derivePreferredFaction}).
   */
  preferredFaction: string | null;
  /** False when {@link preferredFaction} was derived from a Canonn-named station rather than recorded in the registry — shown grey. */
  preferredFactionRecorded: boolean;
  /** Whether any station in the system has "canonn" in its name (matching "Canonnia" or "Arcanonn" too). */
  hasCanonnStation: boolean;
  /** Stations in the system, all of them — the Priority column's tiebreak after the priority itself. Null if the API omits it. */
  stationCount: number | null;
  /** Every minor faction present in the system, sorted by influence descending (highest first). */
  factions: FactionInfluence[];
  /** Canonn's influence over the last weeks as percentages, oldest first; empty if the tracker has no history of it. */
  canonnHistory: number[];
  /** Canonn Deep Space Research's influence over the last weeks as percentages, oldest first. */
  cdsrHistory: number[];
  /** Each tracked faction's long-run average influence as a 0-1 fraction (null where unknown) — the history chart's dashed lines. */
  influenceAverages: Record<string, number | null>;
  /** How Canonn's influence has moved lately (the arrow and points beside its percentage); null with too little history. */
  canonnChange: InfluenceChange | null;
  /** How Canonn Deep Space Research's influence has moved lately; null with too little history. */
  cdsrChange: InfluenceChange | null;
  /** The same factions with allegiance, government and active states, for the system info dialog. */
  factionDetails: FactionDetail[];
  /** The system's stations (the API's canonn_assets), for the system info dialog. */
  stations: StationDetail[];
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
  /**
   * Whether Canonn or CDSR is (or is about to be) retreating here — drives the State
   * column's warning icon. Never set for a faction in its own home system (FR-2). Unlike
   * war/election, retreat is single-faction, so there's no "vs" equivalent.
   */
  retreatState: FactionStateStatus;
  /** Tooltip text for the retreat icon (faction and influence, one line per faction), or null if retreatState is null. */
  retreatDetails: string | null;
  /**
   * Whether Canonn or CDSR is (or is about to be) expanding here. Internal-only input for
   * the priority score's "expansion unwanted" trigger — not rendered as a State column icon.
   */
  expansionState: FactionStateStatus;
  /** Number of astronomical bodies scanned in the system — shown in the System Name tooltip. Null if the API omits it. */
  bodyCount: number | null;
  /** The system's population — shown in the System Name tooltip and used as the Priority column's secondary sort (a bigger system matters more when priority ties). */
  population: number | null;
  /** Galactic coordinates (light-years), used to compute the Distance column. */
  x: number;
  y: number;
  z: number;
  /** The API's `last_seen` for the system (ISO 8601); the Freshness column derives its pill from this. */
  updatedAt: string | null;
  /** Priority Watchlist entries naming this system, if any — see {@link PriorityWatchlistEntry}. */
  watchlist: PriorityWatchlistEntry[];
  /**
   * The system's work-priority score, as of when the list was loaded. Its staleness flags go out
   * of date as the clock ticks — read it through `currentPriority` for those.
   */
  priority: PriorityAssessment;
  /**
   * What {@link priority} was computed from, so it can be worked out again when something it
   * reads changes (an architect assigned). Absent on a row that wasn't built from the API.
   */
  priorityContext?: { inputs: PriorityInputs; config: BgsConfig };
  /** The system's powerplay state, or null if no power is pledged here — shown in the system info dialog. */
  powerplay: PowerplayDetail | null;
}

/** Every system, as loaded: the rows, when the server built them, and the constants it scored them with. */
export interface BgsSnapshot {
  rows: BgsRow[];
  /** The server's timestamp for this list (UTC, no `Z`). */
  generatedAt: string | null;
  config: BgsConfig;
}

/** What of an assignment the table needs: the system and the three answers that describe it. */
export type AssignmentAnswers = Pick<ArchitectSubmission, 'systemName' | 'architect' | 'affiliation' | 'preferredFaction'>;

/** An assignment kept in localStorage until the API's own list shows it. */
interface RecentAssignment extends AssignmentAnswers {
  /** When it was submitted (epoch ms). */
  at: number;
}

/**
 * A copy of `row` showing the architect details of a just-submitted assignment, so the table
 * reflects the submission immediately instead of waiting for the tracker to pick the sheet row up.
 */
export function rowWithAssignment(row: BgsRow, submission: AssignmentAnswers): BgsRow {
  const recorded = submission.preferredFaction || null;
  const assigned: BgsRow = {
    ...row,
    architect: submission.architect || null,
    notAColony: submission.affiliation === AFFILIATION_NOT_A_COLONY,
    preferredFaction: recorded ?? derivePreferredFaction(row),
    preferredFactionRecorded: recorded !== null,
  };
  const context = row.priorityContext;
  if (!context) {
    return assigned;
  }
  // The preferred faction decides how the system is scored, so the new answer re-scores it.
  const inputs: PriorityInputs = {
    ...context.inputs,
    architect: {
      architect_name: submission.architect || null,
      canonn_architect: submission.affiliation || null,
      preferred_faction: submission.preferredFaction || null,
    },
  };
  return { ...assigned, priority: computePriority(inputs, context.config), priorityContext: { ...context, inputs } };
}

/**
 * The preferred faction for a system with no Architect Registry preference: a Canonn-named
 * station makes it Canonn-led, and the lead is whichever of Canonn / Canonn Deep Space Research
 * has more influence here (Canonn on a tie, or when neither is present). Null when no station
 * is Canonn-named — the system has no preference at all.
 */
export function derivePreferredFaction(
  row: Pick<BgsRow, 'hasCanonnStation' | 'canonnInfluence' | 'cdsrInfluence'>,
): string | null {
  if (!row.hasCanonnStation) {
    return null;
  }
  const cdsr = row.cdsrInfluence ?? -1;
  const canonn = row.canonnInfluence ?? -1;
  return cdsr > canonn ? CDSR_FACTION : CANONN_FACTION;
}

/** Whether a station's name marks it as Canonn's — "canonn" anywhere in the name, any case. */
export function isCanonnAsset(asset: CanonnAsset): boolean {
  return /canonn/i.test(asset.name);
}

/** The powerplay state from an API record, or null if no power is pledged to the system. */
function toPowerplay(record: BgsSystemRecord): PowerplayDetail | null {
  const powers = record.power ?? [];
  if (powers.length === 0 && !record.controlling_power) {
    return null;
  }
  return {
    powers,
    controllingPower: record.controlling_power ?? null,
    state: record.power_state ?? null,
    controlProgressPercent: record.power_state_control_progress == null ? null : record.power_state_control_progress * 100,
    reinforcement: record.power_state_reinforcement ?? null,
    undermining: record.power_state_undermining ?? null,
    conflictProgress: (record.power_conflict_progress ?? [])
      .map(entry => ({ power: entry.power, progressPercent: entry.progress * 100 }))
      .sort((a, b) => b.progressPercent - a.progressPercent),
  };
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
 * (this API's per-record `last_seen` is the closest coherent equivalent we get); there's no
 * `id64` in this API's system records at all (`system_address` is a string there), so it's omitted rather than fabricated.
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
 * "Canonn Deep Space Research (2.1%)" — a single-faction state (retreat, expansion) has no
 * opposing party to name, so its detail line names the faction and its current influence
 * instead of the war/election "X vs Y" format {@link describeConflict} produces.
 */
function describeSingleFaction(corroborators: readonly MinorFactionPresence[]): string {
  return corroborators.map(c => `${c.name} (${(c.influence * 100).toFixed(1)}%)`).join(', ');
}

/**
 * A state or set of related state names (e.g. war + civil war) to summarise, and how it
 * behaves: war/election are two-party conflicts (R3/R9's corroboration requirement below
 * applies); retreat/expansion are single-faction states a faction enters on its own, so
 * that requirement — and the R3/R9 anomaly diagnostics it drives — must not apply to them.
 */
interface StateSetConfig {
  states: ReadonlySet<string>;
  /** War/election: true. Retreat/expansion: false — see the interface doc above. */
  requiresCorroboration: boolean;
  /** Detail-line formatter; defaults to {@link describeConflict}'s "X vs Y". */
  describeMatch?: (corroborators: readonly MinorFactionPresence[]) => string;
  /** When given, a match is suppressed entirely for a faction this returns true for (FR-2: a faction can't retreat from its own home system). */
  isSuppressed?: (factionName: string, systemName: string) => boolean;
}

/**
 * Checks Canonn's and CDSR's presences for a matching state (war, election, retreat, or
 * expansion — see {@link StateSetConfig}), active or pending (about to start next tick), and
 * along the way runs the R8 anomaly diagnostics for every faction in the system. Implements
 * issue #6's rules:
 *  - R1/R2: only `active_states`/`pending_states` drive the render. The legacy `state`
 *    scalar is read only to detect anomalies (R8) — it never decides active/pending status
 *    on its own.
 *  - R3: for a two-party state, an active instance needs at least one other faction in the
 *    same system corroborating the same (normalised) state in its own `active_states` — a
 *    lone combatant is impossible and is suppressed (and logged as an anomaly). Doesn't
 *    apply to a single-faction state (`requiresCorroboration: false`) — a lone retreat is
 *    the expected case, not an anomaly.
 *  - R4: state names are compared after normalising (lowercase, non-alphanumerics stripped).
 *  - R9: `recovering_states` never renders — active wins if a system somehow has both an
 *    active and a pending entry for the same state. A two-party state's pending entry isn't
 *    subject to R3's requirement either, but an unpaired one still gets a lower-severity
 *    anomaly; single-faction states skip this diagnostic too, for the same reason as R3.
 *  - R10: a `pending_states` entry may be a bare string or `{state, trend}` — `trend` is
 *    never read.
 * Details are one line per distinct match, e.g. `"War: Canonn vs Varati Ring"` for a
 * two-party state, or `"Retreat: Canonn Deep Space Research (2.1%)"` for a single-faction
 * one — naming who's actually involved rather than just which of our own factions is,
 * for the icon's tooltip.
 *
 * Also reports `isCanonnVsCanonn`: true when the only two factions sharing a two-party state
 * are Canonn and CDSR themselves. We only care about matches Canonn/CDSR are a party to (see
 * the render loop's `CANONN_FACTION_NAMES` filter below); when the *other* party also turns
 * out to be Canonn/CDSR, that's a distinct case worth flagging on its own icon rather than
 * showing as an ordinary war/election against a third-party faction. Always false for a
 * single-faction state, which has no "other party" at all.
 */
function summarizeFactionState(
  systemName: string,
  snapshotTime: string | null,
  presences: readonly MinorFactionPresence[],
  config: StateSetConfig,
): { status: FactionStateStatus; details: string | null; isCanonnVsCanonn: boolean } {
  const { states: conflictStates, requiresCorroboration, isSuppressed } = config;
  const describeMatch = config.describeMatch ?? describeConflict;

  // R8 diagnostics: every faction, not just Canonn/CDSR. R3/R9 only apply to two-party states.
  for (const presence of presences) {
    const rawActiveStates = presence.active_states ?? [];
    if (requiresCorroboration) {
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
    }

    // R1/R2 anomaly: the legacy `state` scalar names a match not corroborated by
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

  // Render: Canonn/CDSR only — a match we're not a party to isn't shown. Details are keyed
  // by (state, corroborator set) and deduped, since Canonn and CDSR being on the same side
  // of the same two-party state would otherwise produce the same "X vs Y" line twice.
  const active: string[] = [];
  const pending: string[] = [];
  const seenActive = new Set<string>();
  const seenPending = new Set<string>();
  let activeIsCanonnVsCanonn = false;
  let pendingIsCanonnVsCanonn = false;

  for (const presence of presences) {
    if (!CANONN_FACTION_NAMES.has(presence.name) || isSuppressed?.(presence.name, systemName)) {
      continue;
    }

    for (const rawState of presence.active_states ?? []) {
      const normalized = normalizeStateName(rawState);
      if (!conflictStates.has(normalized)) {
        continue;
      }
      const corroborators = activeCorroborators(presences, normalized);
      if (requiresCorroboration && corroborators.length < 2) {
        continue;
      }
      const key = `${normalized}|${corroborators.map(c => c.name).sort().join(',')}`;
      if (!seenActive.has(key)) {
        seenActive.add(key);
        active.push(`${rawState}: ${describeMatch(corroborators)}`);
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
        pending.push(`${stateName}: ${describeMatch(corroborators)} (pending)`);
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

/** A faction as {@link summarizeFactionState} reads it: the API's state entries flattened to plain state names. */
function toPresence(presence: ApiFactionPresence): MinorFactionPresence {
  return {
    name: presence.name,
    allegiance: presence.allegiance ?? undefined,
    government: presence.government ?? undefined,
    influence: presence.influence,
    state: presence.state ?? undefined,
    active_states: stateNames(presence.active_states),
    pending_states: stateNames(presence.pending_states),
    recovering_states: stateNames(presence.recovering_states),
  };
}

/** The registry-shaped architect details a system record carries, or undefined if it has none. */
function architectFromApi(architect: ApiArchitect | null | undefined): ArchitectInfo | undefined {
  if (!architect) {
    return undefined;
  }
  return {
    architect: architect.architect_name?.trim() ?? '',
    affiliation: architect.canonn_architect?.trim() ?? '',
    preferredFaction: architect.preferred_faction?.trim() ?? '',
  };
}

/** A tracked faction's influence history out of a summary's `sparkline`, as percentages (empty if it has none). */
function historyPercent(sparkline: Record<string, number[]> | null | undefined, faction: string): number[] {
  return (sparkline?.[faction] ?? []).map(value => value * 100);
}

/** An answer as a registry row. */
function toRegistryRow(answers: AssignmentAnswers): ArchitectRegistryRow {
  return {
    systemName: answers.systemName,
    architect: answers.architect,
    affiliation: answers.affiliation,
    preferredFaction: answers.preferredFaction,
  };
}

/** The watchlist entry a system record carries (the tracker's copy of the sheet), as a list for {@link BgsRow.watchlist}. */
function overrideEntries(record: BgsSystemRecord): PriorityWatchlistEntry[] {
  const override = record.bgs_override;
  if (!override?.faction || !override.position || override.position < 1) {
    return [];
  }
  return [{ systemName: record.name, faction: override.faction, position: override.position, details: override.details ?? '' }];
}

/**
 * Fetches the Canonn BGS dataset from the tracker's `/bgs/systems` API: every system with its
 * controlling faction, every faction's influence and states, stations, powerplay, architect and
 * watchlist entry, in one response — so there is a single network request behind the table.
 *
 * The list is loaded once; the table sorts, filters and pages it itself, and scores each system
 * with {@link computePriority} using the constants the response carries. It is never served once
 * it is {@link SYSTEMS_MAX_AGE_MS} old: the next {@link getSystems} after that fetches again.
 *
 * The Architect Registry the Assign dialog suggests from is built from the same response (one
 * row per system, the tracker's latest). An assignment submitted here is remembered locally for
 * {@link RECENT_ASSIGNMENT_TTL_MS}, so it shows straight away and survives a reload until the
 * API's own list has caught up with the sheet.
 */
@Injectable({ providedIn: 'root' })
export class CanonnBgsService {
  /** The list as last loaded (patched for local assignments); stays until a newer one replaces it. */
  private systemsPromise?: Promise<BgsSnapshot>;
  /** When {@link systemsPromise} was fetched (epoch ms). */
  private loadedAt = 0;
  /** A fetch that is under way, so overlapping callers share one request. */
  private inFlight?: Promise<BgsSnapshot>;
  private readonly loadLogLines = signal<readonly string[]>([]);
  /** What loading the list is really doing, in order — for a progress display while it waits. */
  readonly loadLog = this.loadLogLines.asReadonly();
  /** One registry row per system with an architect on record, plus assignments made here; built as the list loads. */
  private registryRows: ArchitectRegistryRow[] = [];

  /**
   * Every system: from memory if it was loaded less than {@link SYSTEMS_MAX_AGE_MS} ago,
   * otherwise fetched afresh. A failed fetch isn't remembered, so the next call tries again.
   */
  getSystems(): Promise<BgsSnapshot> {
    if (this.systemsPromise && Date.now() - this.loadedAt < SYSTEMS_MAX_AGE_MS) {
      return this.systemsPromise;
    }
    if (!this.inFlight) {
      const fetching = this.fetchSystems().then(snapshot => {
        this.systemsPromise = Promise.resolve(snapshot);
        this.loadedAt = Date.now();
        return snapshot;
      });
      this.inFlight = fetching;
      const done = () => {
        if (this.inFlight === fetching) {
          this.inFlight = undefined;
        }
      };
      fetching.then(done, done);
    }
    return this.inFlight;
  }

  /**
   * One system's influence history — every faction's reading at each snapshot the tracker has
   * kept (30 days), with the time of each — for the history chart. Fetched on demand: the list
   * carries only the tracked factions' values, with no times and none of the other factions.
   */
  async getInfluenceHistory(systemAddress: string): Promise<HistoryRow[]> {
    const url = `${QUERY_BASE}/bgs/systems/${encodeURIComponent(systemAddress)}/history`;
    const history = await this.resilientGet<{ data?: HistoryRow[] }>(url);
    return history.data ?? [];
  }

  /** Name-suggestion + coordinate lookup, for the "sort by distance from system" search box. */
  typeahead(query: string): Promise<TypeaheadResponse> {
    return this.resilientGet<TypeaheadResponse>(`${TYPEAHEAD_ENDPOINT}?q=${encodeURIComponent(query)}`);
  }

  /**
   * The Architect Registry — what the tracker holds as each system's latest answer, plus
   * assignments made here — for the Assign dialog's architect-name suggestions and for what a
   * known architect last answered. Waits for the system list it is read from.
   */
  async getArchitectRegistry(): Promise<readonly ArchitectRegistryRow[]> {
    await this.getSystems();
    return [...this.registryRows];
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
   * memoised system list — and remembers it in localStorage, so the new architect shows up
   * straight away, and survives a reload, without waiting for the tracker to pick up the sheet row.
   */
  recordAssignment(submission: ArchitectSubmission): void {
    const answers: AssignmentAnswers = {
      systemName: submission.systemName,
      architect: submission.architect,
      affiliation: submission.affiliation,
      preferredFaction: submission.preferredFaction,
    };
    this.registryRows.push(toRegistryRow(answers));
    this.writeRecentAssignments([
      ...this.readRecentAssignments().filter(a => a.systemName !== answers.systemName),
      { ...answers, at: Date.now() },
    ]);

    const loaded = this.systemsPromise;
    if (loaded) {
      const patched = loaded.then(snapshot => ({
        ...snapshot,
        rows: snapshot.rows.map(r => (r.systemName === answers.systemName ? rowWithAssignment(r, answers) : r)),
      }));
      patched.catch(() => {
        if (this.systemsPromise === patched) {
          this.systemsPromise = undefined;
        }
      });
      this.systemsPromise = patched;
    }
  }

  private log(message: string): void {
    this.loadLogLines.update(lines => [...lines, message]);
  }

  private async fetchSystems(): Promise<BgsSnapshot> {
    this.loadLogLines.set([]);
    this.log('Asking the BGS tracker for every system in one go...');
    const response = await this.resilientGet<BgsAllResponse>(BGS_SYSTEMS_URL, SYSTEMS_TIMEOUT_MS);
    this.log(`Received ${response.data.length} systems.`);
    const { config } = response;
    if (!config) {
      // An API that predates `view=all` answers with its first page and no constants to score with.
      throw new Error('The BGS API did not send its client configuration.');
    }
    if (response.data.length < response.total) {
      throw new Error(`The BGS API sent ${response.data.length} of ${response.total} systems.`);
    }
    this.log('Scoring work priority for each system...');
    const placeholders = new Set(config.placeholders);
    const rows = response.data.map(record => this.toRow(record, config, placeholders));
    this.registryRows = response.data.flatMap(record => {
      const architect = record.architect;
      return architect && (architect.architect_name || architect.canonn_architect || architect.preferred_faction)
        ? [toRegistryRow({
            systemName: record.name,
            architect: architect.architect_name ?? '',
            affiliation: architect.canonn_architect ?? '',
            preferredFaction: architect.preferred_faction ?? '',
          })]
        : [];
    });
    this.applyRecentAssignments(rows);
    this.log(
      `Done. ${rows.filter(r => r.architect !== null).length} systems have an architect on record, ` +
        `${rows.filter(r => r.watchlist.length > 0).length} are on the watchlist.`,
    );
    return { rows, generatedAt: response.generated_at ?? null, config };
  }

  /**
   * Re-applies assignments made in this browser that the list doesn't show yet (the tracker
   * replicates the sheet on its own schedule), and forgets the ones it has caught up with or
   * that have outlived {@link RECENT_ASSIGNMENT_TTL_MS}. Edits `rows` in place.
   */
  private applyRecentAssignments(rows: BgsRow[]): void {
    const kept: RecentAssignment[] = [];
    for (const assignment of this.readRecentAssignments()) {
      const index = rows.findIndex(r => r.systemName === assignment.systemName);
      if (index < 0) {
        continue;
      }
      const caughtUp = (rows[index].architect ?? '').toLowerCase() === assignment.architect.trim().toLowerCase();
      if (caughtUp) {
        continue;
      }
      rows[index] = rowWithAssignment(rows[index], assignment);
      this.registryRows.push(toRegistryRow(assignment));
      kept.push(assignment);
    }
    this.writeRecentAssignments(kept);
  }

  private readRecentAssignments(): RecentAssignment[] {
    try {
      const raw = localStorage.getItem(RECENT_ASSIGNMENTS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        return [];
      }
      const now = Date.now();
      return parsed.filter(
        (a): a is RecentAssignment =>
          !!a &&
          typeof a.systemName === 'string' &&
          typeof a.architect === 'string' &&
          typeof a.at === 'number' &&
          now - a.at < RECENT_ASSIGNMENT_TTL_MS,
      );
    } catch {
      return [];
    }
  }

  private writeRecentAssignments(assignments: readonly RecentAssignment[]): void {
    try {
      localStorage.setItem(RECENT_ASSIGNMENTS_KEY, JSON.stringify(assignments));
    } catch {
      // Storage full/unavailable (e.g. private browsing) — this session's rows still show it.
    }
  }

  private toRow(
    record: BgsSystemRecord,
    config: BgsConfig,
    placeholders: ReadonlySet<string>,
  ): BgsRow {
    const presences = (record.minor_faction_presences ?? []).map(toPresence);
    const info = architectFromApi(record.architect);
    const canonnInfluence = this.influencePercent(presences, CANONN_FACTION);
    const cdsrInfluence = this.influencePercent(presences, CDSR_FACTION);
    const snapshotTime = record.last_seen ?? null;
    const war = summarizeFactionState(record.name, snapshotTime, presences, { states: WAR_STATES, requiresCorroboration: true });
    const election = summarizeFactionState(record.name, snapshotTime, presences, { states: ELECTION_STATES, requiresCorroboration: true });
    const retreat = summarizeFactionState(record.name, snapshotTime, presences, {
      states: RETREAT_STATES,
      requiresCorroboration: false,
      describeMatch: describeSingleFaction,
      isSuppressed: isHomeSystem,
    });
    const expansion = summarizeFactionState(record.name, snapshotTime, presences, {
      states: EXPANSION_STATES,
      requiresCorroboration: false,
      describeMatch: describeSingleFaction,
    });
    const hasCanonnStation = (record.canonn_assets ?? []).some(isCanonnAsset);
    const recordedPreference = info?.preferredFaction || null;
    const priorityInputs: PriorityInputs = {
      architect: info
        ? { architect_name: info.architect, canonn_architect: info.affiliation, preferred_faction: info.preferredFaction }
        : null,
      override: record.bgs_override ?? null,
      current: presences.map(p => ({ name: p.name, influence: p.influence })),
      controller: record.controlling_faction ?? null,
      trends: record.trend ?? {},
      states: record.states ?? [],
      conflicts: record.conflicts ?? [],
      dataAgeHours: record.data_age_hours ?? null,
    };
    return {
      systemName: record.name,
      systemAddress: record.system_address ?? '',
      influenceAverages: record.avg_influence ?? {},
      controllingFaction: record.controlling_faction ?? null,
      canonnInfluence,
      cdsrInfluence,
      canonnHistory: historyPercent(record.sparkline, CANONN_FACTION),
      cdsrHistory: historyPercent(record.sparkline, CDSR_FACTION),
      canonnChange: influenceChangeFrom(record.trend?.[CANONN_FACTION]),
      cdsrChange: influenceChangeFrom(record.trend?.[CDSR_FACTION]),
      // Spansh's colonisation flags are unreliable, so any system without a registered
      // architect is assignable — never blocked behind a "Not a colony" indicator. A
      // registry row that itself answers "not a colony" is different: that's a confirmed
      // answer, so it's shown blank rather than inviting another Assign.
      // A placeholder ("N/A", "Don't know"…) is no answer, the same as a blank cell.
      architect: cleanCell(info?.architect, placeholders) || null,
      notAColony: info?.affiliation === AFFILIATION_NOT_A_COLONY,
      preferredFaction: recordedPreference ?? derivePreferredFaction({ hasCanonnStation, canonnInfluence, cdsrInfluence }),
      preferredFactionRecorded: recordedPreference !== null,
      hasCanonnStation,
      stationCount: record.station_count ?? null,
      factions: [...presences]
        .sort((a, b) => b.influence - a.influence)
        .map(p => ({ name: p.name, influencePercent: p.influence * 100 })),
      stations: (record.canonn_assets ?? []).map(asset => ({
        name: asset.name,
        type: asset.type ?? null,
        controllingFaction: asset.controlling_minor_faction ?? null,
      })),
      factionDetails: [...presences]
        .sort((a, b) => b.influence - a.influence)
        .map(p => ({
          name: p.name,
          allegiance: p.allegiance ?? null,
          government: p.government ?? null,
          influencePercent: p.influence * 100,
          activeStates: p.active_states ?? [],
        })),
      warState: war.status,
      warDetails: war.details,
      warIsCanonnVsCanonn: war.isCanonnVsCanonn,
      electionState: election.status,
      electionDetails: election.details,
      electionIsCanonnVsCanonn: election.isCanonnVsCanonn,
      retreatState: retreat.status,
      retreatDetails: retreat.details,
      expansionState: expansion.status,
      bodyCount: record.body_count ?? null,
      population: record.population ?? null,
      x: record.x,
      y: record.y,
      z: record.z,
      updatedAt: record.last_seen ?? null,
      watchlist: overrideEntries(record),
      priority: computePriority(priorityInputs, config),
      priorityContext: { inputs: priorityInputs, config },
      powerplay: toPowerplay(record),
    };
  }

  private influencePercent(presences: readonly MinorFactionPresence[], factionName: string): number | null {
    const presence = presences.find(p => p.name === factionName);
    return presence ? presence.influence * 100 : null;
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
