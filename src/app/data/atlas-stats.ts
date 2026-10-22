import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import {
  AFFILIATION_CANONN_MEMBER,
  AFFILIATION_NOT_A_COLONY,
  AFFILIATION_NOT_MEMBER,
  AFFILIATION_UNKNOWN,
} from './architect-form';
import { distanceLy, Point3 } from './distance';
import { daysElapsed, parseUpdatedAt } from './freshness';

/**
 * The aggregates behind the "atlas" plates on the Architects and Factions tabs — the story-style
 * infographics (footprint grid, architect records, recon list, margins, retreat watch, this
 * week's movers, the Varati map, Canonn-named stations, neighbours and powers). Pure and
 * synchronous, computed from the same live {@link BgsRow} snapshot as the rest of the census.
 */

/** Which faction a system's recorded preference names: Canonn, CDSR, another faction, or none recorded. */
export type PrefGroup = 'C' | 'D' | 'O' | 'U';
/** Who controls a system: Canonn, CDSR or another faction. */
export type CtrlGroup = 'C' | 'D' | 'O';
/** 1 = a named architect, 2 = recorded as "not a colony", 0 = nothing on record yet. */
export type ArchStatus = 0 | 1 | 2;

/** One system as the footprint grid and the map draw it. */
export interface AtlasSystem {
  name: string;
  x: number;
  z: number;
  pref: PrefGroup;
  ctrl: CtrlGroup;
  arch: ArchStatus;
  /** Light years from Varati. */
  fromVarati: number;
  canonnInfluence: number | null;
  cdsrInfluence: number | null;
  /** The preferred (or, failing that, controlling) Canonn faction's 7-day change in points, if known. */
  weekChange: number | null;
}

/** Architect-record coverage for one preference group. */
export interface ArchCoverage {
  group: PrefGroup;
  total: number;
  named: number;
  notColony: number;
  none: number;
}

/** A system that has no architect record but looks like an untouched colony with Canonn or CDSR third. */
export interface ReconCandidate {
  name: string;
  /** 'C' when Canonn is third, 'D' when CDSR is. */
  us: 'C' | 'D';
  influence: number;
  leader: string;
  leaderInfluence: number;
  /** Whether the split is exactly the founding 60 / 20 / 13 / 7. */
  exact: boolean;
  /** Whether Canonn or CDSR also leads the system. */
  ledByUs: boolean;
  fromVarati: number;
}

/** A recorded Canonn-preferred system currently run by another faction. */
export interface ControlGap {
  name: string;
  controller: string;
  /** Points Canonn trails the controller by (0 on a tie). */
  behind: number;
  priorityTier: string;
}

/** A Canonn- or CDSR-run system and its lead over the second faction, in points. */
export interface MarginPoint {
  name: string;
  ctrl: 'C' | 'D';
  margin: number;
  /** Recorded Canonn-preferred and Canonn-controlled: one of "our" home systems. */
  home: boolean;
}

/** Canonn or CDSR below 5% influence somewhere, and whether retreat is even possible there. */
export interface LowInfluence {
  name: string;
  us: 'C' | 'D';
  influence: number;
  factions: number;
  /** Retreat only happens with more than three factions in the system. */
  retreatPossible: boolean;
  pref: PrefGroup;
}

/** A 7-day move in a recorded Canonn/CDSR-preferred system. */
export interface Mover {
  name: string;
  us: 'C' | 'D';
  points: number;
  controller: string | null;
}

/** A recent influence history, for a sparkline. */
export interface Spark {
  name: string;
  us: 'C' | 'D';
  values: number[];
}

/** A station with "canonn" in its name. */
export interface NamedStation {
  name: string;
  type: string | null;
  controller: string | null;
  system: string;
  /** Who runs it: Canonn, CDSR, a builder (construction site) or another faction. */
  owner: 'C' | 'D' | 'B' | 'O';
}

/** An architect and how many of their systems prefer each faction group. */
export interface Builder {
  name: string;
  count: number;
  byPref: Record<PrefGroup, number>;
}

export interface AtlasStats {
  systems: AtlasSystem[];
  /** Every architect with a named system, most systems first. */
  builders: Builder[];
  prefCounts: Record<PrefGroup, number>;
  coverage: ArchCoverage[];
  /** Systems carrying any architect record (named or "not a colony"). */
  withRecord: number;
  /** Architect-affiliation answers across all systems; `none` = nothing recorded. */
  affiliation: {
    member: number;
    notMember: number;
    unknown: number;
    notColony: number;
    none: number;
  };
  recon: ReconCandidate[];
  /** Rows: preference group; columns: controller group. */
  matrix: Record<Exclude<PrefGroup, 'U'>, Record<CtrlGroup, number>> & {
    U: Record<CtrlGroup, number>;
  };
  controlGaps: ControlGap[];
  margins: MarginPoint[];
  homeBands: { total: number; close: number; middle: number; healthy: number };
  /** How many systems have 1, 2, 3 … minor factions. */
  factionCounts: { factions: number; systems: number }[];
  /** Systems with three or fewer factions, where retreat cannot happen. */
  retreatProof: number;
  lowInfluence: LowInfluence[];
  /** Systems with at least five days of history, and how many of those moved less than half a point in seven days. */
  week: { withHistory: number; flat: number };
  movers: Mover[];
  sparks: Spark[];
  named: NamedStation[];
  neighbours: { faction: string; systems: number }[];
  powers: { power: string; systems: number }[];
  powerStates: { state: string; systems: number }[];
  /** Canonn/CDSR-run systems inside some power's territory. */
  inPowerSpace: number;
  medianFromVarati: { canonn: number | null; cdsr: number | null };
  /** Share of systems last seen more than 30 days ago (0-1), and that count. */
  stale: { over30: number; share: number };
  varati: Point3 | null;
}

const VARATI_FALLBACK: Point3 = { x: -178.65625, y: 77.125, z: -87.125 };

export function prefGroup(row: BgsRow): PrefGroup {
  if (!row.preferredFactionRecorded || !row.preferredFaction) {
    return 'U';
  }
  if (row.preferredFaction === CANONN_FACTION) return 'C';
  if (row.preferredFaction === CDSR_FACTION) return 'D';
  return 'O';
}

export function ctrlGroup(controller: string | null): CtrlGroup {
  if (controller === CANONN_FACTION) return 'C';
  if (controller === CDSR_FACTION) return 'D';
  return 'O';
}

export function archStatus(row: BgsRow): ArchStatus {
  if (row.notAColony) return 2;
  return row.architect ? 1 : 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function near(value: number, target: number, tolerance: number): boolean {
  return Math.abs(value - target) <= tolerance;
}

function weekPoints(change: BgsRow['canonnChange']): number | null {
  return change && change.window === '7d' && (change.spanDays ?? 0) >= 5 ? change.points : null;
}

/** Computes every atlas-plate aggregate from a live snapshot. */
export function computeAtlasStats(rows: readonly BgsRow[], nowMs: number = Date.now()): AtlasStats {
  const varatiRow = rows.find((r) => r.systemName === 'Varati');
  const varati: Point3 = varatiRow
    ? { x: varatiRow.x, y: varatiRow.y, z: varatiRow.z }
    : VARATI_FALLBACK;

  const prefCounts: Record<PrefGroup, number> = { C: 0, D: 0, O: 0, U: 0 };
  const coverageMap = new Map<PrefGroup, ArchCoverage>(
    (['C', 'D', 'O', 'U'] as PrefGroup[]).map((g) => [
      g,
      { group: g, total: 0, named: 0, notColony: 0, none: 0 },
    ]),
  );
  const affiliation = { member: 0, notMember: 0, unknown: 0, notColony: 0, none: 0 };
  const matrix = {
    C: { C: 0, D: 0, O: 0 },
    D: { C: 0, D: 0, O: 0 },
    O: { C: 0, D: 0, O: 0 },
    U: { C: 0, D: 0, O: 0 },
  };
  const systems: AtlasSystem[] = [];
  const recon: ReconCandidate[] = [];
  const controlGaps: ControlGap[] = [];
  const margins: MarginPoint[] = [];
  const lowInfluence: LowInfluence[] = [];
  const movers: Mover[] = [];
  const sparkPool: (Spark & { range: number })[] = [];
  const named: NamedStation[] = [];
  const builderMap = new Map<string, Builder>();
  const factionCountMap = new Map<number, number>();
  const neighbourMap = new Map<string, number>();
  const powerMap = new Map<string, number>();
  const powerStateMap = new Map<string, number>();
  let inPowerSpace = 0;
  let withHistory = 0;
  let flat = 0;
  let over30 = 0;
  const distC: number[] = [];
  const distD: number[] = [];

  for (const row of rows) {
    const pref = prefGroup(row);
    const ctrl = ctrlGroup(row.controllingFaction);
    const arch = archStatus(row);
    const fromVarati = distanceLy(row, varati);
    prefCounts[pref]++;
    const cov = coverageMap.get(pref)!;
    cov.total++;
    if (arch === 1) cov.named++;
    else if (arch === 2) cov.notColony++;
    else cov.none++;

    const aff = row.architectAffiliation ?? null;
    if (arch === 2 || aff === AFFILIATION_NOT_A_COLONY) affiliation.notColony++;
    else if (aff === AFFILIATION_CANONN_MEMBER) affiliation.member++;
    else if (aff === AFFILIATION_NOT_MEMBER) affiliation.notMember++;
    else if (aff === AFFILIATION_UNKNOWN || (aff === null && arch === 1)) affiliation.unknown++;
    else affiliation.none++;

    matrix[pref][ctrl]++;
    if (arch === 1 && row.architect) {
      const b = builderMap.get(row.architect) ?? {
        name: row.architect,
        count: 0,
        byPref: { C: 0, D: 0, O: 0, U: 0 },
      };
      b.count++;
      b.byPref[pref]++;
      builderMap.set(row.architect, b);
    }
    if (ctrl === 'C') distC.push(fromVarati);
    if (ctrl === 'D') distD.push(fromVarati);

    // The preferred faction's movement, or the controller's when no Canonn faction is preferred.
    const usKey: 'C' | 'D' | null =
      pref === 'C' || pref === 'D' ? pref : ctrl === 'C' || ctrl === 'D' ? ctrl : null;
    const change =
      usKey === 'C'
        ? weekPoints(row.canonnChange)
        : usKey === 'D'
          ? weekPoints(row.cdsrChange)
          : null;
    const anyChange = weekPoints(row.canonnChange) ?? weekPoints(row.cdsrChange);
    if (anyChange !== null) {
      withHistory++;
      if (Math.abs(anyChange) < 0.5) flat++;
    }

    systems.push({
      name: row.systemName,
      x: row.x,
      z: row.z,
      pref,
      ctrl,
      arch,
      fromVarati,
      canonnInfluence: row.canonnInfluence,
      cdsrInfluence: row.cdsrInfluence,
      weekChange: change ?? anyChange,
    });

    const factions = row.factions;
    factionCountMap.set(factions.length, (factionCountMap.get(factions.length) ?? 0) + 1);
    for (const f of factions) {
      if (f.name !== CANONN_FACTION && f.name !== CDSR_FACTION) {
        neighbourMap.set(f.name, (neighbourMap.get(f.name) ?? 0) + 1);
      }
    }

    // Recon: no architect record, no recorded preference, Canonn/CDSR third on the founding split.
    if (arch === 0 && aff === null && pref === 'U' && factions.length >= 3) {
      const third = factions[2];
      const leader = factions[0];
      const sparkline =
        third.name === CANONN_FACTION
          ? row.canonnHistory
          : third.name === CDSR_FACTION
            ? row.cdsrHistory
            : [];
      const unmoved = sparkline.length < 2 || Math.max(...sparkline) - Math.min(...sparkline) < 0.5;
      if (
        (third.name === CANONN_FACTION || third.name === CDSR_FACTION) &&
        near(third.influencePercent, 13, 0.6) &&
        near(leader.influencePercent, 60, 1.5) &&
        unmoved
      ) {
        recon.push({
          name: row.systemName,
          us: third.name === CANONN_FACTION ? 'C' : 'D',
          influence: third.influencePercent,
          leader: leader.name,
          leaderInfluence: leader.influencePercent,
          exact:
            near(third.influencePercent, 13, 0.005) && near(leader.influencePercent, 60, 0.005),
          ledByUs: leader.name === CANONN_FACTION || leader.name === CDSR_FACTION,
          fromVarati,
        });
      }
    }

    if (pref === 'C' && ctrl !== 'C' && factions.length) {
      controlGaps.push({
        name: row.systemName,
        controller: row.controllingFaction ?? factions[0].name,
        behind: Math.max(0, factions[0].influencePercent - (row.canonnInfluence ?? 0)),
        priorityTier: row.priority?.tier ?? '',
      });
    }

    if ((ctrl === 'C' || ctrl === 'D') && factions.length) {
      const own =
        factions.find((f) => f.name === row.controllingFaction)?.influencePercent ??
        factions[0].influencePercent;
      const best =
        factions.filter((f) => f.name !== row.controllingFaction)[0]?.influencePercent ?? 0;
      margins.push({
        name: row.systemName,
        ctrl,
        margin: own - best,
        home: pref === 'C' && ctrl === 'C',
      });
      const pp = row.powerplay;
      if (pp && pp.powers.length) {
        inPowerSpace++;
        for (const p of pp.powers) powerMap.set(p, (powerMap.get(p) ?? 0) + 1);
      }
      const state = pp?.state ?? 'Outside power space';
      powerStateMap.set(state, (powerStateMap.get(state) ?? 0) + 1);
    }

    for (const [us, inf] of [
      ['C', row.canonnInfluence],
      ['D', row.cdsrInfluence],
    ] as const) {
      if (inf !== null && inf < 5) {
        lowInfluence.push({
          name: row.systemName,
          us,
          influence: inf,
          factions: factions.length,
          retreatPossible: factions.length > 3,
          pref,
        });
      }
    }

    if ((pref === 'C' || pref === 'D') && change !== null) {
      movers.push({
        name: row.systemName,
        us: pref,
        points: change,
        controller: row.controllingFaction,
      });
    }
    if (pref === 'C' || pref === 'D') {
      const history = pref === 'C' ? row.canonnHistory : row.cdsrHistory;
      if (history.length >= 8) {
        sparkPool.push({
          name: row.systemName,
          us: pref,
          values: history,
          range: Math.max(...history) - Math.min(...history),
        });
      }
    }

    for (const st of row.stations) {
      if (/canonn/i.test(st.name)) {
        const building =
          /construction/i.test(`${st.name} ${st.type ?? ''}`) ||
          st.controllingFaction === 'Brewer Corporation';
        named.push({
          name: st.name.replace(/^(Orbital|Planetary) Construction Site:\s*/i, ''),
          type: st.type,
          controller: st.controllingFaction,
          system: row.systemName,
          owner: building
            ? 'B'
            : st.controllingFaction === CANONN_FACTION
              ? 'C'
              : st.controllingFaction === CDSR_FACTION
                ? 'D'
                : 'O',
        });
      }
    }

    const updated = parseUpdatedAt(row.updatedAt);
    if (updated !== null && daysElapsed(updated, nowMs) > 30) over30++;
  }

  const home = margins.filter((m) => m.home);
  const sortDesc = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const withRecord = [...coverageMap.values()].reduce((sum, c) => sum + c.named + c.notColony, 0);

  return {
    systems,
    builders: [...builderMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    prefCounts,
    coverage: [...coverageMap.values()],
    withRecord,
    affiliation,
    recon: recon.sort((a, b) => a.fromVarati - b.fromVarati),
    matrix,
    controlGaps: controlGaps.sort((a, b) => a.behind - b.behind || a.name.localeCompare(b.name)),
    margins,
    homeBands: {
      total: home.length,
      close: home.filter((m) => m.margin < 5).length,
      middle: home.filter((m) => m.margin >= 5 && m.margin < 15).length,
      healthy: home.filter((m) => m.margin >= 15).length,
    },
    factionCounts: [...factionCountMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([factions, n]) => ({ factions, systems: n })),
    retreatProof: [...factionCountMap.entries()]
      .filter(([f]) => f <= 3)
      .reduce((s, [, n]) => s + n, 0),
    lowInfluence: lowInfluence.sort(
      (a, b) => Number(b.retreatPossible) - Number(a.retreatPossible) || a.influence - b.influence,
    ),
    week: { withHistory, flat },
    movers: movers.sort((a, b) => a.points - b.points),
    sparks: sparkPool
      .sort((a, b) => b.range - a.range)
      .slice(0, 12)
      .map(({ name, us, values }) => ({ name, us, values })),
    named: named.sort(
      (a, b) => 'ODCB'.indexOf(a.owner) - 'ODCB'.indexOf(b.owner) || a.name.localeCompare(b.name),
    ),
    neighbours: sortDesc(neighbourMap)
      .slice(0, 12)
      .map(([faction, n]) => ({ faction, systems: n })),
    powers: sortDesc(powerMap)
      .slice(0, 10)
      .map(([power, n]) => ({ power, systems: n })),
    powerStates: sortDesc(powerStateMap).map(([state, n]) => ({ state, systems: n })),
    inPowerSpace,
    medianFromVarati: { canonn: median(distC), cdsr: median(distD) },
    stale: { over30, share: rows.length ? over30 / rows.length : 0 },
    varati: varatiRow ? varati : null,
  };
}
