import { CANONN_FACTION, CDSR_FACTION, BgsRow } from '../canonn-bgs.service';
import { AFFILIATION_CANONN_MEMBER, AFFILIATION_NOT_A_COLONY } from './architect-form';
import { computeAtlasStats } from './atlas-stats';

/** A minimal, fully-populated {@link BgsRow}, with only the fields a test cares about overridden. */
function row(overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName: 'Test System',
    systemAddress: '1',
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    preferredFactionRecorded: false,
    hasCanonnStation: false,
    stationCount: 0,
    factions: [],
    canonnHistory: [],
    cdsrHistory: [],
    influenceAverages: {},
    canonnChange: null,
    cdsrChange: null,
    factionDetails: [],
    stations: [],
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
    watchlist: [],
    priority: {
      tier: 'not-applicable',
      mode: null,
      leadFaction: null,
      score: null,
      reasons: [],
      needsRecon: false,
      reconAgeDays: null,
    },
    powerplay: null,
    ...overrides,
  };
}

const f = (name: string, influencePercent: number) => ({ name, influencePercent });
const NOW = new Date('2026-10-18T00:00:00Z').getTime();

describe('computeAtlasStats', () => {
  it('groups by recorded preference only, ignoring a preference derived from a Canonn-named station', () => {
    const stats = computeAtlasStats(
      [
        row({ preferredFaction: CANONN_FACTION, preferredFactionRecorded: true, architect: 'A' }),
        row({ preferredFaction: CANONN_FACTION, preferredFactionRecorded: false }),
        row({ preferredFaction: CDSR_FACTION, preferredFactionRecorded: true, notAColony: true }),
        row({ preferredFaction: 'Someone Else', preferredFactionRecorded: true, architect: 'B' }),
      ],
      NOW,
    );
    expect(stats.prefCounts).toEqual({ C: 1, D: 1, O: 1, U: 1 });
    expect(stats.withRecord).toBe(3);
    expect(stats.coverage.find((c) => c.group === 'U')).toEqual({
      group: 'U',
      total: 1,
      named: 0,
      notColony: 0,
      none: 1,
    });
  });

  it('tallies architect affiliation answers, counting a named architect with no answer as unknown', () => {
    const stats = computeAtlasStats(
      [
        row({ architect: 'A', architectAffiliation: AFFILIATION_CANONN_MEMBER }),
        row({ architect: 'B' }),
        row({ notAColony: true, architectAffiliation: AFFILIATION_NOT_A_COLONY }),
        row(),
      ],
      NOW,
    );
    expect(stats.affiliation).toEqual({
      member: 1,
      notMember: 0,
      unknown: 1,
      notColony: 1,
      none: 1,
    });
  });

  it('finds untouched colonies with Canonn or CDSR third on the founding split and no architect record', () => {
    const founding = [f('Leader', 60), f('Second', 20), f(CANONN_FACTION, 13), f('Fourth', 7)];
    const stats = computeAtlasStats(
      [
        row({ systemName: 'Untouched', factions: founding, canonnInfluence: 13 }),
        row({
          systemName: 'Has architect',
          factions: founding,
          canonnInfluence: 13,
          architect: 'A',
        }),
        row({
          systemName: 'Worked',
          factions: founding,
          canonnInfluence: 13,
          canonnHistory: [10, 13],
        }),
        row({
          systemName: 'Not third',
          factions: [f(CANONN_FACTION, 60), f('Second', 20), f('Third', 13)],
          canonnInfluence: 60,
        }),
      ],
      NOW,
    );
    expect(stats.recon.map((r) => r.name)).toEqual(['Untouched']);
    expect(stats.recon[0]).toMatchObject({ us: 'C', exact: true, ledByUs: false });
  });

  it('treats retreat as possible only with more than three factions', () => {
    const stats = computeAtlasStats(
      [
        row({
          systemName: 'Three',
          canonnInfluence: 2,
          factions: [f('A', 60), f('B', 38), f(CANONN_FACTION, 2)],
        }),
        row({
          systemName: 'Four',
          canonnInfluence: 3,
          factions: [f('A', 60), f('B', 30), f('C', 7), f(CANONN_FACTION, 3)],
        }),
      ],
      NOW,
    );
    expect(stats.retreatProof).toBe(1);
    expect(stats.lowInfluence.map((l) => [l.name, l.retreatPossible])).toEqual([
      ['Four', true],
      ['Three', false],
    ]);
  });

  it('measures control margins and the home-system bands', () => {
    const stats = computeAtlasStats(
      [
        row({
          controllingFaction: CANONN_FACTION,
          preferredFaction: CANONN_FACTION,
          preferredFactionRecorded: true,
          factions: [f(CANONN_FACTION, 60), f('B', 20)],
        }),
        row({
          controllingFaction: CANONN_FACTION,
          preferredFaction: CANONN_FACTION,
          preferredFactionRecorded: true,
          factions: [f(CANONN_FACTION, 40), f('B', 37)],
        }),
        row({ controllingFaction: CDSR_FACTION, factions: [f(CDSR_FACTION, 50), f('B', 40)] }),
      ],
      NOW,
    );
    expect(stats.margins.map((m) => m.margin)).toEqual([40, 3, 10]);
    expect(stats.homeBands).toEqual({ total: 2, close: 1, middle: 0, healthy: 1 });
  });

  it('lists Canonn-named stations by who runs them, stripping the construction-site prefix', () => {
    const stats = computeAtlasStats(
      [
        row({
          systemName: 'S',
          stations: [
            { name: 'Canonn Spire', type: 'Planetary Port', controllingFaction: CANONN_FACTION },
            {
              name: 'Orbital Construction Site: Canonn Lab',
              type: 'Space Construction Depot',
              controllingFaction: 'Brewer Corporation',
            },
            {
              name: 'Canonn Biscuit Centre',
              type: 'Outpost',
              controllingFaction: 'Friendly Faction',
            },
            { name: 'Plain Station', type: 'Outpost', controllingFaction: CANONN_FACTION },
          ],
        }),
      ],
      NOW,
    );
    expect(stats.named.map((n) => [n.name, n.owner])).toEqual([
      ['Canonn Biscuit Centre', 'O'],
      ['Canonn Spire', 'C'],
      ['Canonn Lab', 'B'],
    ]);
  });

  it('counts systems last seen more than 30 days ago', () => {
    const stats = computeAtlasStats(
      [
        row({ updatedAt: '2026-10-17T00:00:00Z' }),
        row({ updatedAt: '2026-08-01T00:00:00Z' }),
        row({ updatedAt: null }),
      ],
      NOW,
    );
    expect(stats.stale.over30).toBe(1);
  });
});
