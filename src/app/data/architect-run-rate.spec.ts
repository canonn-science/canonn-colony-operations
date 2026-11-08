import { AFFILIATION_NOT_A_COLONY } from './architect-form';
import {
  ARCHITECT_TARGET_DATE,
  TimedRegistryRow,
  computeRunRate,
  parseRegistryLog,
  parseSheetTimestamp,
  parseTsv,
  weekStart,
} from './architect-run-rate';

const OPTIONS = { canonn: 'Canonn', cdsr: 'Canonn Deep Space Research', totalSystems: 100, withRecord: 40 };
const at = (iso: string): number => Date.parse(iso);
const row = (systemName: string, preferredFaction: string, iso: string, affiliation = ''): TimedRegistryRow => ({
  systemName,
  preferredFaction,
  affiliation,
  at: at(iso),
});

describe('parseSheetTimestamp', () => {
  it('reads day-first dates as UTC', () => {
    expect(parseSheetTimestamp('26/07/2026 17:44:27')).toBe(at('2026-07-26T17:44:27Z'));
  });

  it('rejects text and impossible dates', () => {
    expect(parseSheetTimestamp('')).toBeNull();
    expect(parseSheetTimestamp('yesterday')).toBeNull();
    expect(parseSheetTimestamp('31/02/2026 10:00:00')).toBeNull();
  });
});

describe('parseTsv', () => {
  it('keeps tabs and newlines inside quoted cells', () => {
    expect(parseTsv('a\t"b\tc\nd"\te\r\nf\tg\th')).toEqual([['a', 'b\tc\nd', 'e'], ['f', 'g', 'h']]);
  });
});

describe('parseRegistryLog', () => {
  const header = 'Timestamp\tYour Name\tSystem Name\tArchitect Name\tCanonn Architect\tPreferred Faction';

  it('finds columns by header and skips rows without a date or system', () => {
    const tsv = [
      header,
      '26/07/2026 17:44:27\tme\tSol\tBob\tNot a Canonn Member\tCanonn',
      'garbage\tme\tAlpha\tBob\tx\tCanonn',
      '27/07/2026 10:00:00\tme\t\tBob\tx\tCanonn',
      '28/07/2026 10:00:00\tme\tBeta\tAnn\tx\t',
    ].join('\n');
    expect(parseRegistryLog(tsv)).toEqual([
      { systemName: 'Sol', preferredFaction: 'Canonn', affiliation: 'Not a Canonn Member', at: at('2026-07-26T17:44:27Z') },
      { systemName: 'Beta', preferredFaction: '', affiliation: 'x', at: at('2026-07-28T10:00:00Z') },
    ]);
  });

  it('returns nothing when the sheet is not the registry', () => {
    expect(parseRegistryLog('<html>sign in</html>')).toEqual([]);
    expect(parseRegistryLog('')).toEqual([]);
  });
});

describe('weekStart', () => {
  it('is the Monday 00:00 UTC of the week', () => {
    expect(weekStart(at('2026-11-08T17:30:00Z'))).toBe(at('2026-11-02T00:00:00Z')); // a Sunday
    expect(weekStart(at('2026-11-02T00:00:00Z'))).toBe(at('2026-11-02T00:00:00Z'));
  });
});

describe('computeRunRate', () => {
  const now = at('2026-11-08T18:00:00Z');

  it('counts each system once, in its first week, by the faction given then', () => {
    const { weeks } = computeRunRate(
      [
        row('Sol', 'Canonn', '2026-10-20T10:00:00Z'),
        row('sol', 'Canonn Deep Space Research', '2026-11-03T10:00:00Z'), // a correction, not new coverage
        row('Alpha', 'Canonn Deep Space Research', '2026-10-21T10:00:00Z'),
        row('Beta', 'Flat Galaxy Society', '2026-10-22T10:00:00Z'),
        row('Gamma', '', '2026-10-23T10:00:00Z'),
      ],
      { ...OPTIONS, now },
    );
    const first = weeks[0];
    expect(first.start).toBe(at('2026-10-19T00:00:00Z'));
    expect([first.C, first.D, first.O, first.U, first.total]).toEqual([1, 1, 1, 1, 4]);
    expect(weeks.reduce((sum, w) => sum + w.total, 0)).toBe(4);
  });

  it('keeps empty weeks and marks only the current one partial', () => {
    const { weeks } = computeRunRate([row('Sol', 'Canonn', '2026-10-20T10:00:00Z'), row('Alpha', 'Canonn', '2026-11-05T10:00:00Z')], {
      ...OPTIONS,
      now,
    });
    expect(weeks.map(w => w.total)).toEqual([1, 0, 1]);
    expect(weeks.map(w => w.partial)).toEqual([false, false, true]);
  });

  it('counts "not a colony" records as recorded, and tallies them separately', () => {
    const result = computeRunRate(
      [
        row('Sol', '', '2026-10-20T10:00:00Z', AFFILIATION_NOT_A_COLONY),
        row('Alpha', 'Canonn', '2026-10-21T10:00:00Z', 'Not a Canonn Member'),
        row('Beta', '', '2026-11-05T10:00:00Z', AFFILIATION_NOT_A_COLONY),
      ],
      { ...OPTIONS, now },
    );
    expect(result.weeks.map(w => [w.total, w.notColony])).toEqual([[2, 1], [0, 0], [1, 1]]);
    expect([result.loggedTotal, result.loggedNotColony]).toEqual([3, 2]);
    expect(result.burndown[0].remaining - result.burndown[result.burndown.length - 1].remaining).toBe(3);
  });

  it('burns down from today\'s remainder, adding back what was recorded since', () => {
    const { burndown } = computeRunRate(
      [row('Sol', 'Canonn', '2026-10-20T10:00:00Z'), row('Alpha', 'Canonn', '2026-10-21T10:00:00Z'), row('Beta', 'Canonn', '2026-11-05T10:00:00Z')],
      { ...OPTIONS, now },
    );
    // 60 left now; weeks of 19 Oct (2 recorded), 26 Oct (0), 2 Nov (1).
    expect(burndown).toEqual([
      { at: at('2026-10-19T00:00:00Z'), remaining: 63 },
      { at: at('2026-10-26T00:00:00Z'), remaining: 61 },
      { at: at('2026-11-02T00:00:00Z'), remaining: 61 },
      { at: now, remaining: 60 },
    ]);
    expect(computeRunRate([], { ...OPTIONS, now }).burndown).toEqual([]);
  });

  it('sets the needed pace from what is left and the weeks to the target', () => {
    const result = computeRunRate([], { ...OPTIONS, now });
    expect(result.remaining).toBe(60);
    expect(result.weeksLeft).toBe(Math.ceil((ARCHITECT_TARGET_DATE - now) / (7 * 24 * 60 * 60 * 1000)));
    expect(result.neededPerWeek).toBe(Math.ceil(60 / result.weeksLeft));
    expect(result.weeks).toEqual([]);
    expect(result.recentPerWeek).toBeNull();
    expect(result.projectedFinish).toBeNull();
  });

  it('projects a finish from the last four complete weeks, ignoring the partial one', () => {
    const rows: TimedRegistryRow[] = [];
    // 10 a week for the four complete weeks before the current one, and 100 in the partial week.
    for (const [week, start] of ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].entries()) {
      for (let i = 0; i < 10; i++) {
        rows.push(row(`w${week}-${i}`, 'Canonn', `${start}T10:00:00Z`));
      }
    }
    for (let i = 0; i < 100; i++) {
      rows.push(row(`now-${i}`, 'Canonn', '2026-11-10T10:00:00Z'));
    }
    const result = computeRunRate(rows, { ...OPTIONS, now: at('2026-11-15T12:00:00Z') });
    expect(result.recentPerWeek).toBe(10);
    expect(result.projectedFinish).toBe(at('2026-11-15T12:00:00Z') + 6 * 7 * 24 * 60 * 60 * 1000);
  });

  it('needs nothing once every system has a record, or the date has passed', () => {
    expect(computeRunRate([], { ...OPTIONS, withRecord: 100, now }).neededPerWeek).toBe(0);
    expect(computeRunRate([], { ...OPTIONS, now: ARCHITECT_TARGET_DATE + 1 }).weeksLeft).toBe(0);
  });
});
