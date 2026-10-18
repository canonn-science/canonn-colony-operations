import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';

/** Which of our two factions a conflict, lead or close-behind entry is about. */
export type UsSide = 'C' | 'D';

/** A conflict (war/civil war/election) against a third party, open now or about to start. */
export interface ConflictEntry {
  systemName: string;
  us: UsSide;
  /** The raw state name, e.g. "War", "CivilWar", "Election". */
  state: string;
  status: 'active' | 'pending';
}

/** One system where a rival faction's influence sits above or just below ours. */
export interface MarginEntry {
  systemName: string;
  us: UsSide;
  /** Rival influence minus our better faction's influence here, in points. Positive: they lead. */
  marginPoints: number;
}

/** A faction and every way it pushes back against Canonn or CDSR. */
export interface RivalRow {
  faction: string;
  conflicts: ConflictEntry[];
  /** Systems where this faction out-influences both Canonn and CDSR. */
  lead: MarginEntry[];
  /** Systems where it doesn't lead, but sits within 5 points of our better faction. */
  close: MarginEntry[];
  /** 5 per conflict, 1 per lead, 0.5 per close — the same weighting the published report used. */
  score: number;
}

const MARGIN_NAME = /** How close "close behind" counts as, in influence points. */ 5;

/** True for a 4367-style details line that opens a new entry, rather than an indented continuation (score/stake). */
function isTopLevelLine(line: string): boolean {
  return line.length > 0 && !/^\s/.test(line);
}

/** One parsed "State: A vs B" (or "... (pending)") line: the state name, which of us is a party, and who the opponent is. */
interface ParsedConflictLine {
  state: string;
  usSides: UsSide[];
  opponents: string[];
}

/**
 * Pulls the opponent faction(s) and state name out of a {@link BgsRow.warDetails}-shaped string.
 * `CanonnBgsService.summarizeFactionState` writes one top-level line per distinct match as
 * `"{State}: {A} vs {B}"`, optionally followed by indented score/stake lines and an " (pending)"
 * suffix; a vs-each-other match is skipped by the caller before this is ever reached.
 */
function parseConflictLines(details: string | null): ParsedConflictLine[] {
  if (!details) {
    return [];
  }
  return details
    .split('\n')
    .filter(isTopLevelLine)
    .map((line): ParsedConflictLine | null => {
      const colonIndex = line.indexOf(': ');
      if (colonIndex < 0) {
        return null;
      }
      const state = line.slice(0, colonIndex);
      const rest = line.slice(colonIndex + 2).replace(/\s*\(pending\)\s*$/, '');
      const names = rest.split(' vs ').map(name => name.trim());
      const usSides: UsSide[] = [];
      const opponents: string[] = [];
      for (const name of names) {
        if (name === CANONN_FACTION) {
          usSides.push('C');
        } else if (name === CDSR_FACTION) {
          usSides.push('D');
        } else if (name) {
          opponents.push(name);
        }
      }
      return opponents.length > 0 ? { state, usSides, opponents } : null;
    })
    .filter((parsed): parsed is ParsedConflictLine => parsed !== null);
}

function addConflicts(
  bucket: (faction: string) => { conflicts: ConflictEntry[] },
  row: BgsRow,
  details: string | null,
  isCanonnVsCanonn: boolean,
  status: 'active' | 'pending' | null,
): void {
  if (isCanonnVsCanonn || status === null) {
    return;
  }
  for (const { state, usSides, opponents } of parseConflictLines(details)) {
    for (const opponent of opponents) {
      for (const us of usSides) {
        bucket(opponent).conflicts.push({ systemName: row.systemName, us, state, status });
      }
    }
  }
}

/**
 * Every faction that currently fights, leads, or presses close against Canonn or CDSR, scored
 * and sorted highest-friction first — the live equivalent of the published report's Rivals
 * plate. Unlike that one-time snapshot, there's no week-old trend to compute "momentum" from
 * (the live feed carries Canonn/CDSR's own history, not a rival's), so this tracks three of its
 * four signals: open conflicts, systems where the rival leads, and systems within 5 points
 * behind. Pure and synchronous — safe to call on every fetch and to unit-test without a network.
 */
export function computeRivals(rows: readonly BgsRow[]): RivalRow[] {
  const byFaction = new Map<string, { conflicts: ConflictEntry[]; lead: MarginEntry[]; close: MarginEntry[] }>();
  const bucket = (faction: string) => {
    let entry = byFaction.get(faction);
    if (!entry) {
      entry = { conflicts: [], lead: [], close: [] };
      byFaction.set(faction, entry);
    }
    return entry;
  };

  for (const row of rows) {
    addConflicts(bucket, row, row.warDetails, row.warIsCanonnVsCanonn, row.warState);
    addConflicts(bucket, row, row.electionDetails, row.electionIsCanonnVsCanonn, row.electionState);

    const canonn = row.canonnInfluence;
    const cdsr = row.cdsrInfluence;
    if (canonn === null && cdsr === null) {
      continue;
    }
    const ourBest = Math.max(canonn ?? -1, cdsr ?? -1);
    const side: UsSide = (cdsr ?? -1) > (canonn ?? -1) ? 'D' : 'C';
    for (const faction of row.factions) {
      if (faction.name === CANONN_FACTION || faction.name === CDSR_FACTION) {
        continue;
      }
      const margin = faction.influencePercent - ourBest;
      if (margin > 0) {
        bucket(faction.name).lead.push({ systemName: row.systemName, us: side, marginPoints: margin });
      } else if (margin > -MARGIN_NAME) {
        bucket(faction.name).close.push({ systemName: row.systemName, us: side, marginPoints: margin });
      }
    }
  }

  return [...byFaction.entries()]
    .map(([faction, entry]) => ({
      faction,
      conflicts: entry.conflicts,
      lead: entry.lead,
      close: entry.close,
      score: 5 * entry.conflicts.length + entry.lead.length + 0.5 * entry.close.length,
    }))
    .filter(rival => rival.score > 0)
    .sort((a, b) => b.score - a.score || a.faction.localeCompare(b.faction));
}
