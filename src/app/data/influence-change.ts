/**
 * A faction's recent change in influence, as the Canonn and CDSR columns show it beside the
 * percentage: an arrow, the signed number of points, and the window it was measured over —
 * the same indicator the BGS tracker's dashboard shows.
 */

/** A faction's influence change over the longest window the tracker has enough history for. */
export interface InfluenceChange {
  /** Percentage points gained (positive) or lost (negative) over {@link window}. */
  points: number;
  /** The window it covers: the last week where there is enough history, otherwise the last day. */
  window: '7d' | '24h';
  /** Which way the faction is heading, by its rate over that window (flat within a small tolerance). */
  direction: 'up' | 'down' | 'flat';
  /** Percentage points per day over the window; null if the tracker gave no rate. */
  perDay: number | null;
  /** How many days of history the figure is really based on — shorter than the window for a new system. */
  spanDays: number | null;
}

/** The fields of a summary's `trend[faction]` block this reads (influence values are 0-1 fractions). */
export interface ApiTrend {
  change_24h?: number | null;
  change_7d?: number | null;
  per_day?: number | null;
  span_days?: number | null;
  direction?: string | null;
}

/** The change a tracker trend block describes, or null when it has too little history to say. */
export function influenceChangeFrom(trend: ApiTrend | null | undefined): InfluenceChange | null {
  if (!trend) {
    return null;
  }
  let window: InfluenceChange['window'];
  let fraction: number;
  if (typeof trend.change_7d === 'number') {
    window = '7d';
    fraction = trend.change_7d;
  } else if (typeof trend.change_24h === 'number') {
    window = '24h';
    fraction = trend.change_24h;
  } else {
    return null;
  }
  const direction = trend.direction === 'up' || trend.direction === 'down' ? trend.direction : 'flat';
  return {
    points: fraction * 100,
    window,
    direction,
    perDay: typeof trend.per_day === 'number' ? trend.per_day * 100 : null,
    spanDays: typeof trend.span_days === 'number' ? trend.span_days : null,
  };
}

/** A signed one-decimal figure: "+2.7", "-0.4", "0.0". */
export function formatPoints(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  if (Object.is(rounded, -0) || rounded === 0) {
    return '0.0';
  }
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

/** The tooltip: what was gained or lost, over what window, at what rate, and how much history it rests on. */
export function describeChange(change: InfluenceChange): string {
  const parts = [`${formatPoints(change.points)} points over ${change.window}`];
  const detail: string[] = [];
  if (change.perDay !== null) {
    detail.push(`${formatPoints(change.perDay)} per day`);
  }
  if (change.spanDays !== null) {
    detail.push(`from ${change.spanDays.toFixed(1)} days of history`);
  }
  return detail.length > 0 ? `${parts[0]} (${detail.join(', ')})` : parts[0];
}
