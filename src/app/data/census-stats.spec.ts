import { CANONN_FACTION, CDSR_FACTION, BgsRow } from '../canonn-bgs.service';
import { computeCensusStats } from './census-stats';

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
    priority: { tier: 'not-applicable', mode: null, leadFaction: null, score: null, reasons: [], needsRecon: false, reconAgeDays: null },
    powerplay: null,
    ...overrides,
  };
}

const NOW = new Date('2026-10-18T00:00:00Z').getTime();

describe('computeCensusStats', () => {
  it('counts colonies from architects with a non-placeholder name, ignoring "not a colony" answers', () => {
    const stats = computeCensusStats([
      row({ architect: 'Herix' }),
      row({ architect: 'Herix' }),
      row({ architect: 'Mohawk55a' }),
      row({ architect: null }),
      row({ architect: 'Someone', notAColony: true }),
    ]);

    expect(stats.colonies).toBe(3);
    expect(stats.architects).toEqual([
      { name: 'Herix', count: 2 },
      { name: 'Mohawk55a', count: 1 },
    ]);
  });

  it('buckets footprint by presence and controller, matching the published report\'s field names', () => {
    const stats = computeCensusStats([
      row({ canonnInfluence: 40, controllingFaction: CANONN_FACTION }), // canonnC
      row({ canonnInfluence: 10, controllingFaction: 'Someone Else' }), // canonnO
      row({ cdsrInfluence: 40, controllingFaction: CDSR_FACTION }), // cdsrD
      row({ cdsrInfluence: 10, controllingFaction: 'Someone Else' }), // cdsrO
      row({ canonnInfluence: 20, cdsrInfluence: 20, controllingFaction: CANONN_FACTION }), // bothC
      row({ canonnInfluence: 20, cdsrInfluence: 20, controllingFaction: CDSR_FACTION }), // bothD
      row({ canonnInfluence: 20, cdsrInfluence: 20, controllingFaction: 'Someone Else' }), // bothO
      row({ controllingFaction: 'Someone Else' }), // neither
    ]);

    expect(stats.footprint).toEqual({
      canonnC: 1,
      canonnO: 1,
      cdsrD: 1,
      cdsrO: 1,
      bothC: 1,
      bothD: 1,
      bothO: 1,
      neither: 1,
    });
  });

  it('scores a recorded preferred faction as got/miss by whether it controls', () => {
    const stats = computeCensusStats([
      row({ preferredFactionRecorded: true, preferredFaction: CANONN_FACTION, controllingFaction: CANONN_FACTION }),
      row({ preferredFactionRecorded: true, preferredFaction: CANONN_FACTION, controllingFaction: 'Rival' }),
      // Derived (not recorded) preferences are excluded.
      row({ preferredFactionRecorded: false, preferredFaction: CDSR_FACTION, controllingFaction: CDSR_FACTION }),
    ]);

    expect(stats.preferred).toEqual([{ faction: CANONN_FACTION, got: 1, miss: 1 }]);
  });

  it('classifies station types into the same families the report colours by', () => {
    const stats = computeCensusStats([
      row({
        stations: [
          { name: 'A', type: 'Space Construction Depot', controllingFaction: null },
          { name: 'B', type: 'Planetary Construction Depot', controllingFaction: null },
          { name: 'C', type: 'Coriolis Starport', controllingFaction: null },
          { name: 'D', type: 'Outpost', controllingFaction: null },
          { name: 'E', type: 'Settlement', controllingFaction: null },
          { name: 'F', type: null, controllingFaction: null },
        ],
      }),
    ]);

    expect(stats.totalStations).toBe(6);
    expect(stats.depotCount).toBe(2);
    const familyOf = (type: string) => stats.stations.find(s => s.type === type)?.family;
    expect(familyOf('Space Construction Depot')).toBe('Construction');
    expect(familyOf('Coriolis Starport')).toBe('Starport');
    expect(familyOf('Outpost')).toBe('Outpost');
    expect(familyOf('Settlement')).toBe('Surface');
    expect(stats.stations.find(s => s.type === 'Unknown')?.family).toBe('Unknown');
  });

  it('buckets Canonn influence into 5-point bands split by who controls', () => {
    const stats = computeCensusStats([
      row({ canonnInfluence: 12, controllingFaction: CANONN_FACTION }),
      row({ canonnInfluence: 13, controllingFaction: 'Rival' }),
      row({ canonnInfluence: null }), // no presence — excluded entirely
    ]);

    expect(stats.influenceBins[2]).toEqual({ bucket: 10, canonnControls: 1, other: 1 });
  });

  it('buckets freshness by whole days since updatedAt, and tracks unknown separately', () => {
    const stats = computeCensusStats(
      [
        row({ updatedAt: '2026-10-18T00:00:00Z' }), // today
        row({ updatedAt: '2026-10-10T00:00:00Z' }), // 8 days -> 1-4 weeks
        row({ updatedAt: null }),
      ],
      NOW,
    );

    expect(stats.freshnessBins.find(b => b.label === 'Today')?.count).toBe(1);
    expect(stats.freshnessBins.find(b => b.label === '1-4 weeks')?.count).toBe(1);
    expect(stats.freshnessBins.find(b => b.label === 'Unknown')?.count).toBe(1);
    // Matches the published report's own approach: the element at the floor-of-half index of
    // the sorted ages, not a true statistical median — so [0, 8] reads as 8, not 4.
    expect(stats.medianAgeDays).toBe(8);
  });

  it('counts a rival as leading only where it beats both Canonn and CDSR in a system either is present in', () => {
    const stats = computeCensusStats([
      row({
        canonnInfluence: 10,
        cdsrInfluence: 5,
        factions: [{ name: 'Varati Ring', influencePercent: 60 }],
      }),
      row({
        canonnInfluence: 50,
        factions: [{ name: 'Varati Ring', influencePercent: 10 }],
      }),
      // Neither Canonn nor CDSR present — not counted, even though the faction is strong here.
      row({ factions: [{ name: 'Varati Ring', influencePercent: 90 }] }),
    ]);

    expect(stats.rivals).toEqual([{ faction: 'Varati Ring', leadCount: 1 }]);
  });

  it('counts open conflicts against a third party but not Canonn-vs-CDSR ones', () => {
    const stats = computeCensusStats([
      row({ warState: 'active', warIsCanonnVsCanonn: false }),
      row({ warState: 'active', warIsCanonnVsCanonn: true }),
      row({ electionState: 'pending', electionIsCanonnVsCanonn: false }),
      row({ electionState: 'active', electionIsCanonnVsCanonn: false }),
    ]);

    expect(stats.openConflicts).toBe(2);
  });
});
