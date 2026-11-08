import { AFFILIATION_NOT_A_COLONY } from './architect-form';

/**
 * The architect "run rate": how many systems get an architect recorded each week, set against the
 * pace needed to cover every system by the target date.
 *
 * The tracker API carries no date for an architect record, so this reads the Architect Registry's
 * response sheet (a Google Form log with a Timestamp column) published as TSV.
 */

/** The date every system should have an architect on record by (26 Jul 2027, UTC — a year after the registry began). */
export const ARCHITECT_TARGET_DATE = Date.UTC(2027, 6, 26);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** How a recorded system's preferred faction is bucketed in the chart. */
export type RunRateGroup = 'C' | 'D' | 'O' | 'U';

export const RUN_RATE_GROUPS: readonly RunRateGroup[] = ['C', 'D', 'O', 'U'];

/** One registry submission with the time it was made. */
export interface TimedRegistryRow {
  systemName: string;
  preferredFaction: string;
  /** The "Canonn Architect" answer; {@link AFFILIATION_NOT_A_COLONY} records a system with no player builder. */
  affiliation: string;
  /** Epoch ms, taken from the sheet's Timestamp (read as UTC — the sheet gives no zone). */
  at: number;
}

/** One week of newly recorded systems. */
export interface RunRateWeek {
  /** Monday 00:00 UTC that starts the week (epoch ms). */
  start: number;
  C: number;
  D: number;
  O: number;
  U: number;
  total: number;
  /** How many of {@link total} were recorded as "not a colony" — they count as recorded, but are cleared rather than built. */
  notColony: number;
  /** True for the week still in progress, whose count is not yet final. */
  partial: boolean;
}

/** Systems still without an architect record at a moment in time. */
export interface BurndownPoint {
  /** Epoch ms. */
  at: number;
  remaining: number;
}

export interface RunRate {
  weeks: RunRateWeek[];
  /** Systems first recorded in the dated log, and how many of those were "not a colony". */
  loggedTotal: number;
  loggedNotColony: number;
  /**
   * Systems still unrecorded at the start of the first week and at the end of each week (the
   * current week ends at `now`), worked back from today's {@link remaining} by adding the systems
   * recorded since. Empty if there are no dated records.
   */
  burndown: BurndownPoint[];
  /** Systems still without an architect record. */
  remaining: number;
  /** Whole weeks left until {@link ARCHITECT_TARGET_DATE} (never below 1 while it is in the future, 0 once passed). */
  weeksLeft: number;
  /** Systems per week needed from now to finish on time; 0 if nothing is left. */
  neededPerWeek: number;
  /** Average per week over the last four *complete* weeks, or null if there are none. */
  recentPerWeek: number | null;
  /** When the recent pace would finish the job (epoch ms), or null if there is no pace or nothing left. */
  projectedFinish: number | null;
}

/** Splits TSV text into rows of cells, honouring Google's double-quoted cells (which may hold tabs and newlines). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A sheet timestamp like `26/07/2026 17:44:27` (day first) as epoch ms read as UTC, or null if it isn't one. */
export function parseSheetTimestamp(value: string): number | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(value);
  if (!m) {
    return null;
  }
  const [day, month, year, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(at);
  // Date.UTC rolls an impossible date (31/02) into the next month; reject it instead.
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? at : null;
}

/** The response sheet's rows, by its header names, skipping any row without a usable system and timestamp. */
export function parseRegistryLog(tsv: string): TimedRegistryRow[] {
  const [header, ...body] = parseTsv(tsv);
  if (!header) {
    return [];
  }
  const col = (name: string): number => header.findIndex(h => h.trim().toLowerCase() === name);
  const time = col('timestamp');
  const system = col('system name');
  const faction = col('preferred faction');
  const affiliation = col('canonn architect');
  if (time < 0 || system < 0) {
    return [];
  }
  const rows: TimedRegistryRow[] = [];
  for (const cells of body) {
    const at = parseSheetTimestamp(cells[time] ?? '');
    const systemName = (cells[system] ?? '').trim();
    if (at !== null && systemName) {
      rows.push({ systemName, preferredFaction: faction >= 0 ? (cells[faction] ?? '').trim() : '', affiliation: affiliation >= 0 ? (cells[affiliation] ?? '').trim() : '', at });
    }
  }
  return rows;
}

/** Monday 00:00 UTC of the week containing `at`. */
export function weekStart(at: number): number {
  const day = new Date(at);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS;
}

/**
 * Weekly new-system counts and the pace needed to finish.
 *
 * A system counts once, in the week of its *first* submission, bucketed by the preferred faction
 * given then (resubmissions are corrections, not new coverage). Weeks run from the first record to
 * the current one with empty weeks kept, so a quiet week shows as a gap rather than disappearing.
 *
 * @param canonn / cdsr  the faction names that bucket as Canonn and CDSR; any other name is "other",
 *                       and a blank one is "none".
 * @param totalSystems   every system the tracker knows
 * @param withRecord     how many of them already have an architect on record
 */
export function computeRunRate(
  rows: readonly TimedRegistryRow[],
  options: { canonn: string; cdsr: string; totalSystems: number; withRecord: number; now: number },
): RunRate {
  const first = new Map<string, TimedRegistryRow>();
  for (const row of rows) {
    const key = row.systemName.toLowerCase();
    const seen = first.get(key);
    if (!seen || row.at < seen.at) {
      first.set(key, row);
    }
  }

  const currentWeek = weekStart(options.now);
  const counts = new Map<number, RunRateWeek>();
  const blank = (start: number): RunRateWeek => ({ start, C: 0, D: 0, O: 0, U: 0, total: 0, notColony: 0, partial: start === currentWeek });
  for (const row of first.values()) {
    if (row.at > options.now) {
      continue;
    }
    const start = weekStart(row.at);
    const week = counts.get(start) ?? blank(start);
    const group: RunRateGroup =
      row.preferredFaction === options.canonn ? 'C' : row.preferredFaction === options.cdsr ? 'D' : row.preferredFaction ? 'O' : 'U';
    week[group]++;
    week.total++;
    if (row.affiliation === AFFILIATION_NOT_A_COLONY) {
      week.notColony++;
    }
    counts.set(start, week);
  }

  const weeks: RunRateWeek[] = [];
  if (counts.size > 0) {
    const earliest = Math.min(...counts.keys());
    for (let start = earliest; start <= currentWeek; start += WEEK_MS) {
      weeks.push(counts.get(start) ?? blank(start));
    }
  }

  const remaining = Math.max(0, options.totalSystems - options.withRecord);
  const weeksLeft = options.now >= ARCHITECT_TARGET_DATE ? 0 : Math.max(1, Math.ceil((ARCHITECT_TARGET_DATE - options.now) / WEEK_MS));
  const neededPerWeek = remaining === 0 ? 0 : Math.ceil(remaining / Math.max(1, weeksLeft));

  const complete = weeks.filter(w => !w.partial).slice(-4);
  const recentPerWeek = complete.length > 0 ? complete.reduce((sum, w) => sum + w.total, 0) / complete.length : null;
  const projectedFinish =
    remaining > 0 && recentPerWeek && recentPerWeek > 0 ? options.now + Math.ceil(remaining / recentPerWeek) * WEEK_MS : null;

  const burndown: BurndownPoint[] = [];
  if (weeks.length > 0) {
    let after = remaining;
    // Walk back from now: the end of each week has today's remainder plus everything recorded since.
    const ends: BurndownPoint[] = [];
    for (let i = weeks.length - 1; i >= 0; i--) {
      ends.unshift({ at: Math.min(weeks[i].start + WEEK_MS, options.now), remaining: after });
      after += weeks[i].total;
    }
    burndown.push({ at: weeks[0].start, remaining: after }, ...ends);
  }

  const loggedTotal = weeks.reduce((sum, w) => sum + w.total, 0);
  const loggedNotColony = weeks.reduce((sum, w) => sum + w.notColony, 0);

  return { weeks, loggedTotal, loggedNotColony, burndown, remaining, weeksLeft, neededPerWeek, recentPerWeek, projectedFinish };
}
