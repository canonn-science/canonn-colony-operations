import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';

/** Factions present in fewer systems than this are left out of the clustered "faction web" (Plate 1). */
const WEB_MIN_PRESENCE = 15;
/** Two factions need at least this much lift (observed ÷ expected co-occurrence) to be linked in the web. */
const WEB_MIN_LIFT = 3;
/** How many of the clusters Louvain finds get a name/colour of their own; the rest fold into "Other". */
const MAX_NAMED_CLUSTERS = 8;
/** How many factions the chord diagram shows (the most widespread, Canonn/CDSR aside). */
const CHORD_FACTION_COUNT = 14;
/** How many controlling factions the "who controls Canonn's systems" bar list shows. */
const CONTROLLER_COUNT = 12;

const HUB_NAMES: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);

export interface FactionNode {
  id: string;
  /** Number of systems this faction has a presence in. */
  presence: number;
  /** Number of systems this faction controls. */
  controls: number;
  /** Cluster id (0-based, index into {@link FactionNetworkData.clusters}), or -1 if unclustered. */
  cluster: number;
}

export interface FactionLink {
  a: string;
  b: string;
  /** Number of systems both factions are present in. */
  shared: number;
  /** Observed ÷ expected shared-system count under independence. */
  lift: number;
}

export interface ClusterInfo {
  id: number;
  /** The cluster's most-widespread member, used as its label. */
  lead: string;
  /** Number of factions in the cluster. */
  size: number;
  /** Total presence (sum of member factions' system counts) — a rough "how big" measure. */
  presence: number;
}

export interface ChordData {
  names: string[];
  presence: number[];
  cluster: number[];
  /** Symmetric matrix of shared-system counts, same order as {@link names}. */
  matrix: number[][];
}

export interface MapSystem {
  systemName: string;
  x: number;
  y: number;
  z: number;
  controller: string | null;
  canonnPresent: boolean;
  /** Cluster of the system's strongest non-Canonn/CDSR faction, or -1 if none/unclustered. */
  cluster: number;
}

export interface ControllerTally {
  faction: string;
  count: number;
}

export interface FullNetworkNode {
  id: string;
  presence: number;
  cluster: number;
  isHub: boolean;
}

export interface FullNetworkLink {
  /** Indices into the full network's node array. */
  a: number;
  b: number;
  shared: number;
  /** True when one end is Canonn or CDSR itself — filterable separately from ordinary links. */
  isHub: boolean;
}

export interface FactionNetworkData {
  clusters: ClusterInfo[];
  web: { nodes: FactionNode[]; links: FactionLink[] };
  full: { nodes: FullNetworkNode[]; links: FullNetworkLink[] };
  chord: ChordData;
  map: MapSystem[];
  controllers: ControllerTally[];
  stats: { factions: number; pairs: number; webNodes: number; webLinks: number };
}

/** Every non-hub faction present in `row`, deduped (a faction never appears twice in one system's list). */
function factionsIn(row: BgsRow): string[] {
  return row.factions.filter(f => !HUB_NAMES.has(f.name)).map(f => f.name);
}

/** Order-independent key for an unordered pair of faction names. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Finds communities in a weighted undirected graph by greedy local modularity optimisation
 * (Louvain's first phase, single level — no multi-pass aggregation). Good enough to group a
 * few hundred nodes into a handful of clusters; not a faithful full Louvain implementation.
 */
function louvainClusters(nodeIds: readonly string[], edges: readonly { a: string; b: string; w: number }[]): Map<string, number> {
  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;
  const neighbors: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const degree = new Array<number>(n).fill(0);
  let m = 0;
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined || a === b || e.w <= 0) continue;
    neighbors[a].set(b, (neighbors[a].get(b) ?? 0) + e.w);
    neighbors[b].set(a, (neighbors[b].get(a) ?? 0) + e.w);
    degree[a] += e.w;
    degree[b] += e.w;
    m += e.w;
  }
  const community = nodeIds.map((_, i) => i);
  if (m === 0) {
    return new Map(nodeIds.map((id, i) => [id, i]));
  }
  const communityDegree = degree.slice();
  let improved = true;
  let pass = 0;
  while (improved && pass < 50) {
    improved = false;
    pass++;
    for (let i = 0; i < n; i++) {
      const current = community[i];
      communityDegree[current] -= degree[i];
      const weightToCommunity = new Map<number, number>();
      for (const [j, w] of neighbors[i]) {
        const cj = community[j];
        weightToCommunity.set(cj, (weightToCommunity.get(cj) ?? 0) + w);
      }
      let bestComm = current;
      let bestGain = (weightToCommunity.get(current) ?? 0) - (degree[i] * communityDegree[current]) / (2 * m);
      for (const [comm, wIn] of weightToCommunity) {
        if (comm === current) continue;
        const gain = wIn - (degree[i] * communityDegree[comm]) / (2 * m);
        if (gain > bestGain + 1e-9) {
          bestGain = gain;
          bestComm = comm;
        }
      }
      communityDegree[bestComm] += degree[i];
      if (bestComm !== current) {
        community[i] = bestComm;
        improved = true;
      }
    }
  }
  // Renumber communities to a dense 0..k-1 range.
  const renumber = new Map<number, number>();
  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const comm = community[i];
    if (!renumber.has(comm)) {
      renumber.set(comm, renumber.size);
    }
    result.set(nodeIds[i], renumber.get(comm)!);
  }
  return result;
}

/** Computes everything the Faction Atlas plates need, live, from the current BGS snapshot. */
export function computeFactionNetwork(rows: readonly BgsRow[]): FactionNetworkData {
  const presence = new Map<string, number>();
  const controls = new Map<string, number>();
  const coShared = new Map<string, number>();
  const canonnShared = new Map<string, number>();
  const cdsrShared = new Map<string, number>();
  const totalSystems = rows.length;

  for (const row of rows) {
    const factions = factionsIn(row);
    const hasCanonn = row.canonnInfluence !== null;
    const hasCdsr = row.cdsrInfluence !== null;
    for (const f of factions) {
      presence.set(f, (presence.get(f) ?? 0) + 1);
      if (row.controllingFaction === f) {
        controls.set(f, (controls.get(f) ?? 0) + 1);
      }
      if (hasCanonn) canonnShared.set(f, (canonnShared.get(f) ?? 0) + 1);
      if (hasCdsr) cdsrShared.set(f, (cdsrShared.get(f) ?? 0) + 1);
    }
    for (let i = 0; i < factions.length; i++) {
      for (let j = i + 1; j < factions.length; j++) {
        const key = pairKey(factions[i], factions[j]);
        coShared.set(key, (coShared.get(key) ?? 0) + 1);
      }
    }
  }

  const allFactionIds = [...presence.keys()];

  function lift(a: string, b: string, n: number): number {
    const expected = (presence.get(a)! * presence.get(b)!) / totalSystems;
    return expected > 0 ? n / expected : 0;
  }

  // --- Plate 1: the filtered "web" among widely-present factions. ---
  const webIds = allFactionIds.filter(id => (presence.get(id) ?? 0) >= WEB_MIN_PRESENCE);
  const webIdSet = new Set(webIds);
  const webEdges: { a: string; b: string; w: number; lift: number }[] = [];
  for (const [key, n] of coShared) {
    const [a, b] = key.split('\u0000');
    if (!webIdSet.has(a) || !webIdSet.has(b)) continue;
    const l = lift(a, b, n);
    if (l >= WEB_MIN_LIFT) {
      webEdges.push({ a, b, w: n, lift: l });
    }
  }

  const clusterByFaction = louvainClusters(webIds, webEdges.map(e => ({ a: e.a, b: e.b, w: e.w })));

  // Keep only the biggest MAX_NAMED_CLUSTERS communities named; fold the rest into "Other" (-1).
  const clusterSizePresence = new Map<number, number>();
  for (const id of webIds) {
    const c = clusterByFaction.get(id) ?? -1;
    clusterSizePresence.set(c, (clusterSizePresence.get(c) ?? 0) + (presence.get(id) ?? 0));
  }
  const rankedClusters = [...clusterSizePresence.entries()].sort((x, y) => y[1] - x[1]);
  const keptClusterIds = new Set(rankedClusters.slice(0, MAX_NAMED_CLUSTERS).map(([id]) => id));
  const clusterRenumber = new Map<number, number>();
  rankedClusters.forEach(([id]) => {
    if (keptClusterIds.has(id)) clusterRenumber.set(id, clusterRenumber.size);
  });

  function finalCluster(id: string): number {
    const raw = clusterByFaction.get(id);
    if (raw === undefined || !keptClusterIds.has(raw)) return -1;
    return clusterRenumber.get(raw)!;
  }

  const webNodes: FactionNode[] = webIds.map(id => ({
    id,
    presence: presence.get(id) ?? 0,
    controls: controls.get(id) ?? 0,
    cluster: finalCluster(id),
  }));
  const webLinks: FactionLink[] = webEdges.map(e => ({ a: e.a, b: e.b, shared: e.w, lift: e.lift }));

  const clusterMembers = new Map<number, string[]>();
  for (const node of webNodes) {
    if (node.cluster < 0) continue;
    const list = clusterMembers.get(node.cluster) ?? [];
    list.push(node.id);
    clusterMembers.set(node.cluster, list);
  }
  const clusters: ClusterInfo[] = [...clusterMembers.entries()]
    .map(([id, members]) => {
      const lead = members.reduce((best, m) => ((presence.get(m) ?? 0) > (presence.get(best) ?? 0) ? m : best), members[0]);
      return {
        id,
        lead,
        size: members.length,
        presence: members.reduce((sum, m) => sum + (presence.get(m) ?? 0), 0),
      };
    })
    .sort((a, b) => a.id - b.id);

  // --- Plate 2: the full network — every faction, every pair that shares at least one system. ---
  // Clustered nodes keep their web cluster; others take the cluster of whichever neighbour they
  // share the most systems with (a simple "vote by strongest connection" extension).
  const fullIds = allFactionIds;
  const fullIndex = new Map(fullIds.map((id, i) => [id, i]));
  const extendedCluster = new Map<string, number>();
  for (const id of fullIds) {
    const direct = clusterByFaction.has(id) ? finalCluster(id) : -1;
    extendedCluster.set(id, direct);
  }
  // One pass of neighbour voting for anyone still unclustered.
  const neighborWeight = new Map<string, Map<number, number>>();
  for (const [key, n] of coShared) {
    const [a, b] = key.split('\u0000');
    const ca = extendedCluster.get(a)!;
    const cb = extendedCluster.get(b)!;
    if (ca < 0 && cb >= 0) {
      const m = neighborWeight.get(a) ?? new Map<number, number>();
      m.set(cb, (m.get(cb) ?? 0) + n);
      neighborWeight.set(a, m);
    }
    if (cb < 0 && ca >= 0) {
      const m = neighborWeight.get(b) ?? new Map<number, number>();
      m.set(ca, (m.get(ca) ?? 0) + n);
      neighborWeight.set(b, m);
    }
  }
  for (const [id, weights] of neighborWeight) {
    let best = -1;
    let bestW = 0;
    for (const [c, w] of weights) {
      if (w > bestW) {
        bestW = w;
        best = c;
      }
    }
    extendedCluster.set(id, best);
  }

  const fullNodes: FullNetworkNode[] = fullIds.map(id => ({
    id,
    presence: presence.get(id) ?? 0,
    cluster: extendedCluster.get(id) ?? -1,
    isHub: false,
  }));
  const fullLinks: FullNetworkLink[] = [];
  for (const [key, n] of coShared) {
    const [a, b] = key.split('\u0000');
    fullLinks.push({ a: fullIndex.get(a)!, b: fullIndex.get(b)!, shared: n, isHub: false });
  }

  // Canonn and CDSR are drawn as two special hub nodes, linked to every faction they share a
  // system with — the "every connection" plate shows these as a distinct, toggleable layer.
  const hubSpecs: { name: string; shared: Map<string, number> }[] = [
    { name: CANONN_FACTION, shared: canonnShared },
    { name: CDSR_FACTION, shared: cdsrShared },
  ];
  const hubPresence = new Map<string, number>([
    [CANONN_FACTION, rows.filter(r => r.canonnInfluence !== null).length],
    [CDSR_FACTION, rows.filter(r => r.cdsrInfluence !== null).length],
  ]);
  for (const hub of hubSpecs) {
    const hubIndex = fullNodes.length;
    fullNodes.push({ id: hub.name, presence: hubPresence.get(hub.name) ?? 0, cluster: -2, isHub: true });
    for (const [faction, n] of hub.shared) {
      const idx = fullIndex.get(faction);
      if (idx === undefined) continue;
      fullLinks.push({ a: hubIndex, b: idx, shared: n, isHub: true });
    }
  }

  // --- Plate 3: chord diagram among the most widespread non-hub factions. ---
  const chordIds = [...allFactionIds].sort((a, b) => (presence.get(b) ?? 0) - (presence.get(a) ?? 0)).slice(0, CHORD_FACTION_COUNT);
  const chordIndex = new Map(chordIds.map((id, i) => [id, i]));
  const matrix: number[][] = chordIds.map(() => chordIds.map(() => 0));
  for (const [key, n] of coShared) {
    const [a, b] = key.split('\u0000');
    const ia = chordIndex.get(a);
    const ib = chordIndex.get(b);
    if (ia === undefined || ib === undefined) continue;
    matrix[ia][ib] = n;
    matrix[ib][ia] = n;
  }
  const chord: ChordData = {
    names: chordIds,
    presence: chordIds.map(id => presence.get(id) ?? 0),
    cluster: chordIds.map(id => extendedCluster.get(id) ?? -1),
    matrix,
  };

  // --- Plate 4: every system, coloured by its strongest non-hub faction's cluster. ---
  const map: MapSystem[] = rows.map(row => {
    const strongest = row.factions.find(f => !HUB_NAMES.has(f.name)) ?? null;
    const cluster = strongest ? extendedCluster.get(strongest.name) ?? -1 : -1;
    return {
      systemName: row.systemName,
      x: row.x,
      y: row.y,
      z: row.z,
      controller: row.controllingFaction,
      canonnPresent: row.canonnInfluence !== null,
      cluster,
    };
  });

  // --- Plate 5: who controls the systems Canonn is present in. ---
  const controllerTally = new Map<string, number>();
  for (const row of rows) {
    if (row.canonnInfluence === null) continue;
    const ctrl = row.controllingFaction;
    if (!ctrl || HUB_NAMES.has(ctrl)) continue;
    controllerTally.set(ctrl, (controllerTally.get(ctrl) ?? 0) + 1);
  }
  const controllers: ControllerTally[] = [...controllerTally.entries()]
    .map(([faction, count]) => ({ faction, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, CONTROLLER_COUNT);

  return {
    clusters,
    web: { nodes: webNodes, links: webLinks },
    full: { nodes: fullNodes, links: fullLinks },
    chord,
    map,
    controllers,
    stats: {
      factions: allFactionIds.length,
      pairs: coShared.size,
      webNodes: webNodes.length,
      webLinks: webLinks.length,
    },
  };
}
