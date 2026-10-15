import { BgsRow } from '../canonn-bgs.service';
import { filterRows, sortRowsByColumn, sortRowsByDistance, sortRowsByName } from './bgs-order';
import { NO_PRIORITY } from './priority';

const NOW = Date.parse('2026-08-07T12:00:00Z');

/** A minimal, fully-populated row — tests override only the fields they care about. */
function row(systemName: string, overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName,
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    canonnHistory: [],
    cdsrHistory: [],
    canonnChange: null,
    cdsrChange: null,
    systemAddress: '',
    influenceAverages: {},
    architect: null,
    notAColony: false,
    preferredFaction: null,
    preferredFactionRecorded: false,
    hasCanonnStation: false,
    factionDetails: [],
    stations: [],
    stationCount: null,
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
    watchlist: [],
    priority: NO_PRIORITY,
    powerplay: null,
    ...overrides,
  };
}

function names(rows: readonly BgsRow[]): string[] {
  return rows.map(r => r.systemName);
}

function scored(systemName: string, score: number | null, overrides: Partial<BgsRow> = {}): BgsRow {
  return row(systemName, { priority: { ...NO_PRIORITY, tier: 'P2', score }, ...overrides });
}

describe('sortRowsByColumn', () => {
  it('orders a numeric column ascending and descending, rows with no value last either way', () => {
    const rows = [row('B', { canonnInfluence: 10 }), row('A'), row('C', { canonnInfluence: 30 }), row('D', { canonnInfluence: 20 })];

    expect(names(sortRowsByColumn(rows, 'canonn', 'asc'))).toEqual(['B', 'D', 'C', 'A']);
    expect(names(sortRowsByColumn(rows, 'canonn', 'desc'))).toEqual(['C', 'D', 'B', 'A']);
  });

  it('breaks equal values by name, case-insensitively, in both directions', () => {
    const rows = [row('beta', { cdsrInfluence: 5 }), row('Alpha', { cdsrInfluence: 5 }), row('gamma', { cdsrInfluence: 5 })];

    expect(names(sortRowsByColumn(rows, 'cdsr', 'asc'))).toEqual(['Alpha', 'beta', 'gamma']);
    expect(names(sortRowsByColumn(rows, 'cdsr', 'desc'))).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('orders text case-insensitively and treats a blank as no value', () => {
    const rows = [
      row('1', { architect: 'zed' }),
      row('2', { architect: null }),
      row('3', { architect: 'Alice' }),
      row('4', { architect: 'bob' }),
    ];

    expect(names(sortRowsByColumn(rows, 'architect', 'asc'))).toEqual(['3', '4', '1', '2']);
    expect(names(sortRowsByColumn(rows, 'architect', 'desc'))).toEqual(['1', '4', '3', '2']);
  });

  it('orders by faction count, a system with none counting as zero rather than missing', () => {
    const faction = { name: 'F', influencePercent: 1 };
    const rows = [row('A', { factions: [] }), row('B', { factions: [faction, faction, faction] }), row('C', { factions: [faction] })];

    expect(names(sortRowsByColumn(rows, 'factionCount', 'desc'))).toEqual(['B', 'C', 'A']);
  });

  it('orders freshness by last-seen time, oldest first when ascending, unknown last', () => {
    const rows = [
      row('new', { updatedAt: '2026-08-07T10:00:00Z' }),
      row('unknown', { updatedAt: null }),
      row('old', { updatedAt: '2026-07-01T00:00:00Z' }),
    ];

    expect(names(sortRowsByColumn(rows, 'freshness', 'asc'))).toEqual(['old', 'new', 'unknown']);
    expect(names(sortRowsByColumn(rows, 'freshness', 'desc'))).toEqual(['new', 'old', 'unknown']);
  });

  it('orders priority by score, a system with no score last whichever way', () => {
    const rows = [scored('A', 40), scored('B', null), scored('C', 90), scored('D', 65)];

    expect(names(sortRowsByColumn(rows, 'priority', 'desc'))).toEqual(['C', 'D', 'A', 'B']);
    expect(names(sortRowsByColumn(rows, 'priority', 'asc'))).toEqual(['A', 'D', 'C', 'B']);
  });

  it('breaks a priority tie by stations, then population, then body count — most first, in either direction', () => {
    const rows = [
      scored('few stations', 80, { stationCount: 1, population: 9_000_000, bodyCount: 50 }),
      scored('many stations', 80, { stationCount: 7, population: 10, bodyCount: 1 }),
      scored('same stations, bigger', 80, { stationCount: 1, population: 20_000_000, bodyCount: 5 }),
      scored('same all, more bodies', 80, { stationCount: 1, population: 9_000_000, bodyCount: 60 }),
      scored('unknown', 80),
    ];

    const expected = ['many stations', 'same stations, bigger', 'same all, more bodies', 'few stations', 'unknown'];
    expect(names(sortRowsByColumn(rows, 'priority', 'desc'))).toEqual(expected);
    expect(names(sortRowsByColumn(rows, 'priority', 'asc'))).toEqual(expected);
  });

  it('orders by the change in influence, biggest gain first when descending, no change figure last', () => {
    const change = (points: number) => ({ points, window: '7d' as const, direction: 'up' as const, perDay: null, spanDays: 7 });
    const rows = [
      row('B', { canonnChange: change(-3) }),
      row('A'),
      row('C', { canonnChange: change(2.5) }),
      row('D', { canonnChange: change(0) }),
    ];

    expect(names(sortRowsByColumn(rows, 'canonnChange', 'desc'))).toEqual(['C', 'D', 'B', 'A']);
    expect(names(sortRowsByColumn(rows, 'canonnChange', 'asc'))).toEqual(['B', 'D', 'C', 'A']);
  });

  it('orders CDSR\'s change on its own figures, not Canonn\'s', () => {
    const change = (points: number) => ({ points, window: '24h' as const, direction: 'down' as const, perDay: null, spanDays: 1 });
    const rows = [row('X', { cdsrChange: change(-1) }), row('Y', { canonnChange: change(9), cdsrChange: change(4) })];

    expect(names(sortRowsByColumn(rows, 'cdsrChange', 'desc'))).toEqual(['Y', 'X']);
  });

  it('does not change the rows it was given', () => {
    const rows = [row('B', { canonnInfluence: 2 }), row('A', { canonnInfluence: 1 })];

    sortRowsByColumn(rows, 'canonn', 'asc');

    expect(names(rows)).toEqual(['B', 'A']);
  });
});

describe('sortRowsByDistance', () => {
  it('orders nearest first from the origin, a system without coordinates last', () => {
    const rows = [
      row('far', { x: 100, y: 0, z: 0 }),
      row('near', { x: 1, y: 1, z: 0 }),
      row('nowhere', { x: Number.NaN, y: 0, z: 0 }),
      row('mid', { x: 10, y: 0, z: 0 }),
    ];

    expect(names(sortRowsByDistance(rows, { x: 0, y: 0, z: 0 }))).toEqual(['near', 'mid', 'far', 'nowhere']);
  });
});

describe('sortRowsByName', () => {
  it('orders by name regardless of case', () => {
    expect(names(sortRowsByName([row('b'), row('A'), row('C')]))).toEqual(['A', 'b', 'C']);
  });
});

describe('filterRows', () => {
  const rows = [
    row('war', { warState: 'active' }),
    row('election', { electionState: 'pending' }),
    row('quiet'),
    row('mine', { architect: 'Cmdr Example' }),
    row('canonn here', { factions: [{ name: 'Canonn', influencePercent: 50 }] }),
    row('canonn preferred', { preferredFaction: 'Canonn Deep Space Research' }),
    row('other faction', { factions: [{ name: 'Some Faction', influencePercent: 50 }] }),
    row('stale', { updatedAt: '2026-08-01T00:00:00Z' }),
    row('fresh', { updatedAt: '2026-08-07T11:00:00Z' }),
    row('canonn station', { hasCanonnStation: true }),
  ];

  it('passes every row through when no filter is on', () => {
    expect(filterRows(rows, {}, NOW)).toHaveLength(rows.length);
  });

  it('keeps systems in, or about to be in, a war or election', () => {
    expect(names(filterRows(rows, { warElection: true }, NOW))).toEqual(['war', 'election']);
  });

  it('keeps systems that need recon: stale or never seen, not fresh', () => {
    const result = names(filterRows(rows, { needsRecon: true }, NOW));

    expect(result).toContain('stale');
    expect(result).toContain('quiet');
    expect(result).not.toContain('fresh');
  });

  it('keeps systems with no architect, or with a named one case-insensitively', () => {
    expect(names(filterRows(rows, { noArchitect: true }, NOW))).not.toContain('mine');
    expect(names(filterRows(rows, { architect: ' cmdr EXAMPLE ' }, NOW))).toEqual(['mine']);
  });

  it('lets no_architect win over a named architect', () => {
    expect(names(filterRows(rows, { noArchitect: true, architect: 'Cmdr Example' }, NOW))).not.toContain('mine');
  });

  it('keeps systems with a Canonn-named station', () => {
    expect(names(filterRows(rows, { canonnStation: true }, NOW))).toEqual(['canonn station']);
  });

  it('keeps a system where the faction is present or is the preferred faction, matching any of several', () => {
    const result = names(filterRows(rows, { hasFaction: ['canonn', 'Canonn Deep Space Research'] }, NOW));

    expect(result).toEqual(['canonn here', 'canonn preferred']);
  });

  it('combines filters with AND', () => {
    const both = [row('x', { warState: 'active', architect: 'A' }), row('y', { warState: 'active' })];

    expect(names(filterRows(both, { warElection: true, noArchitect: true }, NOW))).toEqual(['y']);
  });
});
