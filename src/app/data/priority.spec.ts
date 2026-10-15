import { BgsRow } from '../canonn-bgs.service';
import {
  BgsConfig,
  NO_PRIORITY,
  PriorityInputs,
  cleanCell,
  computePriority,
  currentPriority,
  needsRecon,
} from './priority';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** The constants the API sent when this port was written. */
const CONFIG: BgsConfig = {
  tracked_names: ['Canonn', 'Canonn Deep Space Research'],
  thresholds: {
    low_influence: 0.05,
    close_gap: 0.02,
    trend_flat_per_day: 0.002,
    trend_steep_per_day: 0.01,
    trend_horizon_days: 30,
    trend_warn_days: 7,
  },
  needs_recon_hours: 48,
  placeholders: ['', '-', '--', '?', 'n/a', 'na', 'none', 'nobody', 'unknown', "don't know"],
  priority: {
    tiers: [
      { tier: 'P0', min: 85 },
      { tier: 'P1', min: 65 },
      { tier: 'P2', min: 40 },
      { tier: 'P3', min: 20 },
    ],
    history_adj_min: -10,
    history_adj_max: 20,
    score_ceiling: 99,
    gap_score_cap: 80,
    gap_score_floor: 5,
    guard_warn_pct: 3,
    guard_critical_pct: 1,
    guard_warn_days: 14,
    guard_critical_days: 7,
  },
};

/** Six factions (so the count weight is 1), Canonn leading and holding control, nothing else going on. */
function inputs(overrides: Partial<PriorityInputs> = {}): PriorityInputs {
  return {
    architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'Canonn' },
    override: null,
    current: [
      { name: 'Canonn', influence: 0.5 },
      { name: 'Rival A', influence: 0.2 },
      { name: 'Rival B', influence: 0.12 },
      { name: 'Rival C', influence: 0.1 },
      { name: 'Rival D', influence: 0.05 },
      { name: 'Rival E', influence: 0.03 },
    ],
    controller: 'Canonn',
    trends: {},
    states: [],
    conflicts: [],
    dataAgeHours: 1,
    ...overrides,
  };
}

function codes(priority: { reasons: { code: string }[] }): string[] {
  return priority.reasons.map(r => r.code);
}

describe('computePriority modes', () => {
  it('pushes for control when the preferred faction is ours', () => {
    const priority = computePriority(inputs(), CONFIG);

    expect(priority.mode).toBe('push');
    expect(priority.leadFaction).toBe('Canonn');
  });

  it('assumes a mode when there is no architect on record', () => {
    expect(computePriority(inputs({ architect: null }), CONFIG).mode).toBe('assumed');
  });

  it('treats a registry placeholder as no preference', () => {
    const priority = computePriority(
      inputs({ architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'N/A' } }),
      CONFIG,
    );

    expect(priority.mode).toBe('none');
    expect(priority.tier).toBe('not-applicable');
    expect(priority.score).toBeNull();
  });

  it('keeps hands off a system whose preferred faction is a third party', () => {
    const priority = computePriority(
      inputs({ architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'Rival A' } }),
      CONFIG,
    );

    expect(priority.mode).toBe('hands-off');
    expect(priority.tier).toBe('out-of-scope');
    expect(priority.score).toBeNull();
    expect(priority.reasons[0].label).toBe('Preferred faction is Rival A - hands off');
  });

  it('lifts a hands-off agreement when the watchlist names the preferred faction and it has slipped', () => {
    const priority = computePriority(
      inputs({
        architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'Rival D' },
        override: { faction: 'Rival D', position: 2 },
      }),
      CONFIG,
    );

    expect(priority.mode).toBe('hands-off');
    expect(codes(priority)).toEqual(['below-watchlist-position']);
    expect(priority.score).toBe(90);
  });

  it('restrains in a system that is not a colony: floors apply, but never a push for control', () => {
    const priority = computePriority(
      inputs({
        architect: { architect_name: null, canonn_architect: 'Nobody The System Is Not a Colony', preferred_faction: null },
        current: [
          { name: 'Rival A', influence: 0.6 },
          { name: 'Rival B', influence: 0.34 },
          { name: 'Canonn', influence: 0.03 },
          { name: 'Rival C', influence: 0.02 },
          { name: 'Rival D', influence: 0.01 },
        ],
        controller: 'Rival A',
      }),
      CONFIG,
    );

    expect(priority.mode).toBe('restrain');
    expect(codes(priority)).toContain('below-4');
    expect(codes(priority)).not.toContain('gap-to-leader');
  });
});

describe('computePriority triggers', () => {
  it('scores an active war from a conflict, highest, as P0', () => {
    const priority = computePriority(
      inputs({
        conflicts: [{ war_type: 'war', status: 'active', faction_a: 'Canonn', faction_b: 'Rival A', involves_us: true }],
      }),
      CONFIG,
    );

    expect(priority.score).toBe(95);
    expect(priority.tier).toBe('P0');
    expect(priority.reasons[0]).toMatchObject({ code: 'war-active', label: 'War active' });
  });

  it('reads a pending election from the factions\' states, as a bare name or an object', () => {
    const bare = computePriority(inputs({ states: [{ faction: 'Canonn', active: [], pending: ['Election'] }] }), CONFIG);
    const object = computePriority(
      inputs({ states: [{ faction: 'Canonn', active: [], pending: [{ State: 'Election', Trend: 0 }] }] }),
      CONFIG,
    );

    expect(codes(bare)).toContain('election-pending');
    expect(codes(object)).toContain('election-pending');
  });

  it('ignores a war between our own two factions', () => {
    const priority = computePriority(
      inputs({
        conflicts: [
          { war_type: 'war', status: 'active', faction_a: 'Canonn', faction_b: 'Canonn Deep Space Research', involves_us: true },
        ],
        states: [{ faction: 'Canonn', active: ['War'], pending: [] }],
      }),
      CONFIG,
    );

    expect(codes(priority)).not.toContain('war-active');
  });

  it('always chases a retreat', () => {
    const priority = computePriority(
      inputs({ states: [{ faction: 'Canonn', active: ['Retreat'], pending: [] }] }),
      CONFIG,
    );

    expect(priority.score).toBe(100);
    expect(codes(priority)[0]).toBe('retreat-active');
  });

  it('flags a conflict in a system with no architect, and asks for one before working it', () => {
    const priority = computePriority(
      inputs({ architect: null, states: [{ faction: 'Canonn', active: ['War'], pending: [] }] }),
      CONFIG,
    );

    expect(priority.mode).toBe('assumed');
    expect(priority.score).toBe(101);
    expect(codes(priority)).toContain('assumed-needs-architect');
  });

  it('scales the floor triggers down in a small system, rounding ties to the even digit', () => {
    const priority = computePriority(
      inputs({
        current: [
          { name: 'Rival A', influence: 0.9 },
          { name: 'Canonn', influence: 0.03 },
          { name: 'Rival B', influence: 0.07 },
        ],
        controller: 'Rival A',
      }),
      CONFIG,
    );

    // below-4 at 85 x 0.25 = 21.25 -> 21.2; below-6 at 70 x 0.25 = 17.5; the gap to the leader (87%) bottoms out at 5.
    const byCode = Object.fromEntries(priority.reasons.map(r => [r.code, r.score]));
    expect(byCode['below-4']).toBe(21.2);
    expect(byCode['below-6']).toBe(17.5);
    expect(byCode['gap-to-leader']).toBe(5);
  });

  it('warns when control is held by a thin margin', () => {
    const priority = computePriority(
      inputs({
        current: [
          { name: 'Canonn', influence: 0.4 },
          { name: 'Rival A', influence: 0.38 },
          { name: 'Rival B', influence: 0.12 },
          { name: 'Rival C', influence: 0.05 },
          { name: 'Rival D', influence: 0.03 },
          { name: 'Rival E', influence: 0.02 },
        ],
      }),
      CONFIG,
    );

    expect(codes(priority)).toContain('control-margin-under-3');
    expect(priority.score).toBeGreaterThanOrEqual(80);
  });

  it('puts the best reason first and derives the tier from its score', () => {
    const priority = computePriority(
      inputs({ states: [{ faction: 'Canonn', active: ['Election'], pending: [] }] }),
      CONFIG,
    );

    expect(priority.score).toBe(priority.reasons[0].score);
    expect(priority.reasons.map(r => r.score)).toEqual([...priority.reasons.map(r => r.score)].sort((a, b) => b - a));
    expect(priority.tier).toBe('P0');
  });

  it('says nothing applies when no trigger fires', () => {
    const priority = computePriority(inputs(), CONFIG);

    expect(priority.reasons).toEqual([{ code: 'none', label: 'Nothing applicable', score: 5 }]);
    expect(priority.tier).toBe('P4');
  });
});

describe('computePriority history', () => {
  const fallingFast = { Canonn: { per_day: -0.02, days_to_low: null, vs: null } };

  function lowCanonn(overrides: Partial<PriorityInputs> = {}): PriorityInputs {
    return inputs({
      current: [
        { name: 'Rival A', influence: 0.5 },
        { name: 'Rival B', influence: 0.2 },
        { name: 'Rival C', influence: 0.1 },
        { name: 'Rival D', influence: 0.09 },
        { name: 'Canonn', influence: 0.05 },
        { name: 'Rival E', influence: 0.06 },
      ],
      controller: 'Rival A',
      ...overrides,
    });
  }

  it('raises a defensive trigger for a faction whose influence is falling fast', () => {
    const steady = computePriority(lowCanonn(), CONFIG);
    const falling = computePriority(lowCanonn({ trends: fallingFast }), CONFIG);

    const below6 = (p: { reasons: { code: string; score: number }[] }) => p.reasons.find(r => r.code === 'below-6')?.score;
    expect(below6(falling)).toBe((below6(steady) as number) + 10);
  });

  it('lowers it for a faction that is recovering fast', () => {
    const steady = computePriority(lowCanonn(), CONFIG);
    const recovering = computePriority(lowCanonn({ trends: { Canonn: { per_day: 0.02 } } }), CONFIG);

    const below6 = (p: { reasons: { code: string; score: number }[] }) => p.reasons.find(r => r.code === 'below-6')?.score;
    expect(below6(recovering)).toBe((below6(steady) as number) - 10);
  });

  it('never lifts a score past the ceiling', () => {
    const priority = computePriority(
      lowCanonn({
        trends: { Canonn: { per_day: -0.05, days_to_low: 2, vs: { kind: 'lead_loss', days_to_cross: 1, against: 'Rival A' } } },
      }),
      CONFIG,
    );

    expect(Math.max(...priority.reasons.filter(r => r.code.startsWith('below')).map(r => r.score))).toBeLessThanOrEqual(99);
  });
});

describe('cleanCell', () => {
  const placeholders = new Set(CONFIG.placeholders);

  it('blanks a placeholder, whatever its case, and strips backticks and padding', () => {
    expect(cleanCell('N/A', placeholders)).toBe('');
    expect(cleanCell("  Don't Know ", placeholders)).toBe('');
    expect(cleanCell(' `Cmdr Example` ', placeholders)).toBe('Cmdr Example');
    expect(cleanCell(null, placeholders)).toBe('');
  });
});

describe('needsRecon', () => {
  it('flags an unknown age and two or more whole days, but not less', () => {
    expect(needsRecon(null)).toBe(true);
    expect(needsRecon(2)).toBe(true);
    expect(needsRecon(1)).toBe(false);
    expect(needsRecon(0)).toBe(false);
  });
});

describe('computePriority staleness', () => {
  it('flags a reading 48 hours old or older, or one that has never been seen', () => {
    expect(computePriority(inputs({ dataAgeHours: 47.9 }), CONFIG).needsRecon).toBe(false);
    expect(computePriority(inputs({ dataAgeHours: 48 }), CONFIG).needsRecon).toBe(true);
    expect(computePriority(inputs({ dataAgeHours: null }), CONFIG).needsRecon).toBe(true);
  });

  it('does not let staleness change the score', () => {
    expect(computePriority(inputs({ dataAgeHours: 500 }), CONFIG).score).toBe(computePriority(inputs(), CONFIG).score);
  });
});

describe('currentPriority', () => {
  function rowSeen(updatedAt: string | null): BgsRow {
    return {
      updatedAt,
      priority: { ...NO_PRIORITY, tier: 'P2', score: 45, needsRecon: false, reasons: [{ code: 'c', label: 'l', score: 45 }] },
    } as BgsRow;
  }

  it("keeps the computed tier, score and reasons untouched", () => {
    const priority = currentPriority(rowSeen('2026-08-07T11:00:00Z'), NOW);

    expect(priority.tier).toBe('P2');
    expect(priority.score).toBe(45);
    expect(priority.reasons).toEqual([{ code: 'c', label: 'l', score: 45 }]);
  });

  it("recomputes the recon flag and age from the row's own last-seen time", () => {
    const fresh = currentPriority(rowSeen(new Date(NOW - 3 * 60 * 60 * 1000).toISOString()), NOW);
    const stale = currentPriority(rowSeen(new Date(NOW - 3 * DAY).toISOString()), NOW);

    expect(fresh.needsRecon).toBe(false);
    expect(fresh.reconAgeDays).toBe(0);
    expect(stale.needsRecon).toBe(true);
    expect(stale.reconAgeDays).toBe(3);
  });

  it('counts a row with no last-seen time as needing recon', () => {
    const priority = currentPriority(rowSeen(null), NOW);

    expect(priority.needsRecon).toBe(true);
    expect(priority.reconAgeDays).toBeNull();
  });
});
