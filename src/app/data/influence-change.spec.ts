import { describeChange, formatPoints, influenceChangeFrom } from './influence-change';

describe('influenceChangeFrom', () => {
  it('prefers the week, as points rather than a fraction', () => {
    const change = influenceChangeFrom({ change_7d: 0.027, change_24h: 0.01, per_day: 0.004, span_days: 6.5, direction: 'up' });

    expect(change?.window).toBe('7d');
    expect(change?.points).toBeCloseTo(2.7);
    expect(change?.perDay).toBeCloseTo(0.4);
    expect(change?.spanDays).toBe(6.5);
    expect(change?.direction).toBe('up');
  });

  it('falls back to the day when there is not a week of history', () => {
    const change = influenceChangeFrom({ change_7d: null, change_24h: -0.012, direction: 'down' });

    expect(change?.window).toBe('24h');
    expect(change?.points).toBeCloseTo(-1.2);
  });

  it('is null when there is no change figure at all', () => {
    expect(influenceChangeFrom({ change_7d: null, change_24h: null, direction: 'unknown' })).toBeNull();
    expect(influenceChangeFrom(null)).toBeNull();
    expect(influenceChangeFrom(undefined)).toBeNull();
  });

  it('keeps a change of exactly zero (steady is information)', () => {
    const change = influenceChangeFrom({ change_7d: 0, direction: 'flat' });

    expect(change).toMatchObject({ points: 0, direction: 'flat' });
  });

  it('reads an unknown direction as flat', () => {
    expect(influenceChangeFrom({ change_7d: 0.01, direction: 'unknown' })?.direction).toBe('flat');
  });
});

describe('formatPoints', () => {
  it('signs gains, shows losses, and writes zero without a sign', () => {
    expect(formatPoints(2.74)).toBe('+2.7');
    expect(formatPoints(-0.449)).toBe('-0.4');
    expect(formatPoints(0)).toBe('0.0');
    expect(formatPoints(-0.01)).toBe('0.0');
    expect(formatPoints(12)).toBe('+12.0');
  });
});

describe('describeChange', () => {
  it('says what moved, over which window, at what rate and from how much history', () => {
    expect(
      describeChange({ points: 2.7, window: '7d', direction: 'up', perDay: 0.4, spanDays: 6.5 }),
    ).toBe('+2.7 points over 7d (+0.4 per day, from 6.5 days of history)');
  });

  it('leaves out what it does not know', () => {
    expect(describeChange({ points: -1, window: '24h', direction: 'down', perDay: null, spanDays: null })).toBe(
      '-1.0 points over 24h',
    );
  });
});
