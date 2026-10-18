import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import { computeRivals } from './rivals';

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

describe('computeRivals', () => {
  it('parses an active war line into a conflict against the named opponent, for the side that is a party', () => {
    const rivals = computeRivals([
      row({
        systemName: 'Varati Ring Home',
        warState: 'active',
        warDetails: `War: ${CANONN_FACTION} vs Varati Ring`,
        warIsCanonnVsCanonn: false,
      }),
    ]);

    expect(rivals).toEqual([
      {
        faction: 'Varati Ring',
        conflicts: [{ systemName: 'Varati Ring Home', us: 'C', state: 'War', status: 'active' }],
        lead: [],
        close: [],
        score: 5,
      },
    ]);
  });

  it('reads a CDSR-side conflict as CDSR, and strips the "(pending)" suffix and score/stake continuation lines', () => {
    const rivals = computeRivals([
      row({
        electionState: 'pending',
        electionDetails: `Election: ${CDSR_FACTION} vs Selous Syndicate (pending)\n  Stations at stake: Some Station`,
        electionIsCanonnVsCanonn: false,
      }),
    ]);

    expect(rivals[0].conflicts).toEqual([{ systemName: 'Test System', us: 'D', state: 'Election', status: 'pending' }]);
  });

  it('never turns a Canonn-vs-CDSR match into a rival conflict', () => {
    const rivals = computeRivals([
      row({
        warState: 'active',
        warDetails: `War: ${CANONN_FACTION} vs ${CDSR_FACTION}`,
        warIsCanonnVsCanonn: true,
      }),
    ]);

    expect(rivals).toEqual([]);
  });

  it('counts a faction as leading only where it beats both Canonn and CDSR, and only in a system either is present in', () => {
    const rivals = computeRivals([
      row({ canonnInfluence: 10, cdsrInfluence: 5, factions: [{ name: 'Varati Ring', influencePercent: 60 }] }),
      row({ canonnInfluence: 50, factions: [{ name: 'Varati Ring', influencePercent: 10 }] }),
      // Neither Canonn nor CDSR present — excluded even though the faction is strong here.
      row({ factions: [{ name: 'Varati Ring', influencePercent: 90 }] }),
    ]);

    expect(rivals).toEqual([{ faction: 'Varati Ring', conflicts: [], lead: [{ systemName: 'Test System', us: 'C', marginPoints: 50 }], close: [], score: 1 }]);
  });

  it('counts "close behind" only within 5 points, and not when the faction already leads', () => {
    const rivals = computeRivals([
      // 4 points behind our better faction (50) — close.
      row({ canonnInfluence: 50, factions: [{ name: 'Close Co', influencePercent: 46 }] }),
      // Exactly 5 points behind — outside the band (margin > -5 required).
      row({ canonnInfluence: 50, factions: [{ name: 'Edge Co', influencePercent: 45 }] }),
      // Ahead — counted as lead, not close.
      row({ canonnInfluence: 50, factions: [{ name: 'Close Co', influencePercent: 60 }] }),
    ]);

    const closeCo = rivals.find(r => r.faction === 'Close Co')!;
    expect(closeCo.close).toEqual([{ systemName: 'Test System', us: 'C', marginPoints: -4 }]);
    expect(closeCo.lead).toHaveLength(1);
    expect(rivals.find(r => r.faction === 'Edge Co')).toBeUndefined();
  });

  it('drops a faction entirely once filtered down to nothing (score 0), and sorts the rest by score descending', () => {
    const rivals = computeRivals([
      row({ warState: 'active', warDetails: `War: ${CANONN_FACTION} vs Big Rival`, warIsCanonnVsCanonn: false }),
      row({ canonnInfluence: 50, factions: [{ name: 'Small Rival', influencePercent: 46 }] }),
    ]);

    expect(rivals.map(r => r.faction)).toEqual(['Big Rival', 'Small Rival']);
  });
});
