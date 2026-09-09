/**
 * "Which systems need a Commander today": a priority score computed per row from the
 * Architect Registry's preferred faction plus the system's current influence and state.
 * Shaped like `freshness.ts` — injected clock, exported pure functions, stable reason codes
 * so specs (and the tooltip) don't depend on wording.
 */
import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import { daysElapsed, parseUpdatedAt } from './freshness';

export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'out-of-scope';
export type PriorityScope = 'in-scope' | 'assumed' | 'out-of-scope';

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
  /** Null for out-of-scope — sorts last via the table's existing null-last convention. */
  score: number | null;
  /** Every applicable trigger, highest-scoring first. */
  reasons: PriorityReason[];
  /** True once a stale reading's recon bonus applied — "fly there", not "grind influence". */
  needsRecon: boolean;
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

/**
 * A stale reading isn't low-priority, it's *unknown* — proportional to what the last reading
 * already scored, so a stale-but-comfortable system stays quiet while a stale-but-troubled
 * one climbs. Never lets a stale reading outrank a current, genuinely worse one.
 */
export function reconFactor(daysSinceUpdate: number | null): number {
  if (daysSinceUpdate === null || daysSinceUpdate >= 28) {
    return 0.3;
  }
  if (daysSinceUpdate >= 7) {
    return 0.2;
  }
  if (daysSinceUpdate >= 2) {
    return 0.1;
  }
  return 0;
}

/** Case- and whitespace-insensitive key, since the Preferred Faction answer is free text. */
function factionKey(name: string): string {
  return name.trim().toLowerCase();
}

const CANONN_KEY = factionKey(CANONN_FACTION);
const CDSR_KEY = factionKey(CDSR_FACTION);

/**
 * The scope gate (FR-4): whether a system is prioritised at all, and who leads it.
 *  - Preferred faction names Canonn/CDSR → in-scope, that's the lead.
 *  - Preferred faction names anyone else → out-of-scope — a standing agreement is worse to
 *    breach than to leave unworked.
 *  - "Not a colony" with no preference → in-scope, Canonn leads by default policy.
 *  - No confirmed answer at all (no registry row, or a row with a blank preference) →
 *    "assumed": lead is guessed from whichever of our factions has presence (the one with
 *    more influence if both do), and the caller must restrict this scope to defensive
 *    triggers only — never rank a push for control off an assumption nobody has confirmed.
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

/** Every trigger below `scope`'s own scope gate, in FR-4's table order. */
function baseReasons(row: BgsRow, leadFaction: string, leadInfluence: number | null, weight: number, scope: PriorityScope): PriorityReason[] {
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

  // Confirmed systems only (never off an assumed lead) — being the weakest faction present
  // is a call to action to build up and take control, independent of the retreat-risk framing
  // above (so it isn't gated by the same "below 10%" floor, and isn't weighted by faction
  // count — this is about strategic priority in a system we're committed to, not risk of
  // falling below the 2.5% retreat threshold). Restricted to 4+ factions: in a 3-faction
  // system there are only two rivals to beat, so "lowest of three" isn't a meaningful call
  // to action on its own.
  if (scope === 'in-scope' && leadRankIndex !== -1 && leadRankIndex === row.factions.length - 1 && row.factions.length > 3) {
    reasons.push({
      code: 'confirmed-lead-lowest-should-control',
      label: 'Confirmed system — our faction is weakest here; prioritise taking control',
      score: 60,
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

  if (!isController && leadInfluence !== null && controllerInfluence !== null) {
    const gap = controllerInfluence - leadInfluence;
    if (gap < 10) {
      reasons.push({ code: 'should-control-under-10', label: 'Should control, under 10% behind the controller', score: 40 });
    } else {
      reasons.push({ code: 'should-control-10-plus', label: 'Should control, 10%+ behind', score: 25 });
    }
  }

  if (isController && leadInfluence !== null && strongestRival !== null) {
    const margin = leadInfluence - strongestRival;
    if (margin >= 7 && margin < 15) {
      reasons.push({ code: 'control-margin-7-15', label: 'Holding control by 7-15%', score: 30 });
    }
  }

  if (leadInfluence !== null && leadInfluence > 75 && (row.expansionState === 'active' || row.expansionState === 'pending')) {
    reasons.push({ code: 'expansion-unwanted', label: 'Above 75% influence, expansion unwanted', score: 25 });
  }

  return reasons;
}

/** Computes the full priority assessment for one row. `nowMs` is injectable, for tests. */
export function computePriorityAssessment(row: BgsRow, nowMs: number = Date.now()): PriorityAssessment {
  const { scope, leadFaction } = resolveScope(row);

  if (scope === 'out-of-scope') {
    return {
      tier: 'out-of-scope',
      scope,
      leadFaction: null,
      score: null,
      reasons: [{ code: 'out-of-scope', label: `Preferred faction is ${row.preferredFaction} — hands off`, score: 0 }],
      needsRecon: false,
    };
  }

  const leadInfluence = influenceOf(row, leadFaction);
  const weight = factionCountWeight(row.factions.length);

  let reasons: PriorityReason[] = leadFaction ? baseReasons(row, leadFaction, leadInfluence, weight, scope) : [];
  if (scope === 'assumed') {
    // Never rank a push for control off an assumption nobody has confirmed with the architect.
    reasons = reasons.filter(r => r.code !== 'should-control-under-10' && r.code !== 'should-control-10-plus');
  }
  if (reasons.length === 0) {
    reasons = [{ code: 'none', label: 'Nothing applicable', score: 5 }];
  }
  reasons.sort((a, b) => b.score - a.score);

  const baseScore = reasons[0].score;
  const updatedAtMs = parseUpdatedAt(row.updatedAt);
  const daysSinceUpdate = updatedAtMs === null ? null : daysElapsed(updatedAtMs, nowMs);
  const factor = reconFactor(daysSinceUpdate);
  const finalScore = Math.min(100, baseScore + baseScore * factor);

  return {
    tier: deriveTier(finalScore),
    scope,
    leadFaction,
    score: finalScore,
    reasons,
    needsRecon: factor > 0,
  };
}

/**
 * The sort key for the Priority column. A confirmed lead (in-scope: the Architect Registry
 * names Canonn or CDSR) always outranks an assumed one, regardless of score — an assumed
 * lead is a guess, and shouldn't out-sort a system we actually know we're responsible for.
 * Out-of-scope stays null, sorting last either direction via the table's existing
 * null-last convention (see `compareColumnValues`).
 */
export function prioritySortKey(assessment: PriorityAssessment): number | null {
  if (assessment.score === null) {
    return null;
  }
  const scopeRank = assessment.scope === 'in-scope' ? 1 : 0;
  return scopeRank * 1000 + assessment.score;
}
