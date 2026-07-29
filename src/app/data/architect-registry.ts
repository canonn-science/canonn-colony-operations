/**
 * The Architect Registry as a list of submissions, and the per-architect facts the Assign
 * dialog defaults its controls from.
 *
 * The registry is a Google Form response log, so it's append-only and ordered by date added:
 * a system or an architect can appear many times and the *last* row wins. Everything here
 * relies on that ordering rather than on the timestamp column, which isn't present in the
 * Cloud Function's version of the data.
 */

/** One Architect Registry submission. */
export interface ArchitectRegistryRow {
  systemName: string;
  architect: string;
  /** The "Canonn Architect" answer — one of the `AFFILIATION_*` values, or '' if unanswered. */
  affiliation: string;
  preferredFaction: string;
}

/** What the registry records about a system: the columns the table's Architect/Preferred Faction show. */
export interface ArchitectInfo {
  architect: string;
  /** The "Canonn Architect" answer this system's row was last recorded with — one of the `AFFILIATION_*` values, or ''. */
  affiliation: string;
  preferredFaction: string;
}

/** What the registry records about an architect, for pre-filling the Assign dialog. */
export interface ArchitectProfile {
  /** The architect's name as most recently spelled in the registry. */
  name: string;
  /** Their most recent non-blank affiliation answer, or null if they've never had one recorded. */
  affiliation: string | null;
  /** Their most recent non-blank preferred faction, or null. */
  preferredFaction: string | null;
  /** How many registry rows record them choosing {@link preferredFaction}. */
  preferredFactionCount: number;
}

/** Case-insensitive, whitespace-insensitive key for matching a name the user typed to the registry. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The system -> architect lookup the table's rows are built from; last row wins per system. */
export function buildArchitectInfoMap(rows: readonly ArchitectRegistryRow[]): Map<string, ArchitectInfo> {
  const map = new Map<string, ArchitectInfo>();
  for (const row of rows) {
    if (!row.systemName) {
      continue;
    }
    map.set(row.systemName, { architect: row.architect, affiliation: row.affiliation, preferredFaction: row.preferredFaction });
  }
  return map;
}

/** Every architect name in the registry, in the spelling of their most recent row, A-Z. */
export function architectNames(rows: readonly ArchitectRegistryRow[]): string[] {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    const name = row.architect.trim();
    if (name) {
      byKey.set(nameKey(name), name);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * The typeahead's suggestions for a partially-typed architect name: names containing `query`,
 * with those that *start* with it first, capped at `limit`.
 */
export function suggestArchitects(names: readonly string[], query: string, limit = 8): string[] {
  const key = nameKey(query);
  if (!key) {
    return names.slice(0, limit);
  }
  const startsWith: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const index = nameKey(name).indexOf(key);
    if (index === 0) {
      startsWith.push(name);
    } else if (index > 0) {
      contains.push(name);
    }
  }
  return [...startsWith, ...contains].slice(0, limit);
}

/**
 * What the registry already knows about the architect the user has typed, or null if the name
 * is new. `excludeSystemName`, when given, ignores that system's own rows — the dialog defaults
 * from what this architect has said *elsewhere*, not from a previous answer for the system
 * currently being assigned.
 */
export function findArchitectProfile(
  rows: readonly ArchitectRegistryRow[],
  name: string,
  excludeSystemName?: string,
): ArchitectProfile | null {
  const key = nameKey(name);
  if (!key) {
    return null;
  }
  const matches = rows.filter(row => nameKey(row.architect) === key && row.systemName !== excludeSystemName);
  if (matches.length === 0) {
    return null;
  }

  let affiliation: string | null = null;
  let preferredFaction: string | null = null;
  // Later rows are more recent, so the last non-blank answer of each kind is the current one.
  for (const row of matches) {
    if (row.affiliation.trim()) {
      affiliation = row.affiliation.trim();
    }
    if (row.preferredFaction.trim()) {
      preferredFaction = row.preferredFaction.trim();
    }
  }

  const preferredFactionCount = preferredFaction
    ? matches.filter(row => row.preferredFaction.trim() === preferredFaction).length
    : 0;

  return {
    name: matches[matches.length - 1].architect.trim(),
    affiliation,
    preferredFaction,
    preferredFactionCount,
  };
}
