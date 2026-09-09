import { CANONN_FACTION, CDSR_FACTION, BgsRow } from '../canonn-bgs.service';
import {
  computePriorityAssessment,
  deriveTier,
  factionCountWeight,
  prioritySortKey,
  reconFactor,
  resolveScope,
} from './priority';

/** A minimal, fully-populated row — tests override only the fields they care about. */
function row(overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName: 'Test System',
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    factions: [],
    warState: null,
    warDetails: null,
    warIsCanonnVsCanonn: false,
    electionState: null,
    electionDetails: null,
    electionIsCanonnVsCanonn: false,
    retreatState: null,
    retreatDetails: null,
    expansionState: null,
    bodyCount: null,
    population: null,
    x: 0,
    y: 0,
    z: 0,
    updatedAt: null,
    ...overrides,
  };
}

describe('resolveScope', () => {
  it('is in-scope with Canonn as lead when the preferred faction is Canonn', () => {
    expect(resolveScope(row({ preferredFaction: 'Canonn' }))).toEqual({ scope: 'in-scope', leadFaction: CANONN_FACTION });
  });

  it('is in-scope with CDSR as lead when the preferred faction is CDSR', () => {
    expect(resolveScope(row({ preferredFaction: CDSR_FACTION }))).toEqual({ scope: 'in-scope', leadFaction: CDSR_FACTION });
  });

  it('matches the preferred faction case- and whitespace-insensitively', () => {
    expect(resolveScope(row({ preferredFaction: '  canonn  ' }))).toEqual({ scope: 'in-scope', leadFaction: CANONN_FACTION });
    expect(resolveScope(row({ preferredFaction: 'CANONN DEEP SPACE RESEARCH' }))).toEqual({ scope: 'in-scope', leadFaction: CDSR_FACTION });
  });

  it('is out-of-scope when the preferred faction is a third party', () => {
    expect(resolveScope(row({ preferredFaction: 'Varati Ring' }))).toEqual({ scope: 'out-of-scope', leadFaction: null });
  });

  it('is in-scope with Canonn as lead by default policy when marked "not a colony" with no preference', () => {
    expect(resolveScope(row({ notAColony: true }))).toEqual({ scope: 'in-scope', leadFaction: CANONN_FACTION });
  });

  it('is "assumed" when there is no confirmed preference, leading from whichever faction is present', () => {
    expect(resolveScope(row({ canonnInfluence: 10 }))).toEqual({ scope: 'assumed', leadFaction: CANONN_FACTION });
    expect(resolveScope(row({ cdsrInfluence: 10 }))).toEqual({ scope: 'assumed', leadFaction: CDSR_FACTION });
  });

  it('picks the higher-influence faction when both are present with no confirmed preference', () => {
    expect(resolveScope(row({ canonnInfluence: 20, cdsrInfluence: 5 }))).toEqual({ scope: 'assumed', leadFaction: CANONN_FACTION });
    expect(resolveScope(row({ canonnInfluence: 5, cdsrInfluence: 20 }))).toEqual({ scope: 'assumed', leadFaction: CDSR_FACTION });
  });

  it('is "assumed" with no lead when neither faction is present', () => {
    expect(resolveScope(row())).toEqual({ scope: 'assumed', leadFaction: null });
  });

  it('is "no-preference" when an architect is confirmed but left the faction preference blank', () => {
    // Distinct from "no registry row at all": someone has already looked at this system, so
    // there's no reason to guess a lead from influence presence the way "assumed" does.
    expect(resolveScope(row({ architect: 'Some Commander', canonnInfluence: 10 }))).toEqual({
      scope: 'no-preference',
      leadFaction: null,
    });
  });
});

describe('factionCountWeight', () => {
  it('weights small systems least severely', () => {
    expect(factionCountWeight(1)).toBe(0.25);
    expect(factionCountWeight(3)).toBe(0.25);
  });

  it('scales up through the middle bands', () => {
    expect(factionCountWeight(4)).toBe(0.5);
    expect(factionCountWeight(5)).toBe(0.75);
  });

  it('weights crowded systems at full severity', () => {
    expect(factionCountWeight(6)).toBe(1.0);
    expect(factionCountWeight(10)).toBe(1.0);
  });
});

describe('deriveTier', () => {
  it('is P0 at and above 85', () => {
    expect(deriveTier(85)).toBe('P0');
    expect(deriveTier(100)).toBe('P0');
  });

  it('is P1 from 65 up to just under 85', () => {
    expect(deriveTier(84.9)).toBe('P1');
    expect(deriveTier(65)).toBe('P1');
  });

  it('is P2 from 40 up to just under 65', () => {
    expect(deriveTier(64.9)).toBe('P2');
    expect(deriveTier(40)).toBe('P2');
  });

  it('is P3 from 20 up to just under 40', () => {
    expect(deriveTier(39.9)).toBe('P3');
    expect(deriveTier(20)).toBe('P3');
  });

  it('is P4 below 20', () => {
    expect(deriveTier(19.9)).toBe('P4');
    expect(deriveTier(0)).toBe('P4');
  });
});

describe('reconFactor', () => {
  it('is 0 for a current reading (0-1 days)', () => {
    expect(reconFactor(0)).toBe(0);
    expect(reconFactor(1)).toBe(0);
  });

  it('is 0.10 for 2-6 days', () => {
    expect(reconFactor(2)).toBe(0.1);
    expect(reconFactor(6)).toBe(0.1);
  });

  it('is 0.20 for 7-27 days', () => {
    expect(reconFactor(7)).toBe(0.2);
    expect(reconFactor(27)).toBe(0.2);
  });

  it('is 0.30 at 28+ days', () => {
    expect(reconFactor(28)).toBe(0.3);
    expect(reconFactor(365)).toBe(0.3);
  });

  it('is 0.30 when there is no timestamp at all', () => {
    expect(reconFactor(null)).toBe(0.3);
  });
});

describe('computePriorityAssessment', () => {
  const NOW = Date.parse('2026-09-09T12:00:00Z');

  it('is out-of-scope with a null score (sorts last) when the preferred faction is a third party', () => {
    const assessment = computePriorityAssessment(row({ preferredFaction: 'Varati Ring' }), NOW);
    expect(assessment.tier).toBe('out-of-scope');
    expect(assessment.score).toBeNull();
    expect(assessment.needsRecon).toBe(false);
  });

  it('is "not-applicable" with a null score, excluded entirely, when an architect is confirmed but no faction is preferred', () => {
    // Even an active war/retreat must not surface here — a confirmed architect with a blank
    // preference is a different situation from "no registry row at all" and isn't guessed at.
    const assessment = computePriorityAssessment(
      row({ architect: 'Some Commander', canonnInfluence: 10, warState: 'active', retreatState: 'active' }),
      NOW,
    );
    expect(assessment.tier).toBe('not-applicable');
    expect(assessment.scope).toBe('no-preference');
    expect(assessment.score).toBeNull();
    expect(assessment.needsRecon).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
  });

  it('scores an active retreat at 100 (P0), unweighted, outranking an active war', () => {
    // A current updatedAt keeps the recon bonus at 0, isolating the base trigger comparison
    // from FR-5's staleness amplification (which would otherwise cap both at 100).
    const current = '2026-09-09 11:00:00+00';
    const retreating = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        retreatState: 'active',
        factions: [{ name: 'Canonn', influencePercent: 2 }],
        updatedAt: current,
      }),
      NOW,
    );
    expect(retreating.tier).toBe('P0');
    expect(retreating.score).toBe(100);
    expect(retreating.reasons[0].code).toBe('retreat');

    const atWar = computePriorityAssessment(row({ preferredFaction: 'Canonn', warState: 'active', updatedAt: current }), NOW);
    expect(retreating.score!).toBeGreaterThan(atWar.score!);
  });

  it('weights a low-influence lead trigger by how many factions share the system', () => {
    const smallSystem = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 3,
        factions: [
          { name: 'A', influencePercent: 50 },
          { name: 'Canonn', influencePercent: 3 },
          { name: 'B', influencePercent: 47 },
        ],
      }),
      NOW,
    );
    const crowdedSystem = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 3,
        factions: [
          { name: 'A', influencePercent: 20 },
          { name: 'B', influencePercent: 20 },
          { name: 'C', influencePercent: 20 },
          { name: 'D', influencePercent: 20 },
          { name: 'E', influencePercent: 14 },
          { name: 'Canonn', influencePercent: 3 },
        ],
      }),
      NOW,
    );
    // 3-faction system: 0.25 weight; 6-faction system: 1.0 weight — same raw trigger, very different severity.
    expect(smallSystem.score!).toBeLessThan(crowdedSystem.score!);
  });

  it('does not treat a healthy-influence assumed lead as at-risk just for being nominally last in a small system', () => {
    // No confirmed preference (assumed scope): only two rivals to beat — "last of three" at a
    // comfortable 28% is not remotely at risk of the 2.5% retreat floor, and there's no
    // confirmed registry answer to justify pushing for control off a guess either. Must not
    // score any different from "nothing applicable".
    const healthyButLast = computePriorityAssessment(
      row({
        canonnInfluence: 28,
        factions: [
          { name: 'Rival A', influencePercent: 40 },
          { name: 'Rival B', influencePercent: 32 },
          { name: 'Canonn', influencePercent: 28 },
        ],
        updatedAt: '2026-09-09 11:00:00+00',
      }),
      NOW,
    );
    expect(healthyButLast.scope).toBe('assumed');
    expect(healthyButLast.reasons.some(r => r.code === 'lead-lowest-ranked')).toBe(false);
    expect(healthyButLast.reasons.some(r => r.code === 'confirmed-lead-lowest-should-control')).toBe(false);
    expect(healthyButLast.score).toBe(5);

    // A crowded system that's genuinely fine (nothing below any threshold, not last) must not
    // rank below the small system above — this was the reported bug: a comfortable 3-faction
    // system outranking an equally-fine, more populous one purely from the rank position.
    const quietCrowded = computePriorityAssessment(
      row({
        canonnInfluence: 15,
        factions: [
          { name: 'A', influencePercent: 20 },
          { name: 'B', influencePercent: 18 },
          { name: 'C', influencePercent: 17 },
          { name: 'D', influencePercent: 16 },
          { name: 'Canonn', influencePercent: 15 },
          { name: 'E', influencePercent: 14 },
        ],
        updatedAt: '2026-09-09 11:00:00+00',
      }),
      NOW,
    );
    expect(quietCrowded.score).toBe(5);
    expect(healthyButLast.score).toBe(quietCrowded.score);
  });

  it('prioritises taking control when our faction is weakest in a confirmed (in-scope) system of 4+ factions, even at a healthy influence', () => {
    const confirmedButLast = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 20,
        factions: [
          { name: 'Rival A', influencePercent: 30 },
          { name: 'Rival B', influencePercent: 28 },
          { name: 'Rival C', influencePercent: 22 },
          { name: 'Canonn', influencePercent: 20 },
        ],
        updatedAt: '2026-09-09 11:00:00+00',
      }),
      NOW,
    );
    expect(confirmedButLast.scope).toBe('in-scope');
    expect(confirmedButLast.reasons[0]).toMatchObject({ code: 'confirmed-lead-lowest-should-control', score: 60 });
    expect(confirmedButLast.score).toBe(60);
  });

  it('does not push for control off "lowest of three" even in a confirmed system — only 4+ factions', () => {
    const confirmedButLastOfThree = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 28,
        factions: [
          { name: 'Rival A', influencePercent: 40 },
          { name: 'Rival B', influencePercent: 32 },
          { name: 'Canonn', influencePercent: 28 },
        ],
        updatedAt: '2026-09-09 11:00:00+00',
      }),
      NOW,
    );
    expect(confirmedButLastOfThree.reasons.some(r => r.code === 'confirmed-lead-lowest-should-control')).toBe(false);
    expect(confirmedButLastOfThree.score).toBe(5);
  });

  it('is not a close-control race when the "runner-up" is our own other faction, not a rival', () => {
    // Canonn 46.5%, CDSR 40%, one rival with the remainder — Canonn holds both of the top two
    // slots. The real margin against the only actual rival (13.5%) is a commanding 33%, not
    // the 6.5% gap to CDSR, so no control-margin trigger should fire at all.
    const assessment = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 46.5,
        cdsrInfluence: 40,
        controllingFaction: 'Canonn',
        factions: [
          { name: 'Canonn', influencePercent: 46.5 },
          { name: 'Canonn Deep Space Research', influencePercent: 40 },
          { name: 'Rival', influencePercent: 13.5 },
        ],
        updatedAt: '2026-09-09 11:00:00+00',
      }),
      NOW,
    );
    expect(assessment.reasons.some(r => r.code.startsWith('control-margin'))).toBe(false);
    expect(assessment.score).toBe(5);
    expect(assessment.tier).toBe('P4');
  });

  it('never ranks a push for control when the lead faction is only assumed, not confirmed', () => {
    const assumed = computePriorityAssessment(
      row({
        canonnInfluence: 5,
        controllingFaction: 'Third Party',
        factions: [
          { name: 'Third Party', influencePercent: 90 },
          { name: 'Canonn', influencePercent: 5 },
        ],
      }),
      NOW,
    );
    expect(assumed.reasons.some(r => r.code.startsWith('should-control'))).toBe(false);
  });

  it('applies the recon bonus proportionally, so a stale-but-troubled system climbs', () => {
    const staleTroubled = computePriorityAssessment(
      row({ preferredFaction: 'Canonn', canonnInfluence: 9, updatedAt: '2026-07-01 12:00:00+00' }),
      NOW,
    );
    const currentTroubled = computePriorityAssessment(
      row({ preferredFaction: 'Canonn', canonnInfluence: 9, updatedAt: '2026-09-09 11:00:00+00' }),
      NOW,
    );
    expect(staleTroubled.needsRecon).toBe(true);
    expect(staleTroubled.score!).toBeGreaterThan(currentTroubled.score!);
    // A stale reading must never outrank a current, genuinely worse one.
    const currentRetreat = computePriorityAssessment(
      row({ preferredFaction: 'Canonn', retreatState: 'active', updatedAt: '2026-09-09 11:00:00+00' }),
      NOW,
    );
    expect(currentRetreat.score!).toBeGreaterThan(staleTroubled.score!);
  });

  it('never applies staleness to an out-of-scope row', () => {
    const assessment = computePriorityAssessment(
      row({ preferredFaction: 'Varati Ring', updatedAt: '2026-01-01 00:00:00+00' }),
      NOW,
    );
    expect(assessment.needsRecon).toBe(false);
    expect(assessment.score).toBeNull();
  });

  it('falls back to the "nothing applicable" floor when no trigger matches', () => {
    const assessment = computePriorityAssessment(
      row({ preferredFaction: 'Canonn', canonnInfluence: 95, updatedAt: '2026-09-09 11:00:00+00' }),
      NOW,
    );
    expect(assessment.reasons[0].code).toBe('none');
    expect(assessment.score).toBe(5);
    expect(assessment.tier).toBe('P4');
  });
});

describe('prioritySortKey', () => {
  const NOW = Date.parse('2026-09-09T12:00:00Z');
  const current = '2026-09-09 11:00:00+00'; // keeps the recon bonus at 0, isolating scope ordering.

  it('ranks a confirmed lead (in-scope) above an assumed one, even with a much worse score', () => {
    // In-scope but nothing is wrong: floor score of 5.
    const confirmedQuiet = computePriorityAssessment(row({ preferredFaction: 'Canonn', updatedAt: current }), NOW);
    // Assumed, but in active retreat: the highest possible score, 100.
    const assumedRetreating = computePriorityAssessment(
      row({ canonnInfluence: 5, retreatState: 'active', updatedAt: current }),
      NOW,
    );
    expect(confirmedQuiet.scope).toBe('in-scope');
    expect(assumedRetreating.scope).toBe('assumed');
    expect(prioritySortKey(confirmedQuiet)!).toBeGreaterThan(prioritySortKey(assumedRetreating)!);
  });

  it('still orders by score within the same scope', () => {
    const worse = computePriorityAssessment(row({ preferredFaction: 'Canonn', warState: 'active', updatedAt: current }), NOW);
    const better = computePriorityAssessment(row({ preferredFaction: 'Canonn', updatedAt: current }), NOW);
    expect(prioritySortKey(worse)!).toBeGreaterThan(prioritySortKey(better)!);
  });

  it('is null for out-of-scope, sorting last regardless of direction', () => {
    const assessment = computePriorityAssessment(row({ preferredFaction: 'Varati Ring' }), NOW);
    expect(prioritySortKey(assessment)).toBeNull();
  });
});
