import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import { daysElapsed, parseUpdatedAt } from './freshness';
import { RivalRow, computeRivals } from './rivals';

/** How many systems each presence/control combination accounts for, mirroring the Colony Census report's "Footprint" plate. */
export interface FootprintStats {
  canonnC: number;
  canonnO: number;
  cdsrD: number;
  cdsrO: number;
  bothC: number;
  bothD: number;
  bothO: number;
  /** Neither Canonn nor CDSR has a presence here at all. */
  neither: number;
}

/** One architect and how many systems they have built. */
export interface ArchitectTally {
  name: string;
  count: number;
}

/** One preferred faction's record: how often it ended up in control versus lost to someone else. */
export interface PreferredFactionTally {
  faction: string;
  got: number;
  miss: number;
}

/** One station type and how many of them exist, with the broad family it belongs to for colouring. */
export interface StationTally {
  type: string;
  family: 'Construction' | 'Outpost' | 'Surface' | 'Starport' | 'Other' | 'Unknown';
  count: number;
}

/** One 5-point Canonn-influence band. */
export interface InfluenceBin {
  bucket: number;
  canonnControls: number;
  other: number;
}

/** One freshness bucket (e.g. "1-7 days"). */
export interface FreshnessBin {
  label: string;
  count: number;
}

/** Every aggregate the Colony Census page renders, computed once from a live BGS snapshot. */
export interface CensusStats {
  totalSystems: number;
  /** Systems with a recorded, non-placeholder architect. */
  colonies: number;
  /** Every architect with at least one colony, sorted by system count descending. */
  architects: ArchitectTally[];
  footprint: FootprintStats;
  /** Top preferred factions by systems recorded, with the remainder folded into a final "Other" row. */
  preferred: PreferredFactionTally[];
  stations: StationTally[];
  totalStations: number;
  depotCount: number;
  /** 20 bins covering 0-100% Canonn influence. */
  influenceBins: InfluenceBin[];
  freshnessBins: FreshnessBin[];
  /** Median age, in whole days, of systems with a known last-seen time; null if none have one. */
  medianAgeDays: number | null;
  /** Every faction that currently fights, leads, or presses close against Canonn or CDSR, highest-friction first. */
  rivals: RivalRow[];
}

const TOP_PREFERRED_FACTIONS = 7;

/** Canonn, CDSR, or "another faction" — the three buckets the footprint plate groups control by. */
function controllerCategory(controllingFaction: string | null): 'C' | 'D' | 'O' {
  if (controllingFaction === CANONN_FACTION) {
    return 'C';
  }
  if (controllingFaction === CDSR_FACTION) {
    return 'D';
  }
  return 'O';
}

/** Buckets a raw station type string (as the API sends it) into the broad family the stations plate colours by. */
function stationFamily(type: string | null): StationTally['family'] {
  if (!type) {
    return 'Unknown';
  }
  const normalized = type.toLowerCase();
  if (normalized.includes('construction depot')) {
    return 'Construction';
  }
  if (normalized.includes('starport') || normalized.includes('asteroid base')) {
    return 'Starport';
  }
  if (
    normalized.includes('settlement') ||
    normalized.includes('planetary outpost') ||
    normalized.includes('planetary port') ||
    normalized.includes('dockable planet')
  ) {
    return 'Surface';
  }
  if (normalized === 'outpost') {
    return 'Outpost';
  }
  return 'Other';
}

const FRESHNESS_BUCKETS: ReadonlyArray<{ label: string; minDays: number; maxDays: number }> = [
  { label: 'Today', minDays: 0, maxDays: 1 },
  { label: '1-7 days', minDays: 1, maxDays: 7 },
  { label: '1-4 weeks', minDays: 7, maxDays: 30 },
  { label: '1-3 months', minDays: 30, maxDays: 91 },
  { label: '3-6 months', minDays: 91, maxDays: 182 },
  { label: '6-12 months', minDays: 182, maxDays: 365 },
  { label: 'Over a year', minDays: 365, maxDays: Infinity },
];

/**
 * Computes every aggregate the Colony Census page shows, from a live {@link BgsRow} snapshot.
 * Pure and synchronous: safe to call on every {@link CanonnBgsService.getSystems} resolution,
 * and to unit-test without a network.
 */
export function computeCensusStats(rows: readonly BgsRow[], nowMs: number = Date.now()): CensusStats {
  const totalSystems = rows.length;

  const architectCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.architect && !row.notAColony) {
      architectCounts.set(row.architect, (architectCounts.get(row.architect) ?? 0) + 1);
    }
  }
  const architects = [...architectCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const colonies = architects.reduce((sum, a) => sum + a.count, 0);

  const footprint: FootprintStats = { canonnC: 0, canonnO: 0, cdsrD: 0, cdsrO: 0, bothC: 0, bothD: 0, bothO: 0, neither: 0 };
  for (const row of rows) {
    const canonnPresent = row.canonnInfluence !== null;
    const cdsrPresent = row.cdsrInfluence !== null;
    const category = controllerCategory(row.controllingFaction);
    if (canonnPresent && cdsrPresent) {
      if (category === 'C') footprint.bothC++;
      else if (category === 'D') footprint.bothD++;
      else footprint.bothO++;
    } else if (canonnPresent) {
      if (category === 'C') footprint.canonnC++;
      else footprint.canonnO++;
    } else if (cdsrPresent) {
      if (category === 'D') footprint.cdsrD++;
      else footprint.cdsrO++;
    } else {
      footprint.neither++;
    }
  }

  const preferredCounts = new Map<string, { got: number; miss: number }>();
  for (const row of rows) {
    if (!row.preferredFactionRecorded || !row.preferredFaction) {
      continue;
    }
    const entry = preferredCounts.get(row.preferredFaction) ?? { got: 0, miss: 0 };
    if (row.controllingFaction === row.preferredFaction) {
      entry.got++;
    } else {
      entry.miss++;
    }
    preferredCounts.set(row.preferredFaction, entry);
  }
  const preferredSorted = [...preferredCounts.entries()]
    .map(([faction, counts]) => ({ faction, got: counts.got, miss: counts.miss }))
    .sort((a, b) => b.got + b.miss - (a.got + a.miss));
  const preferred = preferredSorted.slice(0, TOP_PREFERRED_FACTIONS);
  const remainder = preferredSorted.slice(TOP_PREFERRED_FACTIONS);
  if (remainder.length > 0) {
    preferred.push({
      faction: `Other player factions (${remainder.length})`,
      got: remainder.reduce((sum, p) => sum + p.got, 0),
      miss: remainder.reduce((sum, p) => sum + p.miss, 0),
    });
  }

  const stationCounts = new Map<string, { family: StationTally['family']; count: number }>();
  let totalStations = 0;
  for (const row of rows) {
    for (const station of row.stations) {
      totalStations++;
      const type = station.type ?? 'Unknown';
      const entry = stationCounts.get(type) ?? { family: stationFamily(station.type), count: 0 };
      entry.count++;
      stationCounts.set(type, entry);
    }
  }
  const stations = [...stationCounts.entries()]
    .map(([type, entry]) => ({ type, family: entry.family, count: entry.count }))
    .sort((a, b) => b.count - a.count);
  const depotCount = stations.filter(s => s.family === 'Construction').reduce((sum, s) => sum + s.count, 0);

  const influenceBins: InfluenceBin[] = Array.from({ length: 20 }, (_, i) => ({ bucket: i * 5, canonnControls: 0, other: 0 }));
  for (const row of rows) {
    if (row.canonnInfluence === null) {
      continue;
    }
    const index = Math.min(19, Math.floor(row.canonnInfluence / 5));
    if (row.controllingFaction === CANONN_FACTION) {
      influenceBins[index].canonnControls++;
    } else {
      influenceBins[index].other++;
    }
  }

  const freshnessBins = FRESHNESS_BUCKETS.map(bucket => ({ label: bucket.label, count: 0 }));
  const ages: number[] = [];
  let unknownAge = 0;
  for (const row of rows) {
    const updatedAtMs = parseUpdatedAt(row.updatedAt);
    if (updatedAtMs === null) {
      unknownAge++;
      continue;
    }
    const days = daysElapsed(updatedAtMs, nowMs);
    ages.push(days);
    const bucketIndex = FRESHNESS_BUCKETS.findIndex(b => days >= b.minDays && days < b.maxDays);
    if (bucketIndex >= 0) {
      freshnessBins[bucketIndex].count++;
    }
  }
  if (unknownAge > 0) {
    freshnessBins.push({ label: 'Unknown', count: unknownAge });
  }
  ages.sort((a, b) => a - b);
  const medianAgeDays = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : null;

  const rivals = computeRivals(rows);

  return {
    totalSystems,
    colonies,
    architects,
    footprint,
    preferred,
    stations,
    totalStations,
    depotCount,
    influenceBins,
    freshnessBins,
    medianAgeDays,
    rivals,
  };
}
