import { describe, expect, it } from 'vitest';
import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import { computeFactionNetwork } from './faction-network';

function row(partial: Partial<BgsRow> & { systemName: string }): BgsRow {
  return {
    systemAddress: '',
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    preferredFactionRecorded: false,
    hasCanonnStation: false,
    stationCount: null,
    factions: [],
    canonnHistory: [],
    cdsrHistory: [],
    influenceAverages: {},
    canonnChange: null,
    cdsrChange: null,
    factionDetails: [],
    stations: [],
    warState: null,
    warDetails: null,
    warIsCanonnVsCanonn: false,
    electionState: null,
    electionDetails: null,
    electionIsCanonnVsCanonn: false,
    retreatState: null,
    retreatDetails: null,
    expansionState: null,
    bodyCount: null,
    population: null,
    x: 0,
    y: 0,
    z: 0,
    updatedAt: null,
    watchlist: [],
    priority: { tier: 'not-applicable', mode: null, leadFaction: null, score: null, reasons: [], needsRecon: false, reconAgeDays: null },
    powerplay: null,
    ...partial,
  } as BgsRow;
}

function faction(name: string, influencePercent: number) {
  return { name, influencePercent };
}

describe('computeFactionNetwork', () => {
  // A and B always appear together (perfectly correlated); C is a loner.
  const rows: BgsRow[] = Array.from({ length: 20 }, (_, i) =>
    row({
      systemName: `Sys ${i}`,
      controllingFaction: i % 2 === 0 ? 'Alpha Union' : 'Beta League',
      canonnInfluence: i < 10 ? 40 : null,
      factions: [
        faction(CANONN_FACTION, i < 10 ? 40 : 0),
        faction('Alpha Union', 50),
        faction('Beta League', 45),
        ...(i < 2 ? [faction('Lone Wolves', 5)] : []),
      ].filter(f => f.influencePercent > 0 || f.name !== CANONN_FACTION || i < 10),
    }),
  );

  it('counts faction presence and controllers, keeping Canonn/CDSR as hub nodes only', () => {
    const net = computeFactionNetwork(rows);
    expect(net.stats.factions).toBeGreaterThan(0);
    const names = net.full.nodes.map(n => n.id);
    expect(names).toContain('Alpha Union');
    expect(names).toContain('Beta League');
    const hubNodes = net.full.nodes.filter(n => n.isHub);
    expect(hubNodes.map(n => n.id).sort()).toEqual([CANONN_FACTION, CDSR_FACTION]);
    const webNames = net.web.nodes.map(n => n.id);
    expect(webNames).not.toContain(CANONN_FACTION);
    expect(webNames).not.toContain(CDSR_FACTION);
  });

  it('every web node belongs to at most one cluster, and cluster ids are dense from 0', () => {
    const net = computeFactionNetwork(rows);
    const clusterIds = net.clusters.map(c => c.id);
    expect(new Set(clusterIds).size).toBe(clusterIds.length);
    if (clusterIds.length > 0) {
      expect(Math.min(...clusterIds)).toBe(0);
    }
    for (const node of net.web.nodes) {
      expect(node.cluster).toBeGreaterThanOrEqual(-1);
    }
  });

  it('builds a symmetric chord matrix', () => {
    const net = computeFactionNetwork(rows);
    for (let i = 0; i < net.chord.matrix.length; i++) {
      for (let j = 0; j < net.chord.matrix.length; j++) {
        expect(net.chord.matrix[i][j]).toBe(net.chord.matrix[j][i]);
      }
    }
  });

  it('tallies controllers of Canonn-present systems, excluding Canonn/CDSR themselves', () => {
    const net = computeFactionNetwork(rows);
    const factions = net.controllers.map(c => c.faction);
    expect(factions).not.toContain(CANONN_FACTION);
    expect(factions).not.toContain(CDSR_FACTION);
    const alpha = net.controllers.find(c => c.faction === 'Alpha Union');
    expect(alpha?.count).toBe(5); // even i < 10: i = 0,2,4,6,8
  });

  it('maps every system with a cluster field, present or -1', () => {
    const net = computeFactionNetwork(rows);
    expect(net.map.length).toBe(rows.length);
    for (const m of net.map) {
      expect(typeof m.cluster).toBe('number');
    }
  });

  it('returns empty structures gracefully for no rows', () => {
    const net = computeFactionNetwork([]);
    expect(net.web.nodes).toEqual([]);
    expect(net.full.nodes.every(n => n.isHub)).toBe(true);
    expect(net.controllers).toEqual([]);
    expect(net.map).toEqual([]);
  });
});
