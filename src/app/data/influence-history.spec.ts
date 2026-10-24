import {
  ConflictRow,
  FactionSeries,
  HistoryRow,
  axisMax,
  axisTicks,
  buildAverages,
  buildConflictSpans,
  buildSeries,
  conflictsAt,
  describeConflict,
  nearestIndex,
  shortFactionName,
  snapshotTimes,
  timeTicks,
  valueAt,
} from './influence-history';

function row(faction: string, influence: number | string, firstSeen: string): HistoryRow {
  return { faction_name: faction, influence, first_seen: firstSeen };
}

const T1 = '2026-10-01T00:00:00Z';
const T2 = '2026-10-02T00:00:00Z';
const T3 = '2026-10-03T00:00:00Z';

describe('buildSeries', () => {
  it('groups rows by faction, as percentages, oldest first', () => {
    const series = buildSeries([row('Canonn', 0.5, T2), row('Canonn', '0.25', T1), row('Other', 0.1, T1)]);

    const canonn = series.find(s => s.name === 'Canonn')!;
    expect(canonn.points.map(p => p.value)).toEqual([25, 50]);
    expect(canonn.points[0].time).toBeLessThan(canonn.points[1].time);
  });

  it('lists Canonn, then CDSR, then the rest A-Z', () => {
    const series = buildSeries([
      row('Zeta Party', 0.1, T1),
      row('Canonn Deep Space Research', 0.2, T1),
      row('alpha Corp', 0.1, T1),
      row('Canonn', 0.3, T1),
    ]);

    expect(series.map(s => s.name)).toEqual(['Canonn', 'Canonn Deep Space Research', 'alpha Corp', 'Zeta Party']);
    expect(series.map(s => s.tracked)).toEqual([true, true, false, false]);
  });

  it('calls Canonn Deep Space Research CDSR', () => {
    expect(shortFactionName('Canonn Deep Space Research')).toBe('CDSR');
    expect(buildSeries([row('Canonn Deep Space Research', 0.2, T1)])[0].label).toBe('CDSR');
  });

  it('skips a row it cannot read rather than breaking the chart', () => {
    const series = buildSeries([row('Canonn', 'abc', T1), row('Canonn', 0.4, 'not a date'), row('Canonn', 0.4, T2)]);

    expect(series[0].points).toHaveLength(1);
  });

  it('is empty for no rows', () => {
    expect(buildSeries([])).toEqual([]);
  });

  it('reads wars and elections out of the states, active or pending, and ignores other states', () => {
    const series = buildSeries([
      { ...row('A', 0.1, T1), active_states: '[{"State": "War"}, {"State": "Boom"}]', pending_states: '[]' },
      { ...row('A', 0.1, T2), active_states: '[]', pending_states: '[{"State": "Election", "Trend": 0}]' },
      { ...row('A', 0.1, T3), active_states: '[{"State": "CivilWar"}]' },
      { ...row('B', 0.1, T1), active_states: 'not json' },
    ]);

    expect(series[0].points.map(p => p.conflicts)).toEqual([['War'], ['Election (pending)'], ['Civil war']]);
    expect(series[1].points[0].conflicts).toEqual([]);
  });
});

describe('conflict spans', () => {
  const war: ConflictRow = {
    war_type: 'war',
    status: 'active',
    faction_a: 'Canonn',
    faction_b: 'Foe',
    first_seen: T2,
    won_days_a: 2,
    won_days_b: 0,
  };

  it('keeps wars and elections, and drops anything it cannot place', () => {
    const spans = buildConflictSpans([
      { ...war, war_type: 'election', first_seen: T1 },
      war,
      { ...war, war_type: 'mystery' },
      { ...war, first_seen: 'nope' },
    ]);

    expect(spans.map(s => s.kind)).toEqual(['Election', 'War']);
    expect(spans[1].end).toBeNull();
  });

  it('describes an open one with its latest score and a finished one with its winner', () => {
    const [open] = buildConflictSpans([war]);
    const [done] = buildConflictSpans([
      { ...war, ended_at: T3, outcome: 'Canonn Deep Space Research_won', faction_a: 'Canonn Deep Space Research' },
    ]);
    const [pending] = buildConflictSpans([{ ...war, status: 'pending' }]);

    expect(describeConflict(open)).toBe('War: Canonn vs Foe — latest 2–0 days');
    expect(describeConflict(done)).toBe('War: CDSR vs Foe — CDSR won');
    expect(describeConflict(pending)).toBe('War (pending): Canonn vs Foe');
  });

  it('finds the conflicts open at a time', () => {
    const spans = buildConflictSpans([{ ...war, ended_at: T3 }]);

    expect(conflictsAt(spans, Date.parse(T1))).toEqual([]);
    expect(conflictsAt(spans, Date.parse(T2))).toHaveLength(1);
    expect(conflictsAt(spans, Date.parse(T3))).toHaveLength(1);
    expect(conflictsAt(spans, Date.parse(T3) + 1)).toEqual([]);
  });
});

describe('buildAverages', () => {
  it('turns the tracker\'s fractions into labelled percentages and drops the nulls', () => {
    const lines = buildAverages({ Canonn: 0.711, 'Canonn Deep Space Research': null, Other: 0.1 });

    expect(lines.map(l => l.label)).toEqual(['Canonn avg', 'Other avg']);
    expect(lines[0].value).toBeCloseTo(71.1);
  });

  it('copes with nothing at all', () => {
    expect(buildAverages(null)).toEqual([]);
    expect(buildAverages(undefined)).toEqual([]);
  });
});

describe('snapshots and lookups', () => {
  const series: FactionSeries[] = buildSeries([
    row('Canonn', 0.5, T1),
    row('Canonn', 0.6, T3),
    row('Other', 0.2, T1),
    row('Other', 0.3, T2),
  ]);
  const t1 = Date.parse(T1);
  const t2 = Date.parse(T2);
  const t3 = Date.parse(T3);

  it('lists every moment any faction was read, once, oldest first', () => {
    expect(snapshotTimes(series)).toEqual([t1, t2, t3]);
  });

  it('finds a faction\'s influence at a snapshot, or the last one it had before it', () => {
    const canonn = series[0];

    expect(valueAt(canonn, t1)).toBe(50);
    expect(valueAt(canonn, t2)).toBe(50); // no reading at t2: still the t1 one
    expect(valueAt(canonn, t3)).toBe(60);
  });

  it('has no value before a faction\'s first reading', () => {
    expect(valueAt(series[0], t1 - 1000)).toBeNull();
  });

  it('finds the snapshot nearest a time', () => {
    const times = [t1, t2, t3];

    expect(nearestIndex(times, t1 - 5000)).toBe(0);
    expect(nearestIndex(times, t2 + 1000)).toBe(1);
    expect(nearestIndex(times, t3 + 99999)).toBe(2);
    expect(nearestIndex([], t1)).toBe(-1);
  });
});

describe('axes', () => {
  const series = (value: number): FactionSeries[] => [
    { name: 'F', label: 'F', tracked: false, points: [{ time: 0, value, conflicts: [] }] },
  ];

  it('tops the axis at the next 10% above the highest value, between 20% and 100%', () => {
    expect(axisMax(series(3), [])).toBe(20);
    expect(axisMax(series(37), [])).toBe(40);
    expect(axisMax(series(40), [])).toBe(40);
    expect(axisMax(series(99.5), [])).toBe(100);
  });

  it('counts an average line when sizing the axis', () => {
    expect(axisMax(series(10), [{ name: 'F', label: 'F avg', value: 55 }])).toBe(60);
  });

  it('puts gridlines from zero in sensible steps', () => {
    expect(axisTicks(20)).toEqual([0, 5, 10, 15, 20]);
    expect(axisTicks(40)).toEqual([0, 10, 20, 30, 40]);
    expect(axisTicks(100)).toEqual([0, 25, 50, 75, 100]);
  });

  it('spaces time labels evenly, or gives one for a single moment', () => {
    expect(timeTicks(0, 100, 3)).toEqual([0, 50, 100]);
    expect(timeTicks(10, 10, 5)).toEqual([10]);
  });
});
