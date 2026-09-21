import { CANONN_FACTION, CDSR_FACTION, BgsRow } from '../canonn-bgs.service';
import {
  computePriorityAssessment,
  costToClose,
  deriveTier,
  factionCountWeight,
  needsRecon,
  populationCostFactor,
  prioritySortKey,
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

describe('needsRecon', () => {
  it('is false for a reading 0-1 days old', () => {
    expect(needsRecon(0)).toBe(false);
    expect(needsRecon(1)).toBe(false);
  });

  it('is true from 2 days old', () => {
    expect(needsRecon(2)).toBe(true);
    expect(needsRecon(365)).toBe(true);
  });

  it('is true when there is no timestamp at all', () => {
    expect(needsRecon(null)).toBe(true);
  });
});

describe('populationCostFactor', () => {
  it('is 1 (no discount) when population is unknown', () => {
    expect(populationCostFactor(null)).toBe(1);
  });

  it('stays close to 1 for a small population', () => {
    expect(populationCostFactor(1_000)).toBeCloseTo(1 - Math.log10(1_000) / 10.875, 5);
  });

  it('floors at 0.025 for a huge population', () => {
    expect(populationCostFactor(1_000_000_000_000)).toBe(0.025);
  });

  it('is lower (more discounted, i.e. more expensive) for a bigger population', () => {
    expect(populationCostFactor(1_000_000)).toBeLessThan(populationCostFactor(1_000));
  });
});

describe('costToClose', () => {
  it('equals the raw gap when population is unknown', () => {
    expect(costToClose(20, null)).toBe(20);
  });

  it('is higher for the same gap in a bigger population', () => {
    expect(costToClose(20, 1_000_000_000)).toBeGreaterThan(costToClose(20, 1_000));
  });

  it('is 0 for a 0 gap regardless of population', () => {
    expect(costToClose(0, 1_000_000_000)).toBe(0);
  });
});

describe('computePriorityAssessment', () => {
  const NOW = Date.parse('2026-09-09T12:00:00Z');
  const current = '2026-09-09 11:00:00+00'; // keeps needsRecon false, isolating the trigger under test.

  it('is out-of-scope with a null score (sorts last) when the preferred faction is a third party and there is no live conflict', () => {
    const assessment = computePriorityAssessment(row({ preferredFaction: 'Varati Ring' }), NOW);
    expect(assessment.tier).toBe('out-of-scope');
    expect(assessment.score).toBeNull();
    expect(assessment.needsRecon).toBe(false);
  });

  it('is "not-applicable" with a null score when an architect is confirmed, no faction preferred, and there is no live conflict', () => {
    const assessment = computePriorityAssessment(row({ architect: 'Some Commander', canonnInfluence: 10 }), NOW);
    expect(assessment.tier).toBe('not-applicable');
    expect(assessment.scope).toBe('no-preference');
    expect(assessment.score).toBeNull();
    expect(assessment.needsRecon).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
  });

  it('surfaces an active conflict even when the preferred faction is a third party (out-of-scope)', () => {
    // FR: a live, time-limited war/election shouldn't be hidden purely for want of a recorded
    // preferred faction — it must get a real tier/score, not the usual null-score exclusion.
    const assessment = computePriorityAssessment(row({ preferredFaction: 'Varati Ring', warState: 'active', updatedAt: current }), NOW);
    expect(assessment.tier).toBe('P0');
    expect(assessment.score).toBe(95);
    expect(assessment.reasons.some(r => r.code === 'war-active')).toBe(true);
    expect(assessment.reasons.some(r => r.code === 'out-of-scope')).toBe(true);
  });

  it('surfaces a pending conflict even when an architect is confirmed with no faction preference', () => {
    const assessment = computePriorityAssessment(
      row({ architect: 'Some Commander', electionState: 'pending', updatedAt: current }),
      NOW,
    );
    expect(assessment.tier).toBe('P0');
    expect(assessment.score).toBe(85);
    expect(assessment.reasons.some(r => r.code === 'election-pending')).toBe(true);
  });

  it('scores an active retreat at 100 (P0), unweighted, outranking an active war', () => {
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
        updatedAt: current,
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
        updatedAt: current,
      }),
      NOW,
    );
    // 3-faction system: 0.25 weight; 6-faction system: 1.0 weight — same raw trigger, very different severity.
    expect(smallSystem.score!).toBeLessThan(crowdedSystem.score!);
  });

  it('does not treat a healthy-influence assumed lead as at-risk just for being nominally last in a small system', () => {
    const healthyButLast = computePriorityAssessment(
      row({
        canonnInfluence: 28,
        factions: [
          { name: 'Rival A', influencePercent: 40 },
          { name: 'Rival B', influencePercent: 32 },
          { name: 'Canonn', influencePercent: 28 },
        ],
        updatedAt: current,
      }),
      NOW,
    );
    expect(healthyButLast.scope).toBe('assumed');
    expect(healthyButLast.reasons.some(r => r.code === 'lead-lowest-ranked')).toBe(false);
    expect(healthyButLast.reasons.some(r => r.code === 'lead-lowest-should-control')).toBe(false);
    expect(healthyButLast.score).toBe(5);

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
        updatedAt: current,
      }),
      NOW,
    );
    expect(quietCrowded.score).toBe(5);
    expect(healthyButLast.score).toBe(quietCrowded.score);
  });

  it('sends a Canonn-preferred system to P0 when our faction is weakest of 4+, even at a healthy influence — safety before control', () => {
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
        updatedAt: current,
      }),
      NOW,
    );
    expect(confirmedButLast.scope).toBe('in-scope');
    expect(confirmedButLast.reasons[0]).toMatchObject({ code: 'lead-lowest-should-control', score: 90 });
    expect(confirmedButLast.score).toBe(90);
    expect(confirmedButLast.tier).toBe('P0');
  });

  it('also sends a CDSR-preferred system to P0 when our faction is weakest of 4+ — the trigger fires for either of our own factions', () => {
    const cdsrButLast = computePriorityAssessment(
      row({
        preferredFaction: CDSR_FACTION,
        cdsrInfluence: 20,
        factions: [
          { name: 'Rival A', influencePercent: 30 },
          { name: 'Rival B', influencePercent: 28 },
          { name: 'Rival C', influencePercent: 22 },
          { name: CDSR_FACTION, influencePercent: 20 },
        ],
        updatedAt: current,
      }),
      NOW,
    );
    expect(cdsrButLast.scope).toBe('in-scope');
    expect(cdsrButLast.reasons[0]).toMatchObject({ code: 'lead-lowest-should-control', score: 90 });
    expect(cdsrButLast.score).toBe(90);
    expect(cdsrButLast.tier).toBe('P0');
  });

  it('does not fire the last-place trigger in an assumed (unconfirmed) system of 4+ factions — only an explicit preference counts', () => {
    const assumedButLast = computePriorityAssessment(
      row({
        canonnInfluence: 20,
        factions: [
          { name: 'Rival A', influencePercent: 30 },
          { name: 'Rival B', influencePercent: 28 },
          { name: 'Rival C', influencePercent: 22 },
          { name: 'Canonn', influencePercent: 20 },
        ],
        updatedAt: current,
      }),
      NOW,
    );
    expect(assumedButLast.scope).toBe('assumed');
    expect(assumedButLast.reasons.some(r => r.code === 'lead-lowest-should-control')).toBe(false);
    expect(assumedButLast.score).toBe(5);
  });

  it('does not push for control off "lowest of three" even in a Canonn-preferred system — only 4+ factions', () => {
    const confirmedButLastOfThree = computePriorityAssessment(
      row({
        preferredFaction: 'Canonn',
        canonnInfluence: 28,
        factions: [
          { name: 'Rival A', influencePercent: 40 },
          { name: 'Rival B', influencePercent: 32 },
          { name: 'Canonn', influencePercent: 28 },
        ],
        updatedAt: current,
      }),
      NOW,
    );
    expect(confirmedButLastOfThree.reasons.some(r => r.code === 'lead-lowest-should-control')).toBe(false);
    expect(confirmedButLastOfThree.score).toBe(5);
  });

  it('is not a close-control race when the "runner-up" is our own other faction, not a rival', () => {
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
        updatedAt: current,
      }),
      NOW,
    );
    expect(assessment.reasons.some(r => r.code.startsWith('control-margin'))).toBe(false);
    expect(assessment.score).toBe(5);
    expect(assessment.tier).toBe('P4');
  });

  it('never ranks a push for control (gap-to-leader) when the lead faction is only assumed, not confirmed', () => {
    const assumed = computePriorityAssessment(
      row({
        canonnInfluence: 5,
        controllingFaction: 'Third Party',
        factions: [
          { name: 'Third Party', influencePercent: 90 },
          { name: 'Canonn', influencePercent: 5 },
        ],
        updatedAt: current,
      }),
      NOW,
    );
    expect(assumed.reasons.some(r => r.code === 'gap-to-leader')).toBe(false);
  });

  it('falls back to the "nothing applicable" floor when no trigger matches', () => {
    const assessment = computePriorityAssessment(
      row({ preferredFaction: 'Canonn', canonnInfluence: 95, updatedAt: current }),
      NOW,
    );
    expect(assessment.reasons[0].code).toBe('none');
    expect(assessment.score).toBe(5);
    expect(assessment.tier).toBe('P4');
  });

  describe('gap-to-leader (work priority, population-weighted)', () => {
    it('ranks a system level with the leader above one 20+ points behind, all else equal', () => {
      const levelWithLeader = computePriorityAssessment(
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 30,
          controllingFaction: 'Rival',
          population: 189_000,
          factions: [
            { name: 'Rival', influencePercent: 30 },
            { name: 'Canonn', influencePercent: 30 },
          ],
          updatedAt: current,
        }),
        NOW,
      );
      const farBehindLeader = computePriorityAssessment(
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 30,
          controllingFaction: 'Rival',
          population: 189_000,
          factions: [
            { name: 'Rival', influencePercent: 50.6 },
            { name: 'Canonn', influencePercent: 30 },
          ],
          updatedAt: current,
        }),
        NOW,
      );
      expect(levelWithLeader.score!).toBeGreaterThan(farBehindLeader.score!);
    });

    it('scores the same gap lower (more work) in a much bigger population', () => {
      const smallPop = computePriorityAssessment(
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 10,
          controllingFaction: 'Rival',
          population: 1_000,
          factions: [
            { name: 'Rival', influencePercent: 30 },
            { name: 'Canonn', influencePercent: 10 },
          ],
          updatedAt: current,
        }),
        NOW,
      );
      const hugePop = computePriorityAssessment(
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 10,
          controllingFaction: 'Rival',
          population: 6_600_000_000,
          factions: [
            { name: 'Rival', influencePercent: 30 },
            { name: 'Canonn', influencePercent: 10 },
          ],
          updatedAt: current,
        }),
        NOW,
      );
      expect(hugePop.score!).toBeLessThan(smallPop.score!);
    });

    it('floors an unwinnable gap (huge population, wide gap) at the same baseline as a quiet system, never negative', () => {
      // Canonn's own influence (25%) stays clear of the low-influence risk thresholds below
      // 10%, so the only applicable trigger left is the gap-to-leader one under test.
      const unwinnable = computePriorityAssessment(
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 25,
          controllingFaction: 'Rival',
          population: 6_600_000_000,
          factions: [
            { name: 'Rival', influencePercent: 80 },
            { name: 'Canonn', influencePercent: 25 },
          ],
          updatedAt: current,
        }),
        NOW,
      );
      expect(unwinnable.reasons[0].code).toBe('gap-to-leader');
      expect(unwinnable.score).toBe(5);
    });

    it('two systems with the same gap and population rank equally regardless of when they were last seen', () => {
      const buildRow = (updatedAt: string | null) =>
        row({
          preferredFaction: 'Canonn',
          canonnInfluence: 20,
          controllingFaction: 'Rival',
          population: 1_000_000,
          factions: [
            { name: 'Rival', influencePercent: 35 },
            { name: 'Canonn', influencePercent: 20 },
          ],
          updatedAt,
        });
      const fresh = computePriorityAssessment(buildRow(current), NOW);
      const stale = computePriorityAssessment(buildRow('2026-01-01 00:00:00+00'), NOW);
      const unknown = computePriorityAssessment(buildRow(null), NOW);

      expect(fresh.score).toBe(stale.score);
      expect(fresh.score).toBe(unknown.score);
      expect(stale.needsRecon).toBe(true);
      expect(unknown.needsRecon).toBe(true);
      expect(fresh.needsRecon).toBe(false);
    });
  });
});

describe('prioritySortKey', () => {
  const NOW = Date.parse('2026-09-09T12:00:00Z');
  const current = '2026-09-09 11:00:00+00';

  it('ranks a confirmed lead (in-scope) above an assumed one, even with a much worse score', () => {
    const confirmedQuiet = computePriorityAssessment(row({ preferredFaction: 'Canonn', updatedAt: current }), NOW);
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

  it('is null for out-of-scope with no live conflict, sorting last regardless of direction', () => {
    const assessment = computePriorityAssessment(row({ preferredFaction: 'Varati Ring' }), NOW);
    expect(prioritySortKey(assessment)).toBeNull();
  });
});
