/**
 * The maths behind the influence history chart: turning the tracker's snapshot rows into one
 * series per faction, the scales that place them, and the lookup the hover tooltip uses. Pure,
 * so the chart component only has to draw what it is handed.
 */

/** One faction's influence in one snapshot, as `/bgs/systems/{address}/history` sends it. */
export interface HistoryRow {
  faction_name: string;
  /** 0-1 fraction (a DECIMAL column, so possibly a numeric string). */
  influence: number | string;
  /** When the snapshot was first seen, ISO 8601. */
  first_seen: string;
  /** The faction's active states: a JSON string (or array) of `{State}` entries. */
  active_states?: string | unknown[] | null;
  /** The faction's pending states, shaped like {@link active_states}. */
  pending_states?: string | unknown[] | null;
}

/** One conflict as `/bgs/systems/{address}/conflicts` sends it. */
export interface ConflictRow {
  war_type?: string | null;
  /** `active`, `pending` or `ended`. */
  status?: string | null;
  faction_a: string;
  faction_b: string;
  first_seen: string;
  /** Null while the conflict is still open. */
  ended_at?: string | null;
  /** `<faction>_won`, or `unknown`/null. */
  outcome?: string | null;
  /** The latest tally the tracker saw — it keeps no per-day score. */
  won_days_a?: number | null;
  won_days_b?: number | null;
}

/** A conflict's span on the time axis, for the chart's shaded bands. */
export interface ConflictSpan {
  /** Label for the kind: "War", "Civil war" or "Election". */
  kind: string;
  /** `election`, or `war` for both war kinds — picks the band's colour. */
  family: 'war' | 'election';
  factionA: string;
  factionB: string;
  start: number;
  /** When it ended; null while it is still open. */
  end: number | null;
  pending: boolean;
  /** Who won, once finished and known. */
  winner: string | null;
  wonA: number | null;
  wonB: number | null;
}

/** A moment and the faction's influence then, as a percentage. */
export interface HistoryPoint {
  time: number;
  value: number;
  /** Wars and elections the faction is in at this snapshot, e.g. "War", "Election (pending)". */
  conflicts: string[];
}

/** One faction's influence over time. */
export interface FactionSeries {
  name: string;
  /** What the legend and tooltip call it ("CDSR" for Canonn Deep Space Research). */
  label: string;
  /** Canonn or CDSR — drawn in the site's own colours and listed first. */
  tracked: boolean;
  /** Oldest first. */
  points: HistoryPoint[];
}

/** A faction's long-run average influence, drawn as a dashed reference line. */
export interface AverageLine {
  name: string;
  label: string;
  /** Percentage. */
  value: number;
}

const CANONN = 'Canonn';
const CDSR = 'Canonn Deep Space Research';

/** The short name used wherever space is tight. */
export function shortFactionName(name: string): string {
  return name === CDSR ? 'CDSR' : name;
}

/** One series per faction in `rows`: ours first (Canonn, then CDSR), the rest A-Z; points oldest first. */
export function buildSeries(rows: readonly HistoryRow[]): FactionSeries[] {
  const byName = new Map<string, HistoryPoint[]>();
  for (const row of rows) {
    const time = Date.parse(row.first_seen);
    const value = Number(row.influence) * 100;
    if (Number.isNaN(time) || Number.isNaN(value)) {
      continue;
    }
    const points = byName.get(row.faction_name) ?? [];
    points.push({
      time,
      value,
      conflicts: [...conflictsIn(row.active_states, ''), ...conflictsIn(row.pending_states, ' (pending)')],
    });
    byName.set(row.faction_name, points);
  }
  const rank = (name: string): number => (name === CANONN ? 0 : name === CDSR ? 1 : 2);
  return [...byName.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([name, points]) => ({
      name,
      label: shortFactionName(name),
      tracked: name === CANONN || name === CDSR,
      points: points.sort((a, b) => a.time - b.time),
    }));
}

const CONFLICT_LABELS: Readonly<Record<string, string>> = { war: 'War', civilwar: 'Civil war', election: 'Election' };

/** The wars and elections named in a states field (a JSON string or an array of `{State}` entries), each with `suffix`. */
function conflictsIn(raw: string | unknown[] | null | undefined, suffix: string): string[] {
  let entries: unknown = raw;
  if (typeof raw === 'string') {
    try {
      entries = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  const labels: string[] = [];
  for (const entry of entries) {
    const record = typeof entry === 'string' ? { State: entry } : (entry as { State?: unknown; state?: unknown } | null);
    const name = record?.State ?? record?.state;
    const label = typeof name === 'string' ? CONFLICT_LABELS[name.toLowerCase().replace(/[^a-z]/g, '')] : undefined;
    if (label && !labels.includes(label + suffix)) {
      labels.push(label + suffix);
    }
  }
  return labels;
}

/** The conflicts that have a readable start and a kind we draw, oldest first. */
export function buildConflictSpans(rows: readonly ConflictRow[]): ConflictSpan[] {
  const spans: ConflictSpan[] = [];
  for (const row of rows) {
    const kind = CONFLICT_LABELS[(row.war_type ?? '').toLowerCase().replace(/[^a-z]/g, '')];
    const start = Date.parse(row.first_seen);
    if (!kind || Number.isNaN(start)) {
      continue;
    }
    const end = row.ended_at ? Date.parse(row.ended_at) : Number.NaN;
    const outcome = (row.outcome ?? '').match(/^(.*)_won$/);
    spans.push({
      kind,
      family: kind === 'Election' ? 'election' : 'war',
      factionA: shortFactionName(row.faction_a),
      factionB: shortFactionName(row.faction_b),
      start,
      end: Number.isNaN(end) ? null : end,
      pending: row.status === 'pending',
      winner: outcome ? shortFactionName(outcome[1]) : null,
      wonA: row.won_days_a ?? null,
      wonB: row.won_days_b ?? null,
    });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** What the tooltip says about a conflict at `time`: its sides, then the latest score (open) or the result (finished). */
export function describeConflict(span: ConflictSpan): string {
  const sides = `${span.kind}${span.pending ? ' (pending)' : ''}: ${span.factionA} vs ${span.factionB}`;
  if (span.end !== null) {
    return `${sides} — ${span.winner ? `${span.winner} won` : 'ended'}`;
  }
  if (span.wonA !== null && span.wonB !== null && !span.pending) {
    return `${sides} — latest ${span.wonA}–${span.wonB} days`;
  }
  return sides;
}

/** The conflicts open at `time`. */
export function conflictsAt(spans: readonly ConflictSpan[], time: number): ConflictSpan[] {
  return spans.filter(s => s.start <= time && (s.end === null || time <= s.end));
}

/** The tracker's average-influence block (0-1 fractions, null where it has none) as reference lines. */
export function buildAverages(average: Readonly<Record<string, number | null>> | null | undefined): AverageLine[] {
  return Object.entries(average ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, fraction]) => ({ name, label: `${shortFactionName(name)} avg`, value: fraction * 100 }));
}

/** Every moment any faction has a reading, oldest first — the places the hover can land. */
export function snapshotTimes(series: readonly FactionSeries[]): number[] {
  const times = new Set<number>();
  for (const s of series) {
    for (const point of s.points) {
      times.add(point.time);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** The faction's influence in effect at `time`: its reading at that snapshot, else its latest earlier one; null before its first. */
export function valueAt(series: FactionSeries, time: number): number | null {
  return pointAt(series, time)?.value ?? null;
}

/** The faction's reading in effect at `time` (same rule as {@link valueAt}); null before its first. */
export function pointAt(series: FactionSeries, time: number): HistoryPoint | null {
  let found: HistoryPoint | null = null;
  for (const point of series.points) {
    if (point.time <= time) {
      found = point;
    } else {
      break;
    }
  }
  return found;
}

/** The index in `times` nearest to `time` (ties go to the later one); -1 if there are none. */
export function nearestIndex(times: readonly number[], time: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  times.forEach((candidate, index) => {
    const distance = Math.abs(candidate - time);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** The top of the influence axis: the highest value drawn, rounded up to the next 10%, never under 20% or over 100%. */
export function axisMax(series: readonly FactionSeries[], averages: readonly AverageLine[]): number {
  const highest = Math.max(0, ...series.flatMap(s => s.points.map(p => p.value)), ...averages.map(a => a.value));
  return Math.min(100, Math.max(20, Math.ceil(highest / 10) * 10));
}

/** The gridline values from 0 to `max`, about four steps. */
export function axisTicks(max: number): number[] {
  const step = max <= 20 ? 5 : max <= 50 ? 10 : 25;
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) {
    ticks.push(value);
  }
  return ticks;
}

/** Evenly spaced moments between `start` and `end` to label the time axis with; one if they coincide. */
export function timeTicks(start: number, end: number, count: number): number[] {
  if (end <= start || count < 2) {
    return [start];
  }
  return Array.from({ length: count }, (_unused, i) => start + ((end - start) * i) / (count - 1));
}
