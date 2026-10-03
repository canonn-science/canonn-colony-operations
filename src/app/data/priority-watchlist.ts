/**
 * The Priority Watchlist: a hand-curated sheet of systems Canonn cares about keeping (or
 * taking) above a specific rank, with a note explaining why. Parsed the same way as the
 * Architect Registry (tab-separated, header row first, columns matched by name) — see
 * `architect-registry.ts` and `CanonnBgsService`'s sheet-fetch fast path.
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

/**
 * Parses the Priority Watchlist sheet. Returns an empty array (which the caller treats as
 * "couldn't use this") if the expected columns aren't found, or if a row's Position isn't a
 * positive integer.
 */
export function parseWatchlistTsv(text: string): PriorityWatchlistEntry[] {
  const entries: PriorityWatchlistEntry[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.length > 0);
  if (lines.length === 0) {
    return entries;
  }

  const header = lines[0].split('\t');
  const systemIndex = header.indexOf('System');
  const factionIndex = header.indexOf('Faction');
  const positionIndex = header.indexOf('Position');
  const detailsIndex = header.indexOf('Details');
  if (systemIndex === -1 || factionIndex === -1 || positionIndex === -1 || detailsIndex === -1) {
    return entries;
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const systemName = cells[systemIndex]?.trim();
    const faction = cells[factionIndex]?.trim();
    const position = Number.parseInt(cells[positionIndex]?.trim() ?? '', 10);
    if (!systemName || !faction || !Number.isInteger(position) || position < 1) {
      continue;
    }
    entries.push({ systemName, faction, position, details: cells[detailsIndex]?.trim() ?? '' });
  }
  return entries;
}

/** The system -> entries lookup {@link BgsRow.watchlist} is built from; a system may carry more than one faction's entry. */
export function buildWatchlistMap(entries: readonly PriorityWatchlistEntry[]): Map<string, PriorityWatchlistEntry[]> {
  const map = new Map<string, PriorityWatchlistEntry[]>();
  for (const entry of entries) {
    const existing = map.get(entry.systemName);
    if (existing) {
      existing.push(entry);
    } else {
      map.set(entry.systemName, [entry]);
    }
  }
  return map;
}
