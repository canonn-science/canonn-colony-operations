/**
 * How stale a system's BGS reading is, in ticks-elapsed terms. Ticks aren't directly
 * observable (see the module doc below), so this approximates "ticks elapsed" with
 * "whole days elapsed since `updated_at`" — accurate to within one tick, which is enough
 * to colour a dot. See the feature's issue for the reasoning against exact tick counting.
 */
export type FreshnessBand = 'current' | 'oneTick' | 'days' | 'weeks' | 'unknown';

/** Everything a freshness pill needs to render, already computed for the current clock. */
export interface FreshnessInfo {
  band: FreshnessBand;
  /** Short age label for the pill, e.g. "now", "5d", "3w", "1y+", or "—" for unknown. */
  label: string;
  /** Full sentence naming the band and the age in words, for the pill's accessible name. */
  accessibleName: string;
  /** Hover text: the absolute timestamp, or an explanation when there isn't one. */
  title: string;
  /** The raw `updated_at` epoch millis, for sorting; null sorts last regardless of direction. */
  sortValue: number | null;
}

const WEEK_LABEL_CLAMP_WEEKS = 52;

/**
 * Spansh's `updated_at` isn't strict ISO 8601 — a space instead of `T`, and a two-digit
 * UTC offset (`+00` rather than `+00:00`) — which `Date` parses inconsistently across
 * engines. Normalising both before parsing makes it reliable everywhere.
 */
export function parseUpdatedAt(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days elapsed between `updatedAtMs` and `nowMs`, clamped to zero for future timestamps. */
function daysElapsed(updatedAtMs: number, nowMs: number): number {
  const ms = nowMs - updatedAtMs;
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function bandFor(days: number): FreshnessBand {
  if (days === 0) {
    return 'current';
  }
  if (days === 1) {
    return 'oneTick';
  }
  if (days <= 6) {
    return 'days';
  }
  return 'weeks';
}

const BAND_WORDS: Record<FreshnessBand, string> = {
  current: 'Current',
  oneTick: '1 tick behind',
  days: 'Days behind',
  weeks: 'Weeks behind',
  unknown: 'Update time unknown',
};

/** Short pill label: rounds down throughout, and clamps at a year to bound the pill width. */
function formatLabel(days: number): string {
  if (days === 0) {
    return 'now';
  }
  if (days <= 6) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks >= WEEK_LABEL_CLAMP_WEEKS) {
    return '1y+';
  }
  return `${weeks}w`;
}

/** The age phrase used in the accessible name, e.g. "just now", "5 days ago", "3 weeks ago". */
function formatAgeWords(days: number): string {
  if (days === 0) {
    return 'just now';
  }
  if (days === 1) {
    return '1 day ago';
  }
  if (days <= 6) {
    return `${days} days ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks >= WEEK_LABEL_CLAMP_WEEKS) {
    return 'over a year ago';
  }
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
}

/**
 * Computes everything a freshness pill needs from a system's raw `updated_at` string.
 * `nowMs` defaults to the real clock but is injectable for tests and for the table's
 * once-a-minute recompute timer.
 */
export function computeFreshness(raw: string | null | undefined, nowMs: number = Date.now()): FreshnessInfo {
  const updatedAtMs = parseUpdatedAt(raw);
  if (updatedAtMs === null) {
    return {
      band: 'unknown',
      label: '—',
      accessibleName: BAND_WORDS.unknown,
      title: BAND_WORDS.unknown,
      sortValue: null,
    };
  }

  const days = daysElapsed(updatedAtMs, nowMs);
  const band = bandFor(days);
  const label = formatLabel(days);
  return {
    band,
    label,
    accessibleName: `${BAND_WORDS[band]}, updated ${formatAgeWords(days)}`,
    title: raw!.trim(),
    sortValue: updatedAtMs,
  };
}
