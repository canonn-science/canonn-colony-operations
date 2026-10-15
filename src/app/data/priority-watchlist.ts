/**
 * The Priority Watchlist: a hand-curated list of systems Canonn cares about keeping (or
 * taking) above a specific rank, with a note explaining why. The BGS API sends each system's
 * entry (`bgs_override`) with the system itself.
 */

/** One row of the Priority Watchlist sheet. */
export interface PriorityWatchlistEntry {
  systemName: string;
  /** The faction (Canonn or Canonn Deep Space Research) this entry is tracking. */
  faction: string;
  /** The worst acceptable rank (1 = top) for {@link faction} among the system's factions. */
  position: number;
  /** Why this system is being watched — shown in the info dialog and the export. */
  details: string;
}
