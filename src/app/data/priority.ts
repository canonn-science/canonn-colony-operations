/**
 * "Which systems are worth spending effort on today": a work-priority score computed per
 * row from the Architect Registry's preferred faction plus the system's current influence
 * and state. Shaped like `freshness.ts` — injected clock, exported pure functions, stable
 * reason codes so specs (and the tooltip) don't depend on wording.
 *
 * Work priority and data staleness are deliberately kept apart (see the feature request this
 * implements): how old a reading is says nothing about whether the system is worth working,
 * so `needsRecon`/`reconAgeDays` below are informational only and never feed the score.
 */
import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import { daysElapsed, parseUpdatedAt } from './freshness';

export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'out-of-scope' | 'not-applicable';
export type PriorityScope = 'in-scope' | 'assumed' | 'out-of-scope' | 'no-preference';

/** One applicable trigger, already weighted — the tooltip lists these, highest first. */
export interface PriorityReason {
  code: string;
  label: string;
  score: number;
}

/** Everything the Priority column needs to render and sort a row. */
export interface PriorityAssessment {
  tier: PriorityTier;
  scope: PriorityScope;
  leadFaction: string | null;
  /** Null for out-of-scope/not-applicable with no live conflict — sorts last via the table's existing null-last convention. */
  score: number | null;
  /** Every applicable trigger, highest-scoring first. */
  reasons: PriorityReason[];
  /** Whether the last reading is old enough that it shouldn't be trusted at face value. Informational only — never affects {@link score}. */
  needsRecon: boolean;
  /** Whole days since the last reading; null if unknown. */
  reconAgeDays: number | null;
}

const TIER_THRESHOLDS: readonly { tier: PriorityTier; min: number }[] = [
  { tier: 'P0', min: 85 },
  { tier: 'P1', min: 65 },
  { tier: 'P2', min: 40 },
  { tier: 'P3', min: 20 },
];

export function deriveTier(score: number): PriorityTier {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (score >= min) {
      return tier;
    }
  }
  return 'P4';
}

/**
 * What removes a non-native faction is falling below 2.5% influence. In a small system the
 * bottom faction sits comfortably in the teens; in a crowded one it routinely sits at 3-6%.
 * Scales the *predictive* triggers (influence thresholds, bottom-ranked) so a three-faction
 * system's bottom slot doesn't read as dangerous as a seven-faction system's.
 */
export function factionCountWeight(factionCount: number): number {
  if (factionCount <= 3) {
    return 0.25;
  }
  if (factionCount === 4) {
    return 0.5;
  }
  if (factionCount === 5) {
    return 0.75;
  }
  return 1.0;
}

/** Days-since-update at or above which a reading is old enough not to trust at face value; null (no timestamp at all) always counts as needing recon. */
const NEEDS_RECON_DAYS = 2;

/** Whether a reading is stale enough to flag — purely informational, see the module doc above. */
export function needsRecon(daysSinceUpdate: number | null): boolean {
  return daysSinceUpdate === null || daysSinceUpdate >= NEEDS_RECON_DAYS;
}

/**
 * BGS effort scales with the log of population — a percentage point of influence costs
 * proportionally more to move in a billion-population system than a thousand-population one.
 * Floors at 0.025 so a huge system's gap is heavily, not infinitely, discounted rather than
 * simply excluded.
 */
export function populationCostFactor(population: number | null): number {
  if (population === null || population <= 0) {
    return 1;
  }
  return Math.max(0.025, 1 - Math.log10(population) / 10.875);
}

/** The population-weighted cost of closing a percentage-point gap — the same raw gap costs more in a bigger system. */
export function costToClose(gapPoints: number, population: number | null): number {
  return gapPoints / populationCostFactor(population);
}

const GAP_SCORE_CAP = 80;
const GAP_SCORE_FLOOR = 5;

/**
 * Maps a population-weighted gap to a 0-100 work-priority contribution: a system level with
 * the leader (gap 0) is close to flipping control and scores near the top; a system whose gap
 * is expensive to close (a wide gap, a huge population, or both) is floored at the same
 * "nothing applicable" baseline other quiet systems get, rather than going negative.
 */
function gapToLeaderScore(gapPoints: number, population: number | null): number {
  const cost = costToClose(Math.max(0, gapPoints), population);
  return Math.min(GAP_SCORE_CAP, Math.max(GAP_SCORE_FLOOR, GAP_SCORE_CAP - cost));
}

/** Case- and whitespace-insensitive key, since the Preferred Faction answer is free text. */
function factionKey(name: string): string {
  return name.trim().toLowerCase();
}

const CANONN_KEY = factionKey(CANONN_FACTION);
const CDSR_KEY = factionKey(CDSR_FACTION);

/** True only when the Architect Registry names one of our own factions explicitly — Canonn or CDSR, not an assumed lead, and not the "not a colony" default. */
function isExplicitlyPreferred(row: BgsRow): boolean {
  const preferred = row.preferredFaction?.trim();
  if (!preferred) {
    return false;
  }
  const key = factionKey(preferred);
  return key === CANONN_KEY || key === CDSR_KEY;
}

/**
 * The scope gate (FR-4): whether a system is prioritised at all, and who leads it.
 *  - Preferred faction names Canonn/CDSR → in-scope, that's the lead.
 *  - Preferred faction names anyone else → out-of-scope — a standing agreement is worse to
 *    breach than to leave unworked.
 *  - "Not a colony" with no preference → in-scope, Canonn leads by default policy.
 *  - An architect is confirmed but left the preference blank → "no-preference": someone has
 *    already looked at this system and didn't name us, so unlike the truly-unknown case below
 *    there's no reason to guess a lead from influence presence — it's simply excluded.
 *  - No registry row at all → "assumed": lead is guessed from whichever of our factions has
 *    presence (the one with more influence if both do), and the caller must restrict this
 *    scope to defensive triggers only — never rank a push for control off an assumption
 *    nobody has confirmed.
 */
export function resolveScope(row: BgsRow): { scope: PriorityScope; leadFaction: string | null } {
  const preferred = row.preferredFaction?.trim();
  if (preferred) {
    const key = factionKey(preferred);
    if (key === CANONN_KEY) {
      return { scope: 'in-scope', leadFaction: CANONN_FACTION };
    }
    if (key === CDSR_KEY) {
      return { scope: 'in-scope', leadFaction: CDSR_FACTION };
    }
    return { scope: 'out-of-scope', leadFaction: null };
  }

  if (row.notAColony) {
    return { scope: 'in-scope', leadFaction: CANONN_FACTION };
  }

  if (row.architect !== null) {
    return { scope: 'no-preference', leadFaction: null };
  }

  if (row.canonnInfluence !== null && row.cdsrInfluence !== null) {
    return { scope: 'assumed', leadFaction: row.canonnInfluence >= row.cdsrInfluence ? CANONN_FACTION : CDSR_FACTION };
  }
  if (row.canonnInfluence !== null) {
    return { scope: 'assumed', leadFaction: CANONN_FACTION };
  }
  if (row.cdsrInfluence !== null) {
    return { scope: 'assumed', leadFaction: CDSR_FACTION };
  }
  return { scope: 'assumed', leadFaction: null };
}

function influenceOf(row: BgsRow, faction: string | null): number | null {
  if (faction === CANONN_FACTION) {
    return row.canonnInfluence;
  }
  if (faction === CDSR_FACTION) {
    return row.cdsrInfluence;
  }
  return null;
}

/**
 * War/election/retreat triggers involving Canonn or CDSR — computed independently of scope
 * (FR-4's lead-faction gate) so a live, time-limited conflict is never hidden purely for want
 * of a recorded preferred faction. See {@link computePriorityAssessment}.
 */
function conflictReasons(row: BgsRow): PriorityReason[] {
  const reasons: PriorityReason[] = [];
  if (row.retreatState === 'active' || row.retreatState === 'pending') {
    // Never weighted — it's the top of the list by construction.
    reasons.push({ code: 'retreat', label: 'Retreat in progress', score: 100 });
  }
  if (row.warState === 'active') {
    reasons.push({ code: 'war-active', label: 'War active', score: 95 });
  }
  if (row.electionState === 'active') {
    reasons.push({ code: 'election-active', label: 'Election active', score: 92 });
  }
  if (row.warState === 'pending') {
    reasons.push({ code: 'war-pending', label: 'War pending', score: 88 });
  }
  if (row.electionState === 'pending') {
    reasons.push({ code: 'election-pending', label: 'Election pending', score: 85 });
  }
  return reasons;
}

/** Every trigger below `scope`'s own scope gate, in FR-4's table order — conflict triggers plus everything that needs a confirmed or assumed lead faction. */
function baseReasons(row: BgsRow, leadFaction: string, leadInfluence: number | null, weight: number, scope: PriorityScope): PriorityReason[] {
  const reasons: PriorityReason[] = conflictReasons(row);

  if (leadInfluence !== null && leadInfluence < 4) {
    reasons.push({ code: 'lead-below-4', label: 'Lead faction below 4% influence', score: 85 * weight });
  }

  const controllerInfluence = row.factions.find(f => f.name === row.controllingFaction)?.influencePercent ?? null;
  const isController = row.controllingFaction === leadFaction;
  // The margin that actually matters is against a real rival, not against whichever of our
  // own two factions isn't the lead — Canonn and CDSR both holding the top two slots (e.g.
  // 46.5% / 40%) is firmly in control, not a close race, even though 40% is "the next entry
  // down the list".
  const strongestRival = row.factions.find(f => f.name !== CANONN_FACTION && f.name !== CDSR_FACTION)?.influencePercent ?? null;
  if (isController && leadInfluence !== null && strongestRival !== null) {
    const margin = leadInfluence - strongestRival;
    if (margin < 3) {
      reasons.push({ code: 'control-margin-under-3', label: 'Holding control by under 3%', score: 80 });
    }
  }

  if (row.canonnInfluence !== null && row.cdsrInfluence !== null && Math.abs(row.canonnInfluence - row.cdsrInfluence) < 3) {
    reasons.push({ code: 'canonn-cdsr-close', label: 'Canonn and CDSR within 3% of each other', score: 75 });
  }
  if (leadInfluence !== null && leadInfluence < 6) {
    reasons.push({ code: 'lead-below-6', label: 'Lead faction below 6% influence', score: 70 * weight });
  }

  // Rank alone is a weak signal — in a 3-faction system, being last is often a perfectly
  // healthy ~25-30% (there are only two rivals to beat), so it also requires the same "below
  // 10%" floor as the influence triggers above, rather than firing on rank position alone.
  const leadRankIndex = row.factions.findIndex(f => f.name === leadFaction);
  if (leadRankIndex !== -1 && leadRankIndex === row.factions.length - 1 && row.factions.length > 1 && leadInfluence !== null && leadInfluence < 10) {
    reasons.push({ code: 'lead-lowest-ranked', label: 'Lead faction is lowest-ranked in the system', score: 65 * weight });
  }

  // Being the weakest faction present in a system with 4+ factions is a withdrawal-risk
  // signal — but only when the Architect Registry explicitly names one of our own factions
  // (Canonn or CDSR) as preferred, not a guessed/assumed lead: getting a system we're
  // actually responsible for out of danger comes before pushing anywhere else for control,
  // so this outranks the work-priority triggers below and lands in P0. Not gated by the same
  // "below 10%" floor or faction-count weighting as the influence triggers above, since this
  // is about rank position itself, not a raw influence reading. Restricted to 4+ factions: in
  // a 3-faction system there are only two rivals to beat, so "lowest of three" isn't a
  // meaningful risk signal on its own.
  if (isExplicitlyPreferred(row) && leadRankIndex !== -1 && leadRankIndex === row.factions.length - 1 && row.factions.length > 3) {
    reasons.push({
      code: 'lead-lowest-should-control',
      label: 'Explicitly preferred and weakest here (4+ factions) — get to safety before pushing for control',
      score: 90,
    });
  }

  if (isController && leadInfluence !== null && strongestRival !== null) {
    const margin = leadInfluence - strongestRival;
    if (margin >= 3 && margin < 7) {
      reasons.push({ code: 'control-margin-3-7', label: 'Holding control by 3-7%', score: 55 });
    }
  }
  if (leadInfluence !== null && leadInfluence < 10) {
    reasons.push({ code: 'lead-below-10', label: 'Lead faction below 10% influence', score: 50 * weight });
  }

  // The primary "is this worth taking" signal: not the raw gap alone, but how expensive that
  // gap is to close given the system's population (see costToClose). A system level with the
  // leader (gap 0) scores near the top of the range; a wide gap in a huge population is
  // floored at the same baseline a quiet system gets, rather than inverting the ranking the
  // way flat percentage thresholds used to (see the feature request this implements).
  if (!isController && leadInfluence !== null && controllerInfluence !== null) {
    const gap = controllerInfluence - leadInfluence;
    reasons.push({
      code: 'gap-to-leader',
      label: `Should control — ${gap.toFixed(1)}% behind the leader (population-weighted)`,
      score: gapToLeaderScore(gap, row.population),
    });
  }

  if (isController && leadInfluence !== null && strongestRival !== null) {
    const margin = leadInfluence - strongestRival;
    if (margin >= 7 && margin < 15) {
      reasons.push({ code: 'control-margin-7-15', label: 'Holding control by 7-15%', score: 30 });
    }
  }

  return reasons;
}

/** Computes the full priority assessment for one row. `nowMs` is injectable, for tests. */
export function computePriorityAssessment(row: BgsRow, nowMs: number = Date.now()): PriorityAssessment {
  const { scope, leadFaction } = resolveScope(row);

  if (scope === 'out-of-scope' || scope === 'no-preference') {
    // A live war/election is time-limited and shouldn't be hidden purely for want of a
    // recorded preferred faction (FR: "surface active conflicts regardless of tier") — so
    // check for one before falling back to the scope's usual null-score exclusion.
    const conflicts = conflictReasons(row).sort((a, b) => b.score - a.score);

    if (conflicts.length === 0) {
      const scopeReason: PriorityReason =
        scope === 'out-of-scope'
          ? { code: 'out-of-scope', label: `Preferred faction is ${row.preferredFaction} — hands off`, score: 0 }
          : { code: 'no-preference', label: 'Architect assigned, no faction preference — not a priority target', score: 0 };
      return {
        tier: scope === 'out-of-scope' ? 'out-of-scope' : 'not-applicable',
        scope,
        leadFaction: null,
        score: null,
        reasons: [scopeReason],
        needsRecon: false,
        reconAgeDays: null,
      };
    }

    const scopeReason: PriorityReason =
      scope === 'out-of-scope'
        ? { code: 'out-of-scope', label: `Preferred faction is ${row.preferredFaction} — otherwise hands off`, score: 0 }
        : { code: 'no-preference', label: 'Architect assigned, no faction preference otherwise', score: 0 };
    const updatedAtMs = parseUpdatedAt(row.updatedAt);
    const reconAgeDays = updatedAtMs === null ? null : daysElapsed(updatedAtMs, nowMs);
    const score = conflicts[0].score;
    return {
      tier: deriveTier(score),
      scope,
      leadFaction: null,
      score,
      reasons: [...conflicts, scopeReason],
      needsRecon: needsRecon(reconAgeDays),
      reconAgeDays,
    };
  }

  const leadInfluence = influenceOf(row, leadFaction);
  const weight = factionCountWeight(row.factions.length);

  let reasons: PriorityReason[] = leadFaction ? baseReasons(row, leadFaction, leadInfluence, weight, scope) : [];
  if (scope === 'assumed') {
    // Never rank a push for control off an assumption nobody has confirmed with the architect.
    reasons = reasons.filter(r => r.code !== 'gap-to-leader');
  }
  if (reasons.length === 0) {
    reasons = [{ code: 'none', label: 'Nothing applicable', score: 5 }];
  }
  reasons.sort((a, b) => b.score - a.score);

  const score = reasons[0].score;
  const updatedAtMs = parseUpdatedAt(row.updatedAt);
  const reconAgeDays = updatedAtMs === null ? null : daysElapsed(updatedAtMs, nowMs);

  return {
    tier: deriveTier(score),
    scope,
    leadFaction,
    score,
    reasons,
    needsRecon: needsRecon(reconAgeDays),
    reconAgeDays,
  };
}

/**
 * The sort key for the Priority column. A confirmed lead (in-scope: the Architect Registry
 * names Canonn or CDSR) always outranks an assumed one, regardless of score — an assumed
 * lead is a guess, and shouldn't out-sort a system we actually know we're responsible for.
 * Out-of-scope/not-applicable rows with no live conflict stay null, sorting last either
 * direction via the table's existing null-last convention (see `compareColumnValues`).
 */
export function prioritySortKey(assessment: PriorityAssessment): number | null {
  if (assessment.score === null) {
    return null;
  }
  const scopeRank = assessment.scope === 'in-scope' ? 1 : 0;
  return scopeRank * 1000 + assessment.score;
}
