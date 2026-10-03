import { buildWatchlistMap, parseWatchlistTsv } from './priority-watchlist';

describe('parseWatchlistTsv', () => {
  it('parses rows by column name, trimming whitespace', () => {
    const tsv = 'System\tFaction\tPosition\tDetails\nVarati\tCanonn\t1\tKey waypoint.\n';
    expect(parseWatchlistTsv(tsv)).toEqual([
      { systemName: 'Varati', faction: 'Canonn', position: 1, details: 'Key waypoint.' },
    ]);
  });

  it('is tolerant of reordered columns, since they are matched by name', () => {
    const tsv = 'Details\tPosition\tFaction\tSystem\nWhy it matters\t2\tCanonn Deep Space Research\tHaiden\n';
    expect(parseWatchlistTsv(tsv)).toEqual([
      { systemName: 'Haiden', faction: 'Canonn Deep Space Research', position: 2, details: 'Why it matters' },
    ]);
  });

  it('returns an empty array when the expected columns are missing', () => {
    expect(parseWatchlistTsv('Foo\tBar\n1\t2\n')).toEqual([]);
  });

  it('skips rows with a blank system/faction or a non-positive-integer position', () => {
    const tsv = [
      'System\tFaction\tPosition\tDetails',
      '\tCanonn\t1\tNo system name',
      'Varati\t\t1\tNo faction',
      'Varati\tCanonn\t0\tZero position',
      'Varati\tCanonn\tnot-a-number\tBad position',
      'Varati\tCanonn\t1\tThis one is fine',
    ].join('\n');
    expect(parseWatchlistTsv(tsv)).toEqual([
      { systemName: 'Varati', faction: 'Canonn', position: 1, details: 'This one is fine' },
    ]);
  });
});

describe('buildWatchlistMap', () => {
  it('groups entries by system, preserving multiple entries for the same system', () => {
    const map = buildWatchlistMap([
      { systemName: 'Varati', faction: 'Canonn', position: 1, details: 'A' },
      { systemName: 'Varati', faction: 'Canonn Deep Space Research', position: 2, details: 'B' },
      { systemName: 'Haiden', faction: 'Canonn', position: 1, details: 'C' },
    ]);
    expect(map.get('Varati')).toEqual([
      { systemName: 'Varati', faction: 'Canonn', position: 1, details: 'A' },
      { systemName: 'Varati', faction: 'Canonn Deep Space Research', position: 2, details: 'B' },
    ]);
    expect(map.get('Haiden')).toEqual([{ systemName: 'Haiden', faction: 'Canonn', position: 1, details: 'C' }]);
    expect(map.get('Nonexistent')).toBeUndefined();
  });
});
