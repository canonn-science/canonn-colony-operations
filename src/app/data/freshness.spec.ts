import { computeFreshness, parseUpdatedAt } from './freshness';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-07T12:00:00Z');

function agoRaw(ms: number): string {
  const d = new Date(NOW - ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00`;
}

describe('parseUpdatedAt', () => {
  it('parses Spansh\'s non-ISO format (space separator, two-digit offset)', () => {
    expect(parseUpdatedAt('2026-08-06 19:52:24+00')).toBe(Date.parse('2026-08-06T19:52:24+00:00'));
  });

  it('returns null for null, undefined, empty, or unparseable input', () => {
    expect(parseUpdatedAt(null)).toBeNull();
    expect(parseUpdatedAt(undefined)).toBeNull();
    expect(parseUpdatedAt('')).toBeNull();
    expect(parseUpdatedAt('not a date')).toBeNull();
  });
});

describe('computeFreshness', () => {
  it('is "unknown" with an em dash label when updated_at is missing, not the worst band', () => {
    const info = computeFreshness(null, NOW);
    expect(info.band).toBe('unknown');
    expect(info.label).toBe('—');
    expect(info.accessibleName).toBe('Update time unknown');
    expect(info.sortValue).toBeNull();
  });

  it('clamps a future timestamp to zero instead of going negative', () => {
    const info = computeFreshness(agoRaw(-DAY_MS), NOW);
    expect(info.band).toBe('current');
    expect(info.label).toBe('now');
  });

  it('is "current" with label "now" for a reading from today (0 days elapsed)', () => {
    const info = computeFreshness(agoRaw(0), NOW);
    expect(info.band).toBe('current');
    expect(info.label).toBe('now');
  });

  it('is "current" up to the boundary just under one day old', () => {
    const info = computeFreshness(agoRaw(DAY_MS - 1000), NOW);
    expect(info.band).toBe('current');
  });

  it('is "oneTick" at exactly one day elapsed', () => {
    const info = computeFreshness(agoRaw(DAY_MS), NOW);
    expect(info.band).toBe('oneTick');
    expect(info.label).toBe('1d');
  });

  it('is "days" from two to six days elapsed', () => {
    expect(computeFreshness(agoRaw(2 * DAY_MS), NOW).band).toBe('days');
    expect(computeFreshness(agoRaw(6 * DAY_MS), NOW).band).toBe('days');
    expect(computeFreshness(agoRaw(5 * DAY_MS), NOW).label).toBe('5d');
  });

  it('is "weeks" from seven days elapsed onward', () => {
    const info = computeFreshness(agoRaw(7 * DAY_MS), NOW);
    expect(info.band).toBe('weeks');
    expect(info.label).toBe('1w');
  });

  it('formats the label in whole weeks, rounding down, once past a week', () => {
    expect(computeFreshness(agoRaw(20 * DAY_MS), NOW).label).toBe('2w');
    expect(computeFreshness(agoRaw(77 * DAY_MS), NOW).label).toBe('11w');
  });

  it('clamps to "1y+" at 52 weeks and beyond', () => {
    expect(computeFreshness(agoRaw(52 * 7 * DAY_MS), NOW).label).toBe('1y+');
    expect(computeFreshness(agoRaw(400 * DAY_MS), NOW).label).toBe('1y+');
  });

  it('states both the band and the age in words in the accessible name', () => {
    const info = computeFreshness(agoRaw(20 * DAY_MS), NOW);
    expect(info.accessibleName).toBe('Weeks behind, updated 2 weeks ago');
  });

  it('carries the raw updated_at through as the sort value, for tie-free sorting', () => {
    const raw = agoRaw(3 * DAY_MS);
    const info = computeFreshness(raw, NOW);
    expect(info.sortValue).toBe(parseUpdatedAt(raw));
  });

  it('uses the raw absolute timestamp as the hover title', () => {
    const raw = agoRaw(3 * DAY_MS);
    expect(computeFreshness(raw, NOW).title).toBe(raw);
  });
});
