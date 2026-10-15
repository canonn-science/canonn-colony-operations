/**
 * How the table orders and narrows its rows. The API sends the whole list once; sorting and the
 * quick filters happen here, with the rules the API itself applies (its client guide, sections 5
 * and 6) so a given sort reads the same either side of the wire:
 *
 * - a row with no value for the sort key always goes *after* the rest, whichever direction is
 *   chosen — only the rows that have one reverse;
 * - the final tiebreak is the system name (case-insensitive, then exact);
 * - priority breaks its own ties on station count, then population, then body count, most first,
 *   in a direction that doesn't flip with the column's.
 */
import { BgsRow } from '../canonn-bgs.service';
import { distanceLy } from './distance';
import { parseUpdatedAt } from './freshness';
import { currentPriority } from './priority';

/** The columns the table can be ordered by. */
export type OrderColumn =
  | 'canonn'
  | 'cdsr'
  | 'controllingFaction'
  | 'architect'
  | 'preferredFaction'
  | 'factionCount'
  | 'freshness'
  | 'priority';

export type OrderDirection = 'asc' | 'desc';

/** A point rows can be ordered by distance from. */
export interface OrderOrigin {
  x: number;
  y: number;
  z: number;
}

/** The quick filters. Each one that is off is simply not applied; the rest combine with AND. */
export interface RowFilters {
  /** Canonn or CDSR is in, or about to enter, a war or election (what the State column's icons show). */
  warElection?: boolean;
  /** The reading is old enough that the system needs flying through again. */
  needsRecon?: boolean;
  /** Systems with no architect on record. */
  noArchitect?: boolean;
  /** Systems whose architect is this name (ignored alongside {@link noArchitect}). */
  architect?: string | null;
  /** Systems where any of these factions is present or is the preferred faction. */
  hasFaction?: readonly string[];
}

type SortValue = number | string | null;

function casefolded(value: string | null): string | null {
  const folded = (value ?? '').toLowerCase();
  return folded === '' ? null : folded;
}

function columnValue(row: BgsRow, column: OrderColumn): SortValue {
  switch (column) {
    case 'canonn':
      return row.canonnInfluence;
    case 'cdsr':
      return row.cdsrInfluence;
    case 'controllingFaction':
      return casefolded(row.controllingFaction);
    case 'architect':
      return casefolded(row.architect);
    case 'preferredFaction':
      return casefolded(row.preferredFaction);
    case 'factionCount':
      return row.factions.length;
    case 'freshness':
      // The last-seen time itself, so ascending reads "oldest first".
      return parseUpdatedAt(row.updatedAt);
    case 'priority':
      return row.priority.score;
  }
}

function compareValues(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNames(a: BgsRow, b: BgsRow): number {
  return (
    compareValues(a.systemName.toLowerCase(), b.systemName.toLowerCase()) || compareValues(a.systemName, b.systemName)
  );
}

/** Larger first, a missing value after every present one — fixed, whatever the column's direction. */
function compareMostFirstNullsLast(a: number | null, b: number | null): number {
  if (a === null) {
    return b === null ? 0 : 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

/**
 * `rows` by `value`, the rows with no value last. `tiebreaks` are applied, in order, as stable
 * sorts on top of the name order, so the last one listed is the most significant of them.
 */
function orderRows(
  rows: readonly BgsRow[],
  value: (row: BgsRow) => SortValue,
  direction: OrderDirection,
  tiebreaks: readonly ((row: BgsRow) => number | null)[] = [],
): BgsRow[] {
  const items = [...rows].sort(compareNames);
  for (const tiebreak of tiebreaks) {
    items.sort((a, b) => compareMostFirstNullsLast(tiebreak(a), tiebreak(b)));
  }
  const known: { row: BgsRow; value: number | string }[] = [];
  const unknown: BgsRow[] = [];
  for (const row of items) {
    const v = value(row);
    if (v === null) {
      unknown.push(row);
    } else {
      known.push({ row, value: v });
    }
  }
  const sign = direction === 'desc' ? -1 : 1;
  known.sort((a, b) => sign * compareValues(a.value, b.value));
  return [...known.map(k => k.row), ...unknown];
}

/** `rows` ordered by a column. */
export function sortRowsByColumn(rows: readonly BgsRow[], column: OrderColumn, direction: OrderDirection): BgsRow[] {
  const tiebreaks =
    column === 'priority'
      ? [
          (row: BgsRow) => row.bodyCount,
          (row: BgsRow) => row.population,
          (row: BgsRow) => row.stationCount,
        ]
      : [];
  return orderRows(rows, row => columnValue(row, column), direction, tiebreaks);
}

/** `rows` nearest first from `origin`; a row without coordinates goes last. */
export function sortRowsByDistance(rows: readonly BgsRow[], origin: OrderOrigin): BgsRow[] {
  return orderRows(
    rows,
    row => {
      const distance = distanceLy(origin, row);
      return Number.isFinite(distance) ? distance : null;
    },
    'asc',
  );
}

/** `rows` by name — the order the API sends them in, and the table's default. */
export function sortRowsByName(rows: readonly BgsRow[]): BgsRow[] {
  return [...rows].sort(compareNames);
}

/** The rows that pass every filter that's on, in their given order. `nowMs` dates the needs-recon test. */
export function filterRows(rows: readonly BgsRow[], filters: RowFilters, nowMs: number): BgsRow[] {
  const wanted = (filters.hasFaction ?? []).map(name => name.trim().toLowerCase()).filter(Boolean);
  const architect = (filters.architect ?? '').trim().toLowerCase();
  return rows.filter(row => {
    if (filters.warElection && row.warState === null && row.electionState === null) {
      return false;
    }
    if (filters.needsRecon && !currentPriority(row, nowMs).needsRecon) {
      return false;
    }
    if (filters.noArchitect) {
      if (row.architect !== null) {
        return false;
      }
    } else if (architect && (row.architect ?? '').toLowerCase() !== architect) {
      return false;
    }
    if (wanted.length > 0) {
      // A system counts if the faction is present there *or* is its preferred faction — which
      // includes the grey, Canonn-station-derived preference that no registry row records.
      const preferred = (row.preferredFaction ?? '').toLowerCase();
      const present = new Set(row.factions.map(f => f.name.toLowerCase()));
      if (!wanted.some(name => present.has(name) || name === preferred)) {
        return false;
      }
    }
    return true;
  });
}
