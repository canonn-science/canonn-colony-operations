/**
 * "Which systems are worth spending effort on today": a work-priority score computed per row
 * from the architect's preferred faction plus the system's influence, trends, states and
 * conflicts. A port of the BGS API's `compute_priority` (`localpackage/bgs_logic.py`), run here
 * so the table can sort and filter by it over the whole list without a request per change. Every
 * constant it needs comes from the API's `config` (see {@link BgsConfig}); the fixed per-reason
 * scores below are part of the algorithm, as the API's client guide lists them.
 *
 * Work priority and data staleness are deliberately kept apart: how old a reading is says
 * nothing about whether the system is worth working, so `needsRecon`/`reconAgeDays` are
 * informational only and never feed the score. They are refreshed from the clock by
 * {@link currentPriority}, since a row can sit on screen for hours after it was scored.
 */
import { BgsRow } from '../canonn-bgs.service';
import { daysElapsed, parseUpdatedAt } from './freshness';

export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'out-of-scope' | 'not-applicable';

/** One applicable trigger, already weighted — the tooltip lists these, highest first. */
export interface PriorityReason {
  code: string;
  label: string;
  score: number;
}

/** Everything the Priority column needs to render and sort a row. */
export interface PriorityAssessment {
  tier: PriorityTier;
  /** How the system's situation reads: `push`, `restrain`, `hands-off`, `assumed` or `none`; null if unknown. */
  mode: string | null;
  leadFaction: string | null;
  /** Null for out-of-scope/not-applicable with no live conflict — such systems sort last. */
  score: number | null;
  /** Every applicable trigger, highest-scoring first. */
  reasons: PriorityReason[];
  /** Whether the last reading is old enough that it shouldn't be trusted at face value. Informational only — never affects {@link score}. */
  needsRecon: boolean;
  /** Whole days since the last reading; null if unknown. */
  reconAgeDays: number | null;
}

/** The server-side constants the API sends with the list (`config`), so none are hard-coded here. */
export interface BgsConfig {
  tracked_names: string[];
  thresholds: {
    low_influence: number;
    close_gap: number;
    trend_flat_per_day: number;
    trend_steep_per_day: number;
    trend_horizon_days: number;
    trend_warn_days: number;
  };
  needs_recon_hours: number;
  /** Cell values the architect registry uses to mean "no answer" (lower-case). */
  placeholders: string[];
  priority: {
    tiers: { tier: string; min: number }[];
    history_adj_min: number;
    history_adj_max: number;
    score_ceiling: number;
    gap_score_cap: number;
    gap_score_floor: number;
    guard_warn_pct: number;
    guard_critical_pct: number;
    guard_warn_days: number;
    guard_critical_days: number;
  };
}

/** A tracked faction's influence history, as a summary's `trend` map carries it. */
export interface PriorityTrend {
  per_day?: number | null;
  days_to_low?: number | null;
  vs?: {
    against?: string | null;
    relative_per_day?: number | null;
    kind?: string | null;
    days_to_cross?: number | null;
  } | null;
}

export interface PriorityArchitect {
  architect_name?: string | null;
  canonn_architect?: string | null;
  preferred_faction?: string | null;
}

export interface PriorityOverride {
  faction?: string | null;
  position?: number | null;
}

export interface PriorityConflict {
  war_type?: string | null;
  status?: string | null;
  faction_a?: string | null;
  faction_b?: string | null;
  involves_us?: boolean | null;
}

/** A tracked faction's active/pending states; an entry is a bare name or an object carrying `state`/`State`/`name`. */
export interface PriorityStates {
  faction: string;
  active?: unknown[] | null;
  pending?: unknown[] | null;
}

/** Everything {@link computePriority} reads about one system. */
export interface PriorityInputs {
  /** The latest architect submission, or null if there is none. */
  architect: PriorityArchitect | null;
  /** The system's watchlist entry, or null. */
  override: PriorityOverride | null;
  /** The newest snapshot's factions; `influence` is a 0-1 fraction. */
  current: readonly { name: string; influence: number }[];
  /** The controlling faction, or null. */
  controller: string | null;
  trends: Readonly<Record<string, PriorityTrend | undefined>>;
  states: readonly PriorityStates[];
  conflicts: readonly PriorityConflict[];
  /** Hours since the system was last seen; null if never. */
  dataAgeHours: number | null;
}

/** What a row with no priority information at all shows: no badge, nothing to sort on. */
export const NO_PRIORITY: PriorityAssessment = {
  tier: 'not-applicable',
  mode: null,
  leadFaction: null,
  score: null,
  reasons: [],
  needsRecon: true,
  reconAgeDays: null,
};

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** Whitespace collapsed, trimmed, lower-cased — how names and phrases are compared. */
function norm(value: unknown): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The cell with surrounding whitespace and backticks removed; '' if it is one of the registry's "no answer" placeholders. */
export function cleanCell(value: string | null | undefined, placeholders: ReadonlySet<string>): string {
  const cleaned = (value ?? '').trim().replace(/^`+|`+$/g, '').trim();
  return placeholders.has(cleaned.toLowerCase()) ? '' : cleaned;
}

/**
 * `value` (non-negative) to `digits` decimal places, an exact tie going to the even digit — what
 * the API's `round(x, 1)` does, so scores match it to the digit. A value only counts as a tie when
 * its exact binary expansion ends in 5, so 29.15 (really 29.1499…) rounds down, as it does there.
 */
function roundHalfEven(value: number, digits: number): number {
  const exact = value.toFixed(25);
  const dot = exact.indexOf('.');
  const rest = exact.slice(dot + 1 + digits);
  if (!/^50*$/.test(rest)) {
    return Number(value.toFixed(digits));
  }
  const kept = exact.slice(0, dot + 1 + digits);
  const lastDigit = Number(exact[dot + digits]);
  return lastDigit % 2 === 0 ? Number(kept) : Number((Number(kept) + 10 ** -digits).toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// algorithm
// ---------------------------------------------------------------------------

interface Reason extends PriorityReason {
  baseScore: number;
  historyAdj: number;
  faction: string | null;
  /** Falling influence makes it more urgent: its score takes the defensive trend nudge. */
  defensive: boolean;
  /** For gap-to-leader: how far behind the controller, in points. */
  gap?: number;
}

interface Context {
  config: BgsConfig;
  tracked: readonly string[];
  placeholders: ReadonlySet<string>;
}

type Factions = readonly (readonly [string, number])[];

const NOT_A_COLONY = 'not a colony';
const WAR_STATES = new Set(['war', 'civilwar']);
/** Literal on purpose: the API's gap adjustment reads its own default, not the configurable threshold. */
const GAP_FLAT_PER_DAY = 0.002;
/** How far ahead (days) an overtake still counts as "coming". */
const CATCH_HORIZON_DAYS = 30;

function reason(code: string, label: string, score: number, faction: string | null = null, defensive = false): Reason {
  return { code, label, score, baseScore: score, historyAdj: 0, faction, defensive };
}

function factionCountWeight(count: number): number {
  if (count <= 3) {
    return 0.25;
  }
  if (count === 4) {
    return 0.5;
  }
  if (count === 5) {
    return 0.75;
  }
  return 1;
}

function deriveTier(score: number, config: BgsConfig): PriorityTier {
  for (const { tier, min } of config.priority.tiers) {
    if (score >= min) {
      return tier as PriorityTier;
    }
  }
  return 'P4';
}

function resolveMode(architect: PriorityArchitect | null, ctx: Context): { mode: string; lead: string | null } {
  if (!architect) {
    return { mode: 'assumed', lead: null };
  }
  const preferred = cleanCell(architect.preferred_faction, ctx.placeholders);
  const lead = ctx.tracked.find(name => norm(name) === norm(preferred));
  if (lead) {
    return { mode: 'push', lead };
  }
  const cells = [architect.architect_name, architect.canonn_architect, architect.preferred_faction];
  if (cells.some(cell => norm(cell).includes(NOT_A_COLONY))) {
    return { mode: 'restrain', lead: null };
  }
  if (preferred) {
    return { mode: 'hands-off', lead: null };
  }
  if (cleanCell(architect.architect_name, ctx.placeholders)) {
    return { mode: 'none', lead: null };
  }
  return { mode: 'assumed', lead: null };
}

function stateName(state: unknown): string {
  let name: unknown = state;
  if (state && typeof state === 'object') {
    const entry = state as Record<string, unknown>;
    name = entry['state'] || entry['State'] || entry['name'] || '';
  }
  return norm(name).replace(/ /g, '');
}

/** {'retreat-active', 'war-pending', …} for our factions; Canonn-vs-CDSR contests are dropped (we don't mind which of ours wins). */
function conflictCodes(
  conflicts: readonly PriorityConflict[],
  states: readonly PriorityStates[],
  tracked: readonly string[],
): Set<string> {
  const codes = new Set<string>();
  let ownContest = false;
  for (const conflict of conflicts) {
    if (!conflict.involves_us) {
      continue;
    }
    if (tracked.includes(conflict.faction_a ?? '') && tracked.includes(conflict.faction_b ?? '')) {
      ownContest = true;
      continue;
    }
    const status = norm(conflict.status);
    if (status === 'active' || status === 'pending') {
      const kind = norm(conflict.war_type).includes('election') ? 'election' : 'war';
      codes.add(`${kind}-${status}`);
    }
  }
  for (const entry of states) {
    for (const phase of ['active', 'pending'] as const) {
      for (const state of entry[phase] ?? []) {
        const name = stateName(state);
        if (name === 'retreat') {
          codes.add(`retreat-${phase}`);
        } else if (WAR_STATES.has(name) && !ownContest) {
          codes.add(`war-${phase}`);
        } else if (name === 'election' && !ownContest) {
          codes.add(`election-${phase}`);
        }
      }
    }
  }
  return codes;
}

const CONFLICT_REASONS: readonly (readonly [string, string, number])[] = [
  ['retreat-active', 'Retreat in progress', 100],
  ['retreat-pending', 'Retreat pending', 100],
  ['war-active', 'War active', 95],
  ['election-active', 'Election active', 92],
  ['war-pending', 'War pending', 88],
  ['election-pending', 'Election pending', 85],
];

function conflictReasons(codes: ReadonlySet<string>, allowed: ReadonlySet<string> | null = null): Reason[] {
  const out: Reason[] = [];
  for (const [code, label, score] of CONFLICT_REASONS) {
    if (codes.has(code) && (allowed === null || allowed.has(code.split('-')[0]))) {
      out.push(reason(code, label, score));
    }
  }
  return out;
}

/** Canonn and CDSR within 3% as the top two of ours, nobody else level with them. */
function ownFactionsContest(factions: Factions, tracked: readonly string[]): boolean {
  const ours = factions.filter(([name]) => tracked.includes(name)).map(([, pct]) => pct);
  if (ours.length < 2 || Math.abs(ours[0] - ours[1]) >= 3) {
    return false;
  }
  const strongest = factions.find(([name]) => !tracked.includes(name));
  return strongest === undefined || strongest[1] < Math.min(ours[0], ours[1]);
}

/** Keep-out-of-last-place triggers for one of our factions. */
function floorReasons(name: string, pct: number, rank: number, count: number, weight: number): Reason[] {
  const out: Reason[] = [];
  if (pct < 4) {
    out.push(reason('below-4', `${name} below 4% influence`, 85 * weight, name, true));
  }
  if (pct < 6) {
    out.push(reason('below-6', `${name} below 6% influence`, 70 * weight, name, true));
  }
  if (rank === count - 1 && count > 1 && pct < 10) {
    out.push(reason('lowest-ranked', `${name} is lowest-ranked in the system`, 65 * weight, name, true));
  }
  if (pct < 10) {
    out.push(reason('below-10', `${name} below 10% influence`, 50 * weight, name, true));
  }
  if (rank === count - 1 && count > 3) {
    out.push(
      reason('lowest-should-not-be', `${name} is the weakest faction here (4+ factions) - get to safety`, 90, name, true),
    );
  }
  return out;
}

function pushReasons(
  lead: string,
  factions: Factions,
  controller: string | null,
  codes: ReadonlySet<string>,
  ctx: Context,
  weight: number,
): Reason[] {
  const { tracked, config } = ctx;
  const names = factions.map(([name]) => name);
  const pctByName = new Map(factions);
  const ownContest = ownFactionsContest(factions, tracked);
  // a Canonn-vs-CDSR race is not worth chasing, but a retreat still is
  const reasons = conflictReasons(codes, ownContest ? new Set(['retreat']) : null);
  if (!names.includes(lead)) {
    return reasons;
  }
  const leadPct = pctByName.get(lead) as number;
  const rank = names.indexOf(lead);
  const count = factions.length;
  const isController = controller === lead;
  const rival = factions.find(([name]) => !tracked.includes(name))?.[1] ?? null;
  const controllerPct = controller === null ? undefined : pctByName.get(controller);

  if (isController && rival !== null) {
    const margin = leadPct - rival;
    if (margin < 3) {
      reasons.push(reason('control-margin-under-3', 'Holding control by under 3%', 80, lead, true));
    } else if (margin < 7) {
      reasons.push(reason('control-margin-3-7', 'Holding control by 3-7%', 55, lead, true));
    } else if (margin < 15) {
      reasons.push(reason('control-margin-7-15', 'Holding control by 7-15%', 30, lead, true));
    }
  }

  const ours = factions.filter(([name]) => tracked.includes(name)).map(([, pct]) => pct);
  if (!ownContest && ours.length >= 2 && Math.abs(ours[0] - ours[1]) < 3) {
    reasons.push(reason('canonn-cdsr-close', 'Canonn and CDSR within 3% of each other', 75));
  }

  reasons.push(...floorReasons(lead, leadPct, rank, count, weight));

  if (!isController && controllerPct !== undefined) {
    const gap = controllerPct - leadPct;
    const { gap_score_cap: cap, gap_score_floor: floor } = config.priority;
    const score = Math.min(cap, Math.max(floor, cap - Math.max(0, gap)));
    const gapReason = reason('gap-to-leader', `Should control - ${gap.toFixed(1)}% behind the leader`, score, lead);
    gapReason.gap = gap;
    reasons.push(gapReason);
  }
  return reasons;
}

function watchlistReasons(override: PriorityOverride | null, factions: Factions): Reason[] {
  if (!override) {
    return [];
  }
  const { faction, position } = override;
  if (!faction || !position) {
    return [];
  }
  const names = factions.map(([name]) => name);
  const index = names.indexOf(faction);
  const current = index >= 0 ? index + 1 : names.length + 1;
  if (current <= position) {
    return [];
  }
  return [reason('below-watchlist-position', `${faction} is ranked #${current}, below the required #${position}`, 90, faction)];
}

/** Days until the trend's faction overtakes the controller: the trend's own comparison when it was made against the controller, otherwise assuming the controller holds still. */
function daysToCatch(trend: PriorityTrend | undefined, controller: string | null, gapPct: number): number | null {
  if (!trend) {
    return null;
  }
  const vs = trend.vs;
  if (vs && vs.against === controller && vs.kind === 'overtake') {
    return vs.days_to_cross ?? null;
  }
  const rate = trend.per_day;
  if (rate !== null && rate !== undefined && rate > 0 && gapPct > 0) {
    const days = gapPct / (rate * 100);
    return days <= CATCH_HORIZON_DAYS ? Math.round(days * 10) / 10 : null;
  }
  return null;
}

function defensiveAdjustment(trend: PriorityTrend | undefined, config: BgsConfig): number {
  if (!trend) {
    return 0;
  }
  const { trend_flat_per_day: flat, trend_steep_per_day: steep, trend_warn_days: warn } = config.thresholds;
  const rate = trend.per_day;
  let adjustment = 0;
  if (rate !== null && rate !== undefined) {
    if (rate <= -steep) {
      adjustment += 10;
    } else if (rate < -flat) {
      adjustment += 5;
    } else if (rate >= steep) {
      adjustment -= 10;
    } else if (rate > flat) {
      adjustment -= 5;
    }
  }
  const daysLow = trend.days_to_low;
  if (daysLow !== null && daysLow !== undefined && daysLow > 0 && daysLow <= warn) {
    adjustment += 10;
  }
  const vs = trend.vs;
  if (vs && vs.kind === 'lead_loss' && vs.days_to_cross !== null && vs.days_to_cross !== undefined && vs.days_to_cross <= warn) {
    adjustment += 10;
  }
  return adjustment;
}

function gapAdjustment(item: Reason, trend: PriorityTrend | undefined, controller: string | null, config: BgsConfig): number {
  const days = daysToCatch(trend, controller, item.gap ?? 0);
  if (days !== null) {
    const { guard_critical_days: critical, guard_warn_days: warn } = config.priority;
    return days <= critical ? 10 : days <= warn ? 5 : 0;
  }
  const rate = trend?.per_day;
  const vs = trend?.vs;
  if (vs && vs.against === controller && (vs.relative_per_day ?? 0) < 0) {
    return -10;
  }
  if (rate !== null && rate !== undefined && rate < -GAP_FLAT_PER_DAY) {
    return -10;
  }
  return 0;
}

/** Nudges each reason's score by how its faction's influence has been moving. */
function applyHistory(
  reasons: Reason[],
  trends: Readonly<Record<string, PriorityTrend | undefined>>,
  controller: string | null,
  config: BgsConfig,
): void {
  const { history_adj_min: min, history_adj_max: max, score_ceiling: ceiling } = config.priority;
  for (const item of reasons) {
    const trend = item.faction ? trends[item.faction] : undefined;
    let adjustment = 0;
    if (item.defensive) {
      adjustment = defensiveAdjustment(trend, config);
    } else if (item.code === 'gap-to-leader') {
      adjustment = gapAdjustment(item, trend, controller, config);
    }
    adjustment = clamp(adjustment, min, max);
    if (adjustment !== 0) {
      item.historyAdj = adjustment;
      item.score = clamp(item.baseScore + adjustment, 0, ceiling);
    }
  }
}

/**
 * The priority badge and score for one system. `inputs.current` is the newest snapshot's
 * factions; `trends`, `states` and `conflicts` are the summary's own fields. See the API's
 * client guide (`docs/bgs-systems-client.md`) for the rules this follows.
 *
 * The restrain-mode `guard` the API also reports is display-only on its side and isn't read
 * here, so it isn't computed.
 */
export function computePriority(inputs: PriorityInputs, config: BgsConfig): PriorityAssessment {
  const ctx: Context = { config, tracked: config.tracked_names, placeholders: new Set(config.placeholders) };
  const { tracked } = ctx;
  const { architect, override, controller, trends } = inputs;

  const { mode, lead: resolvedLead } = resolveMode(architect, ctx);
  let lead = resolvedLead;
  // Equal influence: the controlling faction ranks ahead, as the incumbent. (The API ranks ties in
  // snapshot row order, which a summary's faction list doesn't preserve.)
  const factions: Factions = inputs.current
    .map(f => [f.name, f.influence * 100] as const)
    .sort((a, b) => b[1] - a[1] || Number(b[0] === inputs.controller) - Number(a[0] === inputs.controller));
  const count = factions.length;
  const weight = factionCountWeight(count);
  const codes = conflictCodes(inputs.conflicts, inputs.states, tracked);
  const needsRecon = inputs.dataAgeHours === null || inputs.dataAgeHours >= config.needs_recon_hours;

  const preferred = cleanCell(architect?.preferred_faction, ctx.placeholders);
  let reasons: Reason[] = [];

  if (mode === 'hands-off' || mode === 'none') {
    // A watchlist entry on the very faction named as preferred lifts a standing hands-off
    // agreement once that faction has slipped.
    if (mode === 'hands-off') {
      const watched = override && norm(override.faction) === norm(preferred) ? override : null;
      reasons = watchlistReasons(watched, factions);
    }
    if (reasons.length === 0) {
      const label =
        mode === 'hands-off'
          ? `Preferred faction is ${preferred} - hands off`
          : 'Architect assigned, no faction preference - not a priority target';
      return {
        tier: mode === 'hands-off' ? 'out-of-scope' : 'not-applicable',
        mode,
        leadFaction: null,
        score: null,
        reasons: [{ code: mode, label, score: 0 }],
        needsRecon,
        reconAgeDays: null,
      };
    }
  } else if (mode === 'restrain') {
    reasons = conflictReasons(codes, new Set(['retreat']));
    factions.forEach(([name, pct], index) => {
      if (tracked.includes(name)) {
        reasons.push(...floorReasons(name, pct, index, count, weight));
      }
    });
    // position 1 for one of ours would mean gaining control: forbidden wins
    if (override && !(tracked.includes(override.faction ?? '') && override.position === 1)) {
      reasons.push(...watchlistReasons(override, factions));
    }
  } else {
    if (mode === 'assumed') {
      lead = factions.find(([name]) => tracked.includes(name))?.[0] ?? null;
    }
    reasons = lead ? pushReasons(lead, factions, controller, codes, ctx, weight) : [];
    if (mode === 'assumed') {
      // never rank a push for control off an assumption nobody confirmed
      reasons = reasons.filter(r => r.code !== 'gap-to-leader' && r.code !== 'lowest-should-not-be');
      if (reasons.some(r => ['retreat', 'war', 'election'].includes(r.code.split('-')[0]))) {
        reasons.push(
          reason('assumed-needs-architect', 'No architect assigned - get one assigned before working this conflict', 101),
        );
      }
    }
    reasons.push(...watchlistReasons(override, factions));
  }

  if (reasons.length === 0) {
    reasons = [reason('none', 'Nothing applicable', 5)];
  } else {
    applyHistory(reasons, trends, controller, config);
  }
  reasons.sort((a, b) => b.score - a.score);
  const rounded: PriorityReason[] = reasons.map(r => ({ code: r.code, label: r.label, score: roundHalfEven(r.score, 1) }));
  const score = rounded[0].score;
  return {
    tier: deriveTier(score, config),
    mode,
    leadFaction: lead,
    score,
    reasons: rounded,
    needsRecon,
    reconAgeDays: null,
  };
}

// ---------------------------------------------------------------------------
// staleness, refreshed from the clock
// ---------------------------------------------------------------------------

/** Days-since-update at or above which a reading is old enough not to trust at face value; null (no timestamp at all) always counts as needing recon. */
const NEEDS_RECON_DAYS = 2;

/** Whether a reading is stale enough to flag — purely informational, see the module doc above. */
export function needsRecon(daysSinceUpdate: number | null): boolean {
  return daysSinceUpdate === null || daysSinceUpdate >= NEEDS_RECON_DAYS;
}

/**
 * The row's priority with its staleness flags brought up to `nowMs`. The tier, score and
 * reasons are as computed; only {@link PriorityAssessment.needsRecon} and
 * {@link PriorityAssessment.reconAgeDays} are recomputed, from the row's own last-seen time.
 */
export function currentPriority(row: BgsRow, nowMs: number): PriorityAssessment {
  const updatedAtMs = parseUpdatedAt(row.updatedAt);
  const reconAgeDays = updatedAtMs === null ? null : daysElapsed(updatedAtMs, nowMs);
  return { ...row.priority, needsRecon: needsRecon(reconAgeDays), reconAgeDays };
}
