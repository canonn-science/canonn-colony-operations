import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import * as d3 from 'd3';
import { CanonnBgsService, BgsRow } from '../canonn-bgs.service';
import { CensusStats, computeCensusStats } from '../data/census-stats';
import { ConflictEntry, MarginEntry, RivalRow, UsSide } from '../data/rivals';
import { daysElapsed, parseUpdatedAt } from '../data/freshness';
import {
  ChordData,
  FactionNetworkData,
  FactionNode,
  MapSystem,
  computeFactionNetwork,
} from '../data/faction-network';
import { LoadingTerminalComponent } from '../loading-terminal/loading-terminal.component';
import { CensusAtlasComponent } from '../census-atlas/census-atlas.component';
import { AtlasStats, computeAtlasStats } from '../data/atlas-stats';

type LoadStatus = 'loading' | 'ready' | 'error';
type RivalsUsFilter = 'all' | UsSide;
type RivalsSort = 'score' | 'conf' | 'lead';

/** Where the station-family colour comes from in the template; kept here so the template stays declarative. */
const STATION_FAMILY_COLOR: Record<string, string> = {
  Construction: 'var(--cc-s2)',
  Outpost: 'var(--cc-c2)',
  Surface: 'var(--cc-c4)',
  Starport: 'var(--cc-s7)',
  Other: 'var(--cc-s0)',
  Unknown: 'var(--cc-s0)',
};

/** One footprint-strip segment: a controller category within a presence group. */
interface FootprintSegment {
  key: 'C' | 'D' | 'O';
  label: string;
  value: number;
}

interface FootprintGroup {
  label: string;
  segments: FootprintSegment[];
  total: number;
}

/** One row of the architect distribution chart. */
interface ArchitectDistBin {
  label: string;
  minCount: number;
  maxCount: number;
  architects: number;
  systems: number;
}

/** One dot on the population-vs-distance scatter. */
interface PopulationPoint {
  systemName: string;
  distanceLy: number;
  population: number;
  hasArchitect: boolean;
  stationCount: number | null;
  controllingFaction: string | null;
}

/** A rival row with every one-sided tally resolved against the current "whose rivals" filter. */
interface FilteredRival {
  faction: string;
  conflicts: ConflictEntry[];
  lead: MarginEntry[];
  close: MarginEntry[];
  score: number;
  /** Friction attributable to Canonn / CDSR specifically — drives the "us" node link widths. */
  sideScore: { C: number; D: number };
}

const ARCHITECT_DIST_BINS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '1', min: 1, max: 1 },
  { label: '2', min: 2, max: 2 },
  { label: '3–5', min: 3, max: 5 },
  { label: '6–10', min: 6, max: 10 },
  { label: '11–25', min: 11, max: 25 },
  { label: '26+', min: 26, max: Infinity },
];

const RIVALS_SHOWN = 24;
const CLOSE_BAND_POINTS = 5;

/** Plate 7 (faction web) simulation node — a live-simulated faction, force-settled on screen. */
type WebNode = FactionNode & d3.SimulationNodeDatum;

/** Plate 8 (full network) simulation node: `ox`/`oy` are the settled baseline position the view tweens back to at minShared = 1. */
interface FNNode extends d3.SimulationNodeDatum {
  idx: number;
  id: string;
  presence: number;
  cluster: number;
  isHub: boolean;
  ox: number;
  oy: number;
}

interface FNLink {
  a: FNNode;
  b: FNNode;
  shared: number;
  isHub: boolean;
}

/** An adjacency entry: [neighbour, shared-system count, the link itself]. */
type FNAdjEntry = [FNNode, number, FNLink];

/**
 * Shown as the Architects and Factions tabs (see `section`). A live-data companion to the published "Canonn Colony Census" and "Canonn Faction Atlas"
 * reports: the same visual language (plates, stat tiles, the Saira/IBM Plex type system) and
 * the same interactive charts — rivals, architects with a per-architect map, a population
 * scatter, influence and freshness histograms — but every number and every chart here is drawn
 * from whatever {@link CanonnBgsService.getSystems} has loaded right now, refreshed on request,
 * instead of a one-time snapshot baked into a published page.
 *
 * One signal does differ from that published report: it tracked each rival's 7-day influence
 * *momentum*, which needs a faction's history over time. The live feed only carries that
 * history for Canonn and CDSR themselves, not for third-party factions, so momentum is left
 * out here; the rivals plate instead shows a numeric friction score in its place.
 */
@Component({
  selector: 'app-colony-census',
  imports: [LoadingTerminalComponent, CensusAtlasComponent],
  templateUrl: './colony-census.component.html',
  styleUrl: './colony-census.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColonyCensusComponent implements OnInit, OnDestroy {
  /** Which half of the census this instance shows: the architect plates, or the faction plates. */
  readonly section = input<'architects' | 'factions'>('architects');

  private readonly bgsService = inject(CanonnBgsService);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly status = signal<LoadStatus>('loading');
  protected readonly errorMessage = signal('');
  protected readonly generatedAt = signal<string | null>(null);
  protected readonly rows = signal<readonly BgsRow[]>([]);
  protected readonly stats = signal<CensusStats | null>(null);
  protected readonly loadLog = this.bgsService.loadLog;
  protected readonly stationFamilyColor = STATION_FAMILY_COLOR;

  protected readonly tooltip = signal<{ visible: boolean; x: number; y: number; html: string }>({
    visible: false,
    x: 0,
    y: 0,
    html: '',
  });

  /** The story-style "atlas" plates' aggregates, from the same rows. */
  protected readonly atlas = computed((): AtlasStats | null => (this.rows().length ? computeAtlasStats(this.rows()) : null));
  /** How often a recorded preference ended up in control, across every preferred faction. */
  protected readonly preferenceHit = computed(() => {
    const prefs = this.stats()?.preferred ?? [];
    const got = prefs.reduce((sum, p) => sum + p.got, 0);
    const all = prefs.reduce((sum, p) => sum + p.got + p.miss, 0);
    return this.pct(got, all);
  });
  /** Low-influence Canonn/CDSR systems with enough factions for a retreat to be possible. */
  protected readonly retreatPossible = computed(() => this.atlas()?.lowInfluence.filter(l => l.retreatPossible).length ?? 0);

  // ---- Architects --------------------------------------------------------------------------
  protected readonly architectQuery = signal('');
  protected readonly selectedArchitect = signal<string | null>(null);
  protected readonly singleSystemArchitects = computed(
    () => this.stats()?.architects.filter(a => a.count === 1).length ?? 0,
  );
  protected readonly topArchitects = computed(() => this.stats()?.architects.slice(0, 25) ?? []);
  protected readonly maxArchitectCount = computed(() => this.stats()?.architects[0]?.count ?? 1);
  protected readonly selectedArchitectRows = computed(() => {
    const name = this.selectedArchitect();
    if (!name) {
      return [];
    }
    return this.rows().filter(r => r.architect === name && !r.notAColony);
  });
  protected readonly selectedArchitectRank = computed(() => {
    const name = this.selectedArchitect();
    const architects = this.stats()?.architects ?? [];
    const index = architects.findIndex(a => a.name === name);
    return index < 0 ? null : index + 1;
  });
  protected readonly selectedArchitectSummary = computed(() => {
    const rows = this.selectedArchitectRows();
    if (rows.length === 0) {
      return null;
    }
    const population = rows.reduce((sum, r) => sum + (r.population ?? 0), 0);
    const stations = rows.reduce((sum, r) => sum + (r.stationCount ?? 0), 0);
    const withPreference = rows.filter(r => r.preferredFactionRecorded && r.preferredFaction);
    const got = withPreference.filter(r => r.controllingFaction === r.preferredFaction).length;
    const furthestLy = Math.max(...rows.map(r => distanceLy(r)));
    return { count: rows.length, population, stations, withPreference: withPreference.length, got, furthestLy };
  });
  protected readonly architectDistribution = computed((): ArchitectDistBin[] => {
    const counts = this.stats()?.architects.map(a => a.count) ?? [];
    return ARCHITECT_DIST_BINS.map(bin => {
      const inBin = counts.filter(c => c >= bin.min && c <= bin.max);
      return { label: bin.label, minCount: bin.min, maxCount: bin.max, architects: inBin.length, systems: inBin.reduce((s, c) => s + c, 0) };
    });
  });

  // ---- Footprint ----------------------------------------------------------------------------
  protected readonly footprintCards = computed(() => {
    const footprint = this.stats()?.footprint;
    if (!footprint) {
      return null;
    }
    const canonnPresent = footprint.canonnC + footprint.canonnO + footprint.bothC + footprint.bothD + footprint.bothO;
    const canonnControl = footprint.canonnC + footprint.bothC;
    const cdsrPresent = footprint.cdsrD + footprint.cdsrO + footprint.bothC + footprint.bothD + footprint.bothO;
    const cdsrControl = footprint.cdsrD + footprint.bothD;
    const both = footprint.bothC + footprint.bothD + footprint.bothO;
    const union = canonnPresent + cdsrPresent - both;
    const unionControl = canonnControl + cdsrControl;
    return { canonnPresent, canonnControl, cdsrPresent, cdsrControl, both, union, unionControl };
  });
  protected readonly footprintGroups = computed((): FootprintGroup[] => {
    const f = this.stats()?.footprint;
    if (!f) {
      return [];
    }
    const groups: { label: string; segments: FootprintSegment[] }[] = [
      {
        label: 'Canonn only',
        segments: [
          { key: 'C', label: 'Canonn controls', value: f.canonnC },
          { key: 'O', label: 'Another faction controls', value: f.canonnO },
        ],
      },
      {
        label: 'Both present',
        segments: [
          { key: 'C', label: 'Canonn controls', value: f.bothC },
          { key: 'D', label: 'CDSR controls', value: f.bothD },
          { key: 'O', label: 'Another faction controls', value: f.bothO },
        ],
      },
      {
        label: 'CDSR only',
        segments: [
          { key: 'D', label: 'CDSR controls', value: f.cdsrD },
          { key: 'O', label: 'Another faction controls', value: f.cdsrO },
        ],
      },
      {
        label: 'Neither present',
        segments: [{ key: 'O', label: 'Neither Canonn nor CDSR present', value: f.neither }],
      },
    ];
    return groups
      .map(g => ({ ...g, total: g.segments.reduce((sum, s) => sum + s.value, 0) }))
      .filter(g => g.total > 0);
  });
  protected readonly footprintTotal = computed(() => this.stats()?.totalSystems ?? 0);

  // ---- Preferred faction / stations -----------------------------------------------------------
  protected readonly maxPreferredTotal = computed(() => {
    const preferred = this.stats()?.preferred ?? [];
    return Math.max(1, ...preferred.map(p => p.got + p.miss));
  });
  protected readonly maxStationCount = computed(() => this.stats()?.stations[0]?.count ?? 1);

  // ---- Rivals ---------------------------------------------------------------------------------
  protected readonly rivalsUsFilter = signal<RivalsUsFilter>('all');
  protected readonly rivalsSort = signal<RivalsSort>('score');
  protected readonly selectedRival = signal<string | null>(null);
  protected readonly filteredRivals = computed((): FilteredRival[] => {
    const raw = this.stats()?.rivals ?? [];
    const us = this.rivalsUsFilter();
    const sort = this.rivalsSort();
    const by = <T extends { us: UsSide }>(entries: T[]): T[] => (us === 'all' ? entries : entries.filter(e => e.us === us));
    const scoreOf = (conflicts: unknown[], lead: unknown[], close: unknown[]): number =>
      5 * conflicts.length + lead.length + 0.5 * close.length;
    const rows = raw
      .map((r): FilteredRival => {
        const conflicts = by(r.conflicts);
        const lead = by(r.lead);
        const close = by(r.close);
        return {
          faction: r.faction,
          conflicts,
          lead,
          close,
          score: scoreOf(conflicts, lead, close),
          sideScore: {
            C: scoreOf(r.conflicts.filter(c => c.us === 'C'), r.lead.filter(c => c.us === 'C'), r.close.filter(c => c.us === 'C')),
            D: scoreOf(r.conflicts.filter(c => c.us === 'D'), r.lead.filter(c => c.us === 'D'), r.close.filter(c => c.us === 'D')),
          },
        };
      })
      .filter(r => r.score > 0);
    const key = (r: FilteredRival): number => {
      if (sort === 'conf') return r.conflicts.length * 100 + r.score / 100;
      if (sort === 'lead') return r.lead.length * 100 + r.close.length;
      return r.score;
    };
    return rows.sort((a, b) => key(b) - key(a) || a.faction.localeCompare(b.faction)).slice(0, RIVALS_SHOWN);
  });
  protected readonly openConflicts = computed(
    () => (this.stats()?.rivals ?? []).reduce((sum, r) => sum + r.conflicts.length, 0),
  );
  protected readonly selectedRivalDetail = computed(() => {
    const name = this.selectedRival();
    return name ? (this.filteredRivals().find(r => r.faction === name) ?? null) : null;
  });

  // ---- Population scatter -----------------------------------------------------------------
  protected readonly popShowColonies = signal(true);
  protected readonly popShowOthers = signal(true);
  protected readonly populationPoints = computed((): PopulationPoint[] =>
    this.rows().map(r => ({
      systemName: r.systemName,
      distanceLy: distanceLy(r),
      population: r.population ?? 0,
      hasArchitect: !!r.architect && !r.notAColony,
      stationCount: r.stationCount,
      controllingFaction: r.controllingFaction,
    })),
  );

  // ---- Faction Atlas plates --------------------------------------------------------------------
  protected readonly factionNetwork = signal<FactionNetworkData | null>(null);
  /** Shared across the web/chord/map plates: clicking a cluster legend entry highlights it everywhere. */
  protected readonly selectedCluster = signal<number | null>(null);
  protected readonly fullMinShared = signal(15);
  protected readonly fullShowHubs = signal(true);
  protected readonly fullRelayout = signal(true);
  protected readonly mapScope = signal<'core' | 'all'>('core');
  protected readonly clusterLegend = computed(() => this.factionNetwork()?.clusters ?? []);

  // ---- Chart hosts (d3 draws directly into these) -----------------------------------------
  protected readonly footSvgRef = viewChild<ElementRef<SVGSVGElement>>('footSvg');
  protected readonly rivSvgRef = viewChild<ElementRef<SVGSVGElement>>('rivSvg');
  protected readonly archDistSvgRef = viewChild<ElementRef<SVGSVGElement>>('archDistSvg');
  protected readonly archMiniSvgRef = viewChild<ElementRef<SVGSVGElement>>('archMiniSvg');
  protected readonly popSvgRef = viewChild<ElementRef<SVGSVGElement>>('popSvg');
  protected readonly infSvgRef = viewChild<ElementRef<SVGSVGElement>>('infSvg');
  protected readonly ageSvgRef = viewChild<ElementRef<SVGSVGElement>>('ageSvg');
  protected readonly webSvgRef = viewChild<ElementRef<SVGSVGElement>>('webSvg');
  protected readonly chordSvgRef = viewChild<ElementRef<SVGSVGElement>>('chordSvg');
  protected readonly fullCanvasRef = viewChild<ElementRef<HTMLCanvasElement>>('fullCanvas');
  protected readonly mapCanvasRef = viewChild<ElementRef<HTMLCanvasElement>>('mapCanvas');

  constructor() {
    effect(() => this.drawInfluenceHistogram());
    effect(() => this.drawFreshnessHistogram());
    effect(() => this.drawArchitectDistribution());
    effect(() => this.drawArchitectMinimap());
    effect(() => this.drawPopulationScatter());
    effect(() => this.drawRivals());
    effect(() => this.drawFootprintStrip());
    effect(() => this.drawChord());

    // Plate 7 (faction web): rebuilding the simulation on every signal read would restart the
    // animation and lose drag state, so only factionNetwork() rebuilds it; a cluster pick just
    // re-applies the existing highlight closure.
    effect(() => this.initFactionWeb());
    effect(() => this.applyWebPick());

    // Plate 8 (full network): structure/baseline layout rebuild vs. redraw vs. relayout are kept
    // as separate effects for the same reason — only minShared/relayout should ever re-simulate.
    effect(() => this.initFullNetwork());
    effect(() => this.renderFullNetwork());
    effect(() => this.onFullControlsChange());

    // Plate 10 (galactic map): structure rebuild vs. redraw vs. camera framing, same split.
    effect(() => this.initFactionMap());
    effect(() => this.renderFactionMap());
    effect(() => this.mapApplyScope());
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.webSim?.stop();
    this.webResize?.disconnect();
    this.fnStopAnimations();
    this.fnResize?.disconnect();
    clearTimeout(this.fnMinwTimer);
    this.mapResize?.disconnect();
  }

  protected async load(): Promise<void> {
    this.status.set('loading');
    this.selectedArchitect.set(null);
    this.selectedRival.set(null);
    this.selectedCluster.set(null);
    try {
      const snapshot = await this.bgsService.getSystems();
      this.generatedAt.set(snapshot.generatedAt);
      this.rows.set(snapshot.rows);
      const stats = computeCensusStats(snapshot.rows);
      this.stats.set(stats);
      // Open on the first architect (the one with the most systems) rather than an empty detail pane.
      const first = stats.architects[0]?.name ?? null;
      this.selectedArchitect.set(first);
      this.architectQuery.set(first ?? '');
      this.factionNetwork.set(computeFactionNetwork(snapshot.rows));
      this.status.set('ready');
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Something went wrong loading the BGS data.');
      this.status.set('error');
    }
  }

  protected fmt(value: number): string {
    return value.toLocaleString('en-US');
  }

  protected pct(part: number, total: number): string {
    return total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`;
  }

  protected round(value: number): number {
    return Math.round(value);
  }

  protected tipRowHtml(p: { faction: string; got: number; miss: number }): string {
    return (
      this.tipTitle(p.faction) +
      this.tipRow('Preferred faction controls', this.fmt(p.got)) +
      this.tipRow('Another faction controls', this.fmt(p.miss)) +
      this.tipRow('Success rate', this.pct(p.got, p.got + p.miss))
    );
  }

  protected big(value: number): string {
    if (value >= 1e9) return (value / 1e9).toFixed(value >= 1e10 ? 0 : 1) + ' bn';
    if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + ' m';
    if (value >= 1e3) return Math.round(value / 1e3) + ' k';
    return this.fmt(value);
  }

  protected selectArchitect(name: string): void {
    this.selectedArchitect.set(name);
  }

  protected onArchitectQuery(value: string): void {
    this.architectQuery.set(value);
    const match = this.stats()?.architects.find(a => a.name.toLowerCase() === value.trim().toLowerCase());
    if (match) {
      this.selectArchitect(match.name);
    }
  }

  protected selectRival(name: string): void {
    this.selectedRival.update(current => (current === name ? null : name));
  }

  protected toggleCluster(id: number): void {
    this.selectedCluster.update(current => (current === id ? null : id));
  }

  /**
   * Re-applies the faction web's dim/highlight state after a cluster pick, without touching the
   * running simulation. Reads {@link selectedCluster} unconditionally (not just inside the
   * optional call) so this effect keeps depending on it even on a run where
   * {@link webApplyHighlight} hasn't been set yet (e.g. before the network has loaded).
   */
  private applyWebPick(): void {
    this.selectedCluster();
    this.webApplyHighlight?.(null);
  }

  /** Colour for a cluster id: -1/-2 (unclustered / hub) fall back to the neutral swatch. */
  private clusterColor(cluster: number): string {
    if (cluster < 0) {
      return this.cssVar('--cc-s0');
    }
    return this.cssVar(`--cc-c${cluster % 8}`);
  }

  // ---- Tooltip --------------------------------------------------------------------------------
  protected showTip(event: PointerEvent, html: string): void {
    this.tooltip.set({ visible: true, x: event.clientX, y: event.clientY, html });
  }

  protected moveTip(event: PointerEvent): void {
    this.tooltip.update(t => (t.visible ? { ...t, x: event.clientX, y: event.clientY } : t));
  }

  protected hideTip(): void {
    this.tooltip.update(t => ({ ...t, visible: false }));
  }

  private tipTitle(text: string): string {
    return `<div class="cc-tip-t">${escapeHtml(text)}</div>`;
  }

  private tipRow(label: string, value: string): string {
    return `<div class="cc-tip-r"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  }

  private tipSub(text: string): string {
    return `<div class="cc-tip-sub">${escapeHtml(text)}</div>`;
  }

  // ---- CSS custom property reads (so charts drawn with d3 pick up light/dark theme colours) ---
  private cssVar(name: string): string {
    return getComputedStyle(this.host.nativeElement).getPropertyValue(name).trim();
  }

  // ---- Influence histogram (#inf) --------------------------------------------------------------
  private drawInfluenceHistogram(): void {
    const ref = this.infSvgRef();
    const s = this.stats();
    if (!ref || !s) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const W = 900;
    const H = 300;
    const m = { l: 44, r: 14, t: 30, b: 34 };
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const bins = s.influenceBins;
    const x = d3.scaleBand(bins.map(b => b.bucket), [m.l, W - m.r]).padding(0.12);
    const y = d3.scaleLinear([0, Math.max(1, d3.max(bins, b => b.canonnControls + b.other) ?? 1)], [H - m.b, m.t]).nice();
    this.drawAxisGridlines(svg, y, m, W);
    const groups = svg
      .append('g')
      .selectAll('g')
      .data(bins)
      .join('g');
    groups
      .append('path')
      .attr('fill', this.cssVar('--cc-s1'))
      .attr('d', b => (b.canonnControls ? roundedTopBarPath(x(b.bucket)!, x.bandwidth(), y(b.canonnControls), y(0), !b.other) : ''));
    groups
      .append('path')
      .attr('fill', this.cssVar('--cc-s2'))
      .attr('d', b =>
        b.other ? roundedTopBarPath(x(b.bucket)!, x.bandwidth(), y(b.canonnControls + b.other), y(b.canonnControls) - (b.canonnControls ? 2 : 0), true) : '',
      );
    groups
      .append('rect')
      .attr('x', b => x(b.bucket)!)
      .attr('width', x.bandwidth())
      .attr('y', m.t)
      .attr('height', H - m.b - m.t)
      .attr('fill', 'transparent')
      .on('pointerenter', (event: PointerEvent, b) =>
        this.showTip(
          event,
          this.tipTitle(`Canonn at ${b.bucket}–${b.bucket + 5}%`) +
            this.tipRow('Canonn controls', this.fmt(b.canonnControls)) +
            this.tipRow('Another faction controls', this.fmt(b.other)),
        ),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip());
    // The BGS guide's fixed thresholds, as dashed reference lines.
    const left = x(bins[0].bucket)!;
    const right = x(bins[bins.length - 1].bucket)! + x.bandwidth();
    const at = (pct: number) => left + (pct / 100) * (right - left);
    const thresholds: [number, string][] = [
      [2.5, 'retreat'],
      [7, 'conflict'],
      [60, 'coup'],
      [75, 'expansion'],
    ];
    thresholds.forEach(([pct, label], i) => {
      svg
        .append('line')
        .attr('x1', at(pct))
        .attr('x2', at(pct))
        .attr('y1', m.t)
        .attr('y2', H - m.b)
        .attr('stroke', this.cssVar('--cc-ink-3'))
        .attr('stroke-dasharray', '3 4')
        .attr('pointer-events', 'none');
      svg
        .append('text')
        .attr('x', at(pct) + 4)
        .attr('y', m.t + 10 + (i === 1 ? 14 : 0))
        .attr('class', 'cc-axis-text')
        .attr('pointer-events', 'none')
        .text(`${label} ${pct}%`);
    });
    svg
      .append('g')
      .selectAll('text')
      .data(bins.filter(b => b.bucket % 20 === 0))
      .join('text')
      .attr('x', b => x(b.bucket)!)
      .attr('y', H - m.b + 18)
      .attr('text-anchor', 'middle')
      .attr('class', 'cc-axis-text')
      .text(b => b.bucket + '%');
  }

  // ---- Freshness histogram (#age) -------------------------------------------------------------
  private drawFreshnessHistogram(): void {
    const ref = this.ageSvgRef();
    const s = this.stats();
    if (!ref || !s) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const W = 900;
    const H = 280;
    const m = { l: 44, r: 14, t: 20, b: 50 };
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const bins = s.freshnessBins;
    const x = d3.scaleBand(bins.map(b => b.label), [m.l, W - m.r]).padding(0.22);
    const y = d3.scaleLinear([0, Math.max(1, d3.max(bins, b => b.count) ?? 1)], [H - m.b, m.t]).nice();
    this.drawAxisGridlines(svg, y, m, W);
    const ramp = ['--cc-q1', '--cc-q2', '--cc-q3', '--cc-q4', '--cc-q5', '--cc-q6', '--cc-q7', '--cc-s0'];
    svg
      .append('g')
      .selectAll('path')
      .data(bins)
      .join('path')
      .attr('fill', (_, i) => this.cssVar(ramp[Math.min(i, ramp.length - 1)]))
      .attr('d', b => (b.count ? roundedTopBarPath(x(b.label)!, x.bandwidth(), y(b.count), y(0), true) : ''));
    svg
      .append('g')
      .selectAll('rect')
      .data(bins)
      .join('rect')
      .attr('x', b => x(b.label)!)
      .attr('width', x.bandwidth())
      .attr('y', m.t)
      .attr('height', H - m.b - m.t)
      .attr('fill', 'transparent')
      .on('pointerenter', (event: PointerEvent, b) =>
        this.showTip(event, this.tipTitle(`Updated ${b.label === 'Today' ? 'today' : b.label.toLowerCase() + ' ago'}`) + this.tipRow('Systems', this.fmt(b.count))),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip());
    svg
      .append('g')
      .selectAll('text')
      .data(bins)
      .join('text')
      .attr('x', b => x(b.label)! + x.bandwidth() / 2)
      .attr('y', H - m.b + 18)
      .attr('text-anchor', 'middle')
      .attr('class', 'cc-axis-text')
      .text(b => b.label);
  }

  // ---- Architect distribution (#arch-dist) ------------------------------------------------------
  private drawArchitectDistribution(): void {
    const ref = this.archDistSvgRef();
    const bins = this.architectDistribution();
    if (!ref || bins.length === 0) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const W = 720;
    const H = 200;
    const m = { l: 40, r: 10, t: 20, b: 28 };
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleBand(bins.map(b => b.label), [m.l, W - m.r]).padding(0.28);
    const y = d3.scaleLinear([0, Math.max(1, d3.max(bins, b => b.architects) ?? 1)], [H - m.b, m.t]).nice();
    this.drawAxisGridlines(svg, y, m, W, 4);
    svg
      .append('g')
      .selectAll('path')
      .data(bins)
      .join('path')
      .attr('fill', this.cssVar('--cc-s1'))
      .attr('d', b => (b.architects ? roundedTopBarPath(x(b.label)!, x.bandwidth(), y(b.architects), y(0), true) : ''));
    svg
      .append('g')
      .selectAll('rect')
      .data(bins)
      .join('rect')
      .attr('x', b => x(b.label)!)
      .attr('width', x.bandwidth())
      .attr('y', m.t)
      .attr('height', H - m.b - m.t)
      .attr('fill', 'transparent')
      .on('pointerenter', (event: PointerEvent, b) =>
        this.showTip(
          event,
          this.tipTitle(`Built ${b.label} system${b.label === '1' ? '' : 's'}`) +
            this.tipRow('Architects', this.fmt(b.architects)) +
            this.tipRow('Systems between them', this.fmt(b.systems)),
        ),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip());
    svg
      .append('g')
      .selectAll('text')
      .data(bins)
      .join('text')
      .attr('x', b => x(b.label)! + x.bandwidth() / 2)
      .attr('y', H - m.b + 18)
      .attr('text-anchor', 'middle')
      .attr('class', 'cc-axis-text')
      .text(b => b.label);
  }

  // ---- Per-architect minimap ---------------------------------------------------------------------
  private drawArchitectMinimap(): void {
    const ref = this.archMiniSvgRef();
    const selectedRows = this.selectedArchitectRows();
    if (!ref || selectedRows.length === 0) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const W = 400;
    const H = 200;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const xs = d3.extent(selectedRows, r => r.x) as [number, number];
    const zs = d3.extent(selectedRows, r => r.z) as [number, number];
    const pad = Math.max(150, (xs[1] - xs[0]) * 0.15, (zs[1] - zs[0]) * 0.15);
    let x0 = xs[0] - pad;
    let x1 = xs[1] + pad;
    let z0 = zs[0] - pad;
    let z1 = zs[1] + pad;
    const aspect = W / H;
    const width = x1 - x0;
    const height = z1 - z0;
    if (width / height > aspect) {
      const mid = (z0 + z1) / 2;
      z0 = mid - width / aspect / 2;
      z1 = mid + width / aspect / 2;
    } else {
      const mid = (x0 + x1) / 2;
      x0 = mid - height * aspect / 2;
      x1 = mid + height * aspect / 2;
    }
    const x = d3.scaleLinear([x0, x1], [0, W]);
    const z = d3.scaleLinear([z0, z1], [H, 0]);
    svg.append('rect').attr('width', W).attr('height', H).attr('fill', this.cssVar('--cc-bg'));
    const selectedNames = new Set(selectedRows.map(r => r.systemName));
    const context = this.rows().filter(
      r => r.architect && !r.notAColony && !selectedNames.has(r.systemName) && r.x >= x0 && r.x <= x1 && r.z >= z0 && r.z <= z1,
    );
    svg
      .append('g')
      .selectAll('circle')
      .data(context)
      .join('circle')
      .attr('cx', r => x(r.x))
      .attr('cy', r => z(r.z))
      .attr('r', 1.6)
      .attr('fill', this.cssVar('--cc-s0'));
    svg
      .append('g')
      .selectAll('circle')
      .data(selectedRows)
      .join('circle')
      .attr('cx', r => x(r.x))
      .attr('cy', r => z(r.z))
      .attr('r', 3.5)
      .attr('fill', this.cssVar('--cc-s1'))
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 1)
      .on('pointerenter', (event: PointerEvent, r) =>
        this.showTip(
          event,
          this.tipTitle(r.systemName) + this.tipRow('Population', this.big(r.population ?? 0)) + this.tipRow('Controller', r.controllingFaction ?? '—'),
        ),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip());
    if (0 >= x0 && 0 <= x1 && 0 >= z0 && 0 <= z1) {
      svg
        .append('circle')
        .attr('cx', x(0))
        .attr('cy', z(0))
        .attr('r', 4)
        .attr('fill', 'none')
        .attr('stroke', this.cssVar('--cc-ink'));
      svg.append('text').attr('x', x(0) + 7).attr('y', z(0) - 6).attr('font-size', 11).attr('fill', this.cssVar('--cc-ink')).text('Sol');
    }
    svg
      .append('text')
      .attr('x', 6)
      .attr('y', H - 6)
      .attr('font-size', 10)
      .attr('fill', this.cssVar('--cc-ink-3'))
      .text(`${this.fmt(Math.round(x1 - x0))} ly across · core ↑`);
  }

  // ---- Population scatter (#pop) ----------------------------------------------------------------
  private drawPopulationScatter(): void {
    const ref = this.popSvgRef();
    if (!ref) {
      return;
    }
    const showColonies = this.popShowColonies();
    const showOthers = this.popShowOthers();
    const points = this.populationPoints().filter(p => (p.hasArchitect ? showColonies : showOthers));
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const el = ref.nativeElement;
    const W = el.clientWidth || 900;
    const H = el.clientHeight || 520;
    const m = { l: 58, r: 16, t: 16, b: 40 };
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleLog([10, 25000], [m.l, W - m.r]).clamp(true);
    const y = d3.scaleLog([1e3, 2e10], [H - m.b, m.t]).clamp(true);
    const xTicks = [10, 100, 1000, 10000];
    const yTicks = [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];
    svg
      .append('g')
      .selectAll('line')
      .data(yTicks)
      .join('line')
      .attr('x1', m.l)
      .attr('x2', W - m.r)
      .attr('y1', d => y(d))
      .attr('y2', d => y(d))
      .attr('stroke', this.cssVar('--cc-grid'));
    svg
      .append('g')
      .selectAll('line')
      .data(xTicks)
      .join('line')
      .attr('y1', m.t)
      .attr('y2', H - m.b)
      .attr('x1', d => x(d))
      .attr('x2', d => x(d))
      .attr('stroke', this.cssVar('--cc-grid'));
    svg
      .append('g')
      .selectAll('text')
      .data(yTicks)
      .join('text')
      .attr('x', m.l - 8)
      .attr('y', d => y(d) + 4)
      .attr('text-anchor', 'end')
      .attr('class', 'cc-axis-text')
      .text(d => this.big(d));
    svg
      .append('g')
      .selectAll('text')
      .data(xTicks)
      .join('text')
      .attr('x', d => x(d))
      .attr('y', H - m.b + 18)
      .attr('text-anchor', 'middle')
      .attr('class', 'cc-axis-text')
      .text(d => this.fmt(d) + ' ly');
    const jitterY = (p: PopulationPoint): number => (p.population > 0 ? y(p.population) : H - m.b + ((Math.round(p.distanceLy) * 7919) % 9) - 4);
    const sorted = [...points].sort((a, b) => Number(a.hasArchitect) - Number(b.hasArchitect));
    svg
      .append('g')
      .selectAll('circle')
      .data(sorted)
      .join('circle')
      .attr('cx', p => x(Math.max(10, p.distanceLy)))
      .attr('cy', p => jitterY(p))
      .attr('r', 2.6)
      .attr('fill', p => this.cssVar(p.hasArchitect ? '--cc-s1' : '--cc-s2'))
      .attr('fill-opacity', 0.7)
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 0.6);
    const quadtree = d3.quadtree<PopulationPoint>(
      sorted,
      p => x(Math.max(10, p.distanceLy)),
      p => jitterY(p),
    );
    const ring = svg
      .append('circle')
      .attr('r', 6)
      .attr('fill', 'none')
      .attr('stroke', this.cssVar('--cc-ink'))
      .attr('stroke-width', 1.5)
      .attr('visibility', 'hidden');
    svg.on('pointermove', (event: PointerEvent) => {
      const [px, py] = d3.pointer(event);
      const found = quadtree.find(px, py, 14);
      if (!found) {
        ring.attr('visibility', 'hidden');
        this.hideTip();
        return;
      }
      ring.attr('cx', x(Math.max(10, found.distanceLy))).attr('cy', jitterY(found)).attr('visibility', 'visible');
      this.showTip(
        event,
        this.tipTitle(found.systemName) +
          this.tipRow('Population', found.population ? this.fmt(found.population) : '0') +
          this.tipRow('Distance from Sol', this.fmt(Math.round(found.distanceLy)) + ' ly') +
          this.tipRow('Stations', String(found.stationCount ?? '—')) +
          this.tipRow('Has architect', found.hasArchitect ? 'yes' : 'no') +
          this.tipRow('Controller', found.controllingFaction ?? '—'),
      );
    });
    svg.on('pointerleave', () => {
      ring.attr('visibility', 'hidden');
      this.hideTip();
    });
  }

  protected togglePopGroup(key: 'colonies' | 'others'): void {
    if (key === 'colonies') {
      if (this.popShowColonies() && !this.popShowOthers()) return;
      this.popShowColonies.update(v => !v);
    } else {
      if (this.popShowOthers() && !this.popShowColonies()) return;
      this.popShowOthers.update(v => !v);
    }
  }

  // ---- Footprint strip (#foot) -------------------------------------------------------------------
  private drawFootprintStrip(): void {
    const ref = this.footSvgRef();
    const groups = this.footprintGroups();
    if (!ref || groups.length === 0) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const W = 1000;
    const H = 40;
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'none');
    const total = groups.reduce((sum, g) => sum + g.total, 0) || 1;
    const color: Record<FootprintSegment['key'], string> = {
      C: this.cssVar('--cc-s1'),
      D: this.cssVar('--cc-s3'),
      O: this.cssVar('--cc-s0'),
    };
    let gx = 0;
    for (const group of groups) {
      const groupWidth = (group.total / total) * (W - groups.length * 3);
      let sx = gx;
      for (const segment of group.segments) {
        if (segment.value === 0) {
          continue;
        }
        const segWidth = (segment.value / group.total) * groupWidth;
        svg
          .append('rect')
          .attr('x', sx)
          .attr('y', 0)
          .attr('width', Math.max(0, segWidth))
          .attr('height', H)
          .attr('fill', color[segment.key])
          .on('pointerenter', (event: PointerEvent) =>
            this.showTip(
              event,
              this.tipTitle(group.label) + this.tipRow(segment.label, this.fmt(segment.value)) + this.tipRow('Share of group', this.pct(segment.value, group.total)),
            ),
          )
          .on('pointermove', (event: PointerEvent) => this.moveTip(event))
          .on('pointerleave', () => this.hideTip());
        sx += segWidth;
      }
      gx += groupWidth + 3;
    }
  }

  // ---- Rivals diagram (#riv) ---------------------------------------------------------------------
  private drawRivals(): void {
    const ref = this.rivSvgRef();
    const rivals = this.filteredRivals();
    if (!ref) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    if (rivals.length === 0) {
      return;
    }
    const rowHeight = 30;
    const top = 36;
    const W = 1000;
    const H = top + rivals.length * rowHeight + 16;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const xNodes = 120;
    const xName = 340;
    const xConflicts = 566;
    const xBars = 676;
    const barWidth = 160;
    const xScore = 902;

    const headings: [number, string][] = [
      [xName, 'Rival faction'],
      [xConflicts, 'Conflicts'],
      [xBars, 'Ahead of us · close behind'],
      [xScore, 'Friction'],
    ];
    svg
      .append('g')
      .selectAll('text')
      .data(headings)
      .join('text')
      .attr('x', d => d[0])
      .attr('y', 20)
      .attr('class', 'cc-axis-text')
      .text(d => d[1]);

    const us = this.rivalsUsFilter();
    const showC = us !== 'D';
    const showD = us !== 'C';
    const mid = top + (rivals.length * rowHeight) / 2;
    const nodes: { key: UsSide; y: number; label: string; color: string }[] = [];
    if (showC && showD) {
      nodes.push({ key: 'C', y: mid - rivals.length * rowHeight * 0.22, label: 'Canonn', color: this.cssVar('--cc-s1') });
      nodes.push({ key: 'D', y: mid + rivals.length * rowHeight * 0.22, label: 'CDSR', color: this.cssVar('--cc-s3') });
    } else if (showC) {
      nodes.push({ key: 'C', y: mid, label: 'Canonn', color: this.cssVar('--cc-s1') });
    } else {
      nodes.push({ key: 'D', y: mid, label: 'CDSR', color: this.cssVar('--cc-s3') });
    }
    const maxSide = Math.max(1, ...rivals.map(r => Math.max(r.sideScore.C, r.sideScore.D)));
    const linkWidth = d3.scaleSqrt([0, maxSide], [0, 9]);
    const linkGroup = svg.append('g').attr('fill', 'none');
    const selectedName = this.selectedRival();

    rivals.forEach((rival, i) => {
      const rowY = top + i * rowHeight + rowHeight / 2;
      for (const node of nodes) {
        const value = rival.sideScore[node.key];
        if (!value) {
          continue;
        }
        linkGroup
          .append('path')
          .attr('data-i', i)
          .attr(
            'd',
            `M${xNodes + 16},${node.y} C${(xNodes + xName) / 2},${node.y} ${(xNodes + xName) / 2},${rowY} ${xName},${rowY}`,
          )
          .attr('stroke', node.color)
          .attr('stroke-opacity', selectedName === null ? 0.35 : selectedName === rival.faction ? 0.9 : 0.06)
          .attr('stroke-width', Math.max(0.8, linkWidth(value)))
          .attr('stroke-linecap', 'round');
      }
    });

    for (const node of nodes) {
      const g = svg.append('g');
      g.append('circle').attr('cx', xNodes).attr('cy', node.y).attr('r', 16).attr('fill', node.color).attr('stroke', this.cssVar('--cc-panel')).attr('stroke-width', 3);
      g.append('text')
        .attr('x', xNodes - 24)
        .attr('y', node.y + 5)
        .attr('text-anchor', 'end')
        .attr('font-family', 'var(--cc-f-display)')
        .attr('font-weight', 600)
        .attr('font-size', 17)
        .attr('fill', this.cssVar('--cc-ink'))
        .text(node.label);
    }

    const maxBar = Math.max(1, ...rivals.map(r => r.lead.length + r.close.length));
    const rowsSel = svg
      .append('g')
      .selectAll('g')
      .data(rivals)
      .join('g')
      .attr('transform', (_, i) => `translate(0, ${top + i * rowHeight})`)
      .attr('class', 'cc-riv-row')
      .classed('cc-riv-row-on', r => r.faction === selectedName)
      .style('cursor', 'pointer');

    rowsSel
      .append('rect')
      .attr('class', 'cc-riv-bg')
      .attr('x', xName - 10)
      .attr('width', W - (xName - 10))
      .attr('height', rowHeight)
      .attr('rx', 4)
      .attr('fill', r => (r.faction === selectedName ? this.cssVar('--cc-bg') : 'transparent'));

    rowsSel
      .append('text')
      .attr('x', xName)
      .attr('y', rowHeight / 2 + 4.5)
      .attr('font-size', 13.5)
      .attr('font-weight', 500)
      .attr('fill', this.cssVar('--cc-ink'))
      .text(r => (r.faction.length > 28 ? r.faction.slice(0, 27) + '…' : r.faction));

    rowsSel.each((rival, i, nodesList) => {
      const g = d3.select(nodesList[i]);
      let cx = xConflicts;
      for (const conflict of rival.conflicts) {
        const cy = rowHeight / 2;
        if (conflict.status === 'active') {
          g.append('path').attr('d', `M${cx},${cy - 6} L${cx + 6},${cy + 5} L${cx - 6},${cy + 5}Z`).attr('fill', this.cssVar('--cc-s4'));
        } else {
          g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 5).attr('fill', 'none').attr('stroke', this.cssVar('--cc-ink-3')).attr('stroke-width', 1.5);
        }
        cx += 15;
      }
      if (rival.conflicts.length === 0) {
        g.append('text').attr('x', xConflicts).attr('y', rowHeight / 2 + 4).attr('class', 'cc-axis-text').text('—');
      }
      const leadWidth = (rival.lead.length / maxBar) * barWidth;
      const closeWidth = (rival.close.length / maxBar) * barWidth;
      if (leadWidth) {
        g.append('rect').attr('x', xBars).attr('y', rowHeight / 2 - 6).attr('width', leadWidth).attr('height', 12).attr('rx', closeWidth ? 0 : 3).attr('fill', this.cssVar('--cc-s2'));
      }
      if (closeWidth) {
        g.append('rect')
          .attr('x', xBars + leadWidth + (leadWidth ? 2 : 0))
          .attr('y', rowHeight / 2 - 6)
          .attr('width', closeWidth)
          .attr('height', 12)
          .attr('rx', 3)
          .attr('fill', this.cssVar('--cc-s4'));
      }
      g.append('text')
        .attr('x', xBars + leadWidth + closeWidth + (leadWidth && closeWidth ? 2 : 0) + 6)
        .attr('y', rowHeight / 2 + 4)
        .attr('class', 'cc-axis-text')
        .text(`${rival.lead.length} · ${rival.close.length}`);
      g.append('text')
        .attr('x', xScore)
        .attr('y', rowHeight / 2 + 4.5)
        .attr('font-family', 'var(--cc-f-mono)')
        .attr('font-size', 12.5)
        .attr('fill', this.cssVar('--cc-ink-2'))
        .text(rival.score.toFixed(1));
    });

    rowsSel
      .on('pointerenter', (event: PointerEvent, rival) => {
        linkGroup.selectAll<SVGPathElement, unknown>('path').attr('stroke-opacity', function () {
          const i = +(this as SVGPathElement).getAttribute('data-i')!;
          return rivals[i] === rival ? 0.9 : 0.06;
        });
        this.showTip(
          event,
          this.tipTitle(rival.faction) +
            this.tipRow('Conflicts with us', String(rival.conflicts.length)) +
            this.tipRow('Systems where they lead us', String(rival.lead.length)) +
            this.tipRow('Within 5 points behind us', String(rival.close.length)) +
            this.tipRow('Friction score', rival.score.toFixed(1)),
        );
      })
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => {
        const name = this.selectedRival();
        const i = rivals.findIndex(r => r.faction === name);
        linkGroup.selectAll<SVGPathElement, unknown>('path').attr('stroke-opacity', function () {
          if (name === null) return 0.35;
          const idx = +(this as SVGPathElement).getAttribute('data-i')!;
          return idx === i ? 0.9 : 0.06;
        });
        this.hideTip();
      })
      .on('click', (_event: PointerEvent, rival) => this.selectRival(rival.faction));
  }

  // ---- Plate 7: the faction web (force-directed, filtered to widely-present factions) --------
  /** Set by {@link initFactionWeb}; called by the pick-only effect so a cluster click never rebuilds the simulation. */
  private webApplyHighlight: ((focus: WebNode | null) => void) | null = null;
  private webSim?: d3.Simulation<WebNode, undefined>;
  private webResize?: ResizeObserver;

  private initFactionWeb(): void {
    const ref = this.webSvgRef();
    const net = this.factionNetwork();
    this.webSim?.stop();
    this.webSim = undefined;
    this.webResize?.disconnect();
    this.webApplyHighlight = null;
    if (!ref || !net || net.web.nodes.length === 0) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const el = ref.nativeElement;
    let W = el.clientWidth || 900;
    const H = 560;
    svg.attr('viewBox', `${-W / 2} ${-H / 2} ${W} ${H}`);

    const nodes: WebNode[] = net.web.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const nbr = new Map<string, [WebNode, number][]>(nodes.map(n => [n.id, []]));
    const links = net.web.links.map(l => ({ source: byId.get(l.a)!, target: byId.get(l.b)!, shared: l.shared, lift: l.lift }));
    for (const l of links) {
      nbr.get(l.source.id)!.push([l.target, l.shared]);
      nbr.get(l.target.id)!.push([l.source, l.shared]);
    }

    const maxPresence = Math.max(1, d3.max(nodes, n => n.presence) ?? 1);
    const r = d3.scaleSqrt([15, maxPresence], [3.5, 20]).clamp(true);

    const gL = svg.append('g');
    const gN = svg.append('g');
    const gT = svg.append('g').attr('pointer-events', 'none');
    const linkColor = this.cssVar('--cc-link');

    const L = gL
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', linkColor)
      .attr('stroke-width', d => Math.max(0.8, Math.min(6, Math.sqrt(d.shared) * 0.7)))
      .attr('stroke-linecap', 'round');

    const N = gN
      .selectAll<SVGCircleElement, WebNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', d => r(d.presence))
      .attr('fill', d => this.clusterColor(d.cluster))
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 2)
      .style('cursor', 'pointer');

    const labelThreshold = W < 600 ? 190 : 115;
    const T = gT
      .selectAll<SVGTextElement, WebNode>('text')
      .data(nodes.filter(d => d.presence >= labelThreshold))
      .join('text')
      .text(d => d.id)
      .attr('font-size', 11.5)
      .attr('font-family', 'var(--cc-f-body)')
      .attr('font-weight', 500)
      .attr('text-anchor', 'middle')
      .attr('paint-order', 'stroke')
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 3)
      .attr('stroke-linejoin', 'round')
      .attr('fill', this.cssVar('--cc-ink'));

    const sim = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(links)
          .id((d: d3.SimulationNodeDatum) => (d as WebNode).id)
          .distance((l: { lift: number }) => 40 + 60 / Math.sqrt(l.lift))
          .strength((l: { shared: number }) => Math.min(1, 0.15 + l.shared / 120)),
      )
      .force('charge', d3.forceManyBody().strength(-70))
      .force('collide', d3.forceCollide((d: d3.SimulationNodeDatum) => r((d as WebNode).presence) + 2))
      .force('x', d3.forceX().strength(0.06))
      .force('y', d3.forceY().strength(0.08));

    const bound = () => {
      const pad = 24;
      for (const d of nodes) {
        d.x = Math.max(-W / 2 + pad, Math.min(W / 2 - pad, d.x ?? 0));
        d.y = Math.max(-H / 2 + pad, Math.min(H / 2 - pad, d.y ?? 0));
      }
    };
    const onTick = () => {
      bound();
      L.attr('x1', d => d.source.x!)
        .attr('y1', d => d.source.y!)
        .attr('x2', d => d.target.x!)
        .attr('y2', d => d.target.y!);
      N.attr('cx', d => d.x!).attr('cy', d => d.y!);
      T.attr('x', d => d.x!)
        .attr('y', d => d.y! - r(d.presence) - 5)
        .attr('text-anchor', d => (d.x! < -W / 2 + 90 ? 'start' : d.x! > W / 2 - 90 ? 'end' : 'middle'));
    };
    sim.on('tick', onTick);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      onTick();
    }

    N.call(
      d3
        .drag<SVGCircleElement, WebNode>()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.2).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

    const apply = (focus: WebNode | null) => {
      const pick = this.selectedCluster();
      if (focus) {
        const s = new Set([focus.id, ...(nbr.get(focus.id) ?? []).map(([o]) => o.id)]);
        N.attr('fill-opacity', d => (s.has(d.id) ? 1 : 0.12));
        L.attr('stroke-opacity', d => (d.source.id === focus.id || d.target.id === focus.id ? 1 : 0.04)).attr('stroke', d =>
          d.source.id === focus.id || d.target.id === focus.id ? this.clusterColor(focus.cluster) : linkColor,
        );
        T.attr('opacity', d => (s.has(d.id) ? 1 : 0.1));
      } else if (pick !== null) {
        N.attr('fill-opacity', d => (d.cluster === pick ? 1 : 0.12));
        L.attr('stroke-opacity', d => (d.source.cluster === pick && d.target.cluster === pick ? 1 : 0.04)).attr('stroke', linkColor);
        T.attr('opacity', d => (d.cluster === pick ? 1 : 0.1));
      } else {
        N.attr('fill-opacity', 1);
        L.attr('stroke-opacity', 1).attr('stroke', linkColor);
        T.attr('opacity', 1);
      }
    };
    this.webApplyHighlight = apply;

    N.on('pointerenter', (event: PointerEvent, d) => {
      apply(d);
      const top = (nbr.get(d.id) ?? []).slice().sort((a, b) => b[1] - a[1]).slice(0, 5);
      const cluster = net.clusters.find(c => c.id === d.cluster);
      this.showTip(
        event,
        this.tipTitle(d.id) +
          this.tipRow('Present in', this.fmt(d.presence) + ' systems') +
          this.tipRow('Controls', this.fmt(d.controls) + ' systems') +
          this.tipRow('Cluster', cluster ? cluster.lead + ' group' : 'Other') +
          (top.length
            ? this.tipSub('Most shared with') + top.map(([o, n]) => this.tipRow(o.id, String(n))).join('')
            : this.tipSub('No strong partners')),
      );
    })
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => {
        apply(null);
        this.hideTip();
      })
      .on('click', (_event: PointerEvent, d) => this.toggleCluster(d.cluster));

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || W;
      if (Math.abs(w - W) < 2) return;
      W = w;
      svg.attr('viewBox', `${-W / 2} ${-H / 2} ${W} ${H}`);
      sim.alpha(0.3).restart();
    });
    ro.observe(el);
    this.webResize = ro;
    this.webSim = sim;
  }

  // ---- Plate 8: the full network — every faction, every shared-system pair (canvas) ----------
  private fnNodes: FNNode[] = [];
  private fnLinks: FNLink[] = [];
  private fnAdj: FNAdjEntry[][] = [];
  private fnHubs: FNNode[] = [];
  private fnFree: FNNode[] = [];
  private fnLinked = new Set<FNNode>();
  private fnQuadtree?: d3.Quadtree<FNNode>;
  private fnTransform = d3.zoomIdentity;
  private fnBase = { k: 1, x: 0, y: 0 };
  private fnHover: FNNode | null = null;
  private fnSim?: d3.Simulation<FNNode, undefined>;
  private fnTimer?: d3.Timer;
  private fnZoom?: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
  private fnResize?: ResizeObserver;
  private fnMinwTimer?: ReturnType<typeof setTimeout>;
  private fnW = 900;
  private fnH = 560;
  private fnDpr = 1;

  private fnRadius(d: FNNode): number {
    return d.isHub ? 11 : Math.max(1.6, Math.sqrt(d.presence) * 0.75);
  }

  private fnPlaceHubs(minw: number): void {
    for (const h of this.fnHubs) {
      let x = 0;
      let y = 0;
      let w = 0;
      for (const [o, n] of this.fnAdj[h.idx]) {
        if (n < minw) continue;
        x += (o.x ?? 0) * n;
        y += (o.y ?? 0) * n;
        w += n;
      }
      if (w) {
        h.x = x / w;
        h.y = y / w;
      }
    }
  }

  private fnFitBase(): void {
    const pad = 20;
    const xs = d3.extent(this.fnNodes, n => n.ox) as [number, number];
    const ys = d3.extent(this.fnNodes, n => n.oy) as [number, number];
    const k = Math.min((this.fnW - 2 * pad) / Math.max(1, xs[1] - xs[0]), (this.fnH - 2 * pad) / Math.max(1, ys[1] - ys[0]));
    this.fnBase = { k, x: this.fnW / 2 - k * ((xs[0] + xs[1]) / 2), y: this.fnH / 2 - k * ((ys[0] + ys[1]) / 2) };
  }

  private fnRebuildQuadtree(): void {
    this.fnQuadtree = d3.quadtree<FNNode>(
      this.fnNodes,
      d => this.fnBase.x + this.fnBase.k * (d.x ?? d.ox),
      d => this.fnBase.y + this.fnBase.k * (d.y ?? d.oy),
    );
  }

  private fnStopAnimations(): void {
    this.fnSim?.stop();
    this.fnSim = undefined;
    this.fnTimer?.stop();
    this.fnTimer = undefined;
  }

  private initFullNetwork(): void {
    const ref = this.fullCanvasRef();
    const net = this.factionNetwork();
    this.fnStopAnimations();
    this.fnResize?.disconnect();
    this.fnNodes = [];
    if (!ref || !net || net.full.nodes.length === 0) {
      return;
    }
    const canvas = ref.nativeElement;

    const nodes: FNNode[] = net.full.nodes.map((n, i) => ({ idx: i, id: n.id, presence: n.presence, cluster: n.cluster, isHub: n.isHub, ox: 0, oy: 0 }));
    const links: FNLink[] = net.full.links.map(l => ({ a: nodes[l.a], b: nodes[l.b], shared: l.shared, isHub: l.isHub }));
    const adj: FNAdjEntry[][] = nodes.map(() => []);
    for (const l of links) {
      adj[l.a.idx].push([l.b, l.shared, l]);
      adj[l.b.idx].push([l.a, l.shared, l]);
    }
    const hubs = nodes.filter(n => n.isHub);
    const free = nodes.filter(n => !n.isHub);

    this.fnNodes = nodes;
    this.fnLinks = links;
    this.fnAdj = adj;
    this.fnHubs = hubs;
    this.fnFree = free;
    this.fnLinked = new Set(nodes);

    // A one-off settle to produce a calm baseline layout (the published report's equivalent ran
    // the same kind of simulation offline, once; here it just runs once, synchronously, on load).
    const sim0 = d3
      .forceSimulation(free)
      .force(
        'link',
        d3
          .forceLink(links.filter(l => !l.isHub).map(l => ({ source: l.a, target: l.b, shared: l.shared })))
          .id((d: d3.SimulationNodeDatum) => (d as FNNode).idx)
          .distance((l: { shared: number }) => 20 + 50 / Math.sqrt(l.shared))
          .strength((l: { shared: number }) => Math.min(1, 0.05 + l.shared / 60)),
      )
      .force('charge', d3.forceManyBody().strength(-10).distanceMax(260))
      .force('collide', d3.forceCollide((d: d3.SimulationNodeDatum) => this.fnRadius(d as FNNode) + 1))
      .force('center', d3.forceCenter(0, 0))
      .stop();
    for (let i = 0; i < 220; i++) sim0.tick();
    this.fnPlaceHubs(1);
    for (const n of nodes) {
      n.ox = n.x ?? 0;
      n.oy = n.y ?? 0;
    }

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.4, 20])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.fnTransform = event.transform;
        this.fnHover = null;
        this.hideTip();
        this.renderFullNetwork();
      });
    d3.select(canvas).call(zoom);
    this.fnZoom = zoom;

    const resize = () => {
      this.fnDpr = window.devicePixelRatio || 1;
      this.fnW = canvas.clientWidth || 900;
      this.fnH = canvas.clientHeight || 560;
      canvas.width = this.fnW * this.fnDpr;
      canvas.height = this.fnH * this.fnDpr;
      this.fnFitBase();
      this.fnRebuildQuadtree();
      this.renderFullNetwork();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    this.fnResize = ro;
    resize();

    canvas.onpointermove = (event: PointerEvent) => this.onFullPointerMove(event);
    canvas.onpointerleave = () => {
      this.fnHover = null;
      this.renderFullNetwork();
      this.hideTip();
    };

    // The baseline layout above is the minShared = 1 picture; settle into the starting threshold.
    // Untracked so the slider doesn't re-run this whole setup (onFullControlsChange owns that).
    untracked(() => {
      if (this.fullRelayout() && this.fullMinShared() > 1) this.fnRelayout();
    });
  }

  private renderFullNetwork(): void {
    const net = this.factionNetwork();
    const minShared = this.fullMinShared();
    const showHubs = this.fullShowHubs();
    const pick = this.selectedCluster();
    const ref = this.fullCanvasRef();
    if (!net || !ref || this.fnNodes.length === 0) {
      return;
    }
    const canvas = ref.nativeElement;
    const ctx = canvas.getContext('2d')!;
    const { fnW: W, fnH: H, fnDpr: dpr, fnTransform: t, fnBase: base } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.cssVar('--cc-panel');
    ctx.fillRect(0, 0, W, H);

    const X = (d: FNNode) => t.applyX(base.x + base.k * (d.x ?? d.ox));
    const Y = (d: FNNode) => t.applyY(base.y + base.k * (d.y ?? d.oy));
    const vis = (l: FNLink) => l.shared >= minShared && (showHubs || !l.isHub);
    const visibleLinks = this.fnLinks.filter(vis);

    const ink = this.cssVar('--cc-ink');
    const accent = this.cssVar('--cc-accent');
    const grey = this.cssVar('--cc-s0');
    const panel = this.cssVar('--cc-panel');
    const hover = this.fnHover;
    const dim = pick !== null || !!hover;
    const lwk = Math.min(2.2, 0.5 * Math.sqrt(t.k));

    ctx.lineCap = 'round';
    ctx.strokeStyle = ink;
    ctx.lineWidth = lwk;
    const ba = Math.min(0.55, (4.5 / Math.sqrt(Math.max(1, visibleLinks.length))) * Math.sqrt(t.k));
    ctx.globalAlpha = dim ? 0.025 : ba;
    ctx.beginPath();
    for (const l of visibleLinks) {
      if (l.isHub) continue;
      ctx.moveTo(X(l.a), Y(l.a));
      ctx.lineTo(X(l.b), Y(l.b));
    }
    ctx.stroke();

    if (showHubs) {
      ctx.strokeStyle = accent;
      ctx.globalAlpha = dim ? 0.02 : Math.min(0.6, ba * 1.15);
      ctx.beginPath();
      for (const l of visibleLinks) {
        if (!l.isHub) continue;
        ctx.moveTo(X(l.a), Y(l.a));
        ctx.lineTo(X(l.b), Y(l.b));
      }
      ctx.stroke();
    }

    if (pick !== null && !hover) {
      ctx.strokeStyle = this.clusterColor(pick);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (const l of visibleLinks) {
        if (l.isHub || l.a.cluster !== pick || l.b.cluster !== pick) continue;
        ctx.moveTo(X(l.a), Y(l.a));
        ctx.lineTo(X(l.b), Y(l.b));
      }
      ctx.stroke();
    }

    const hoverSet = hover ? new Set([hover.idx, ...this.fnAdj[hover.idx].map(([o]) => o.idx)]) : null;
    if (hover) {
      for (const [o, n, l] of this.fnAdj[hover.idx]) {
        if (!vis(l)) continue;
        ctx.strokeStyle = l.isHub ? accent : hover.cluster >= 0 ? this.clusterColor(hover.cluster) : ink;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = Math.max(1, Math.min(5, Math.sqrt(n))) * Math.min(1.4, 0.6 * Math.sqrt(t.k));
        ctx.beginPath();
        ctx.moveTo(X(hover), Y(hover));
        ctx.lineTo(X(o), Y(o));
        ctx.stroke();
      }
    }

    const zr = Math.min(2.5, Math.sqrt(t.k));
    ctx.lineWidth = 1;
    for (let i = this.fnNodes.length - 1; i >= 0; i--) {
      const d = this.fnNodes[i];
      if (d.isHub) continue;
      const on = hoverSet ? hoverSet.has(d.idx) : pick === null || d.cluster === pick;
      ctx.globalAlpha = (on ? 1 : 0.12) * (minShared > 1 && !this.fnLinked.has(d) ? 0.35 : 1);
      ctx.fillStyle = d.cluster >= 0 ? this.clusterColor(d.cluster) : grey;
      const rr = this.fnRadius(d) * zr;
      ctx.beginPath();
      ctx.arc(X(d), Y(d), rr, 0, Math.PI * 2);
      ctx.fill();
      if (rr > 3) {
        ctx.strokeStyle = panel;
        ctx.stroke();
      }
    }
    for (const d of this.fnHubs) {
      ctx.globalAlpha = !showHubs && !(hoverSet && hoverSet.has(d.idx)) ? 0.35 : 1;
      ctx.fillStyle = panel;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(X(d), Y(d), this.fnRadius(d) * Math.min(1.6, zr), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.font = `500 11.5px ${this.cssVar('--cc-f-body')}`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    const lim = Math.min(this.fnNodes.length, Math.round(10 * t.k * t.k + (W > 600 ? 6 : 0)));
    const placed: [number, number, number, number][] = [];
    const candidates = hover
      ? [hover, ...this.fnAdj[hover.idx].map(([o]) => o).sort((a, b) => b.presence - a.presence).slice(0, 10)]
      : this.fnNodes.slice(0, lim).filter(d => pick === null || d.cluster === pick || d.isHub);
    for (const d of candidates) {
      const x = X(d);
      const y = Y(d) - this.fnRadius(d) * zr - 6;
      if (x < 0 || x > W || y < 10 || y > H) continue;
      const w = ctx.measureText(d.id).width;
      const box: [number, number, number, number] = [x - w / 2 - 2, y - 11, x + w / 2 + 2, y + 3];
      if (placed.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box);
      ctx.strokeStyle = panel;
      ctx.lineWidth = 3.5;
      ctx.strokeText(d.id, x, y);
      ctx.fillStyle = d.isHub ? accent : ink;
      ctx.fillText(d.id, x, y);
    }
    ctx.textAlign = 'start';
    ctx.globalAlpha = 1;

    ctx.font = `11px ${this.cssVar('--cc-f-mono')}`;
    ctx.fillStyle = this.cssVar('--cc-ink-3');
    ctx.fillText(`${this.fmt(visibleLinks.length)} links shown (≥ ${minShared} shared)`, 10, H - 10);
  }

  private onFullPointerMove(event: PointerEvent): void {
    if (this.fnSim || this.fnTimer) return;
    const net = this.factionNetwork();
    const ref = this.fullCanvasRef();
    if (!net || !ref || !this.fnQuadtree) return;
    const canvas = ref.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const t = this.fnTransform;
    const mx = t.invertX(event.clientX - rect.left);
    const my = t.invertY(event.clientY - rect.top);
    const found = this.fnQuadtree.find(mx, my, 12 / t.k) ?? null;
    if (found && found !== this.fnHover) {
      this.fnHover = found;
      this.renderFullNetwork();
      const minShared = this.fullMinShared();
      const showHubs = this.fullShowHubs();
      const nb = (this.fnAdj[found.idx] ?? []).filter(([, , l]) => l.shared >= minShared && (showHubs || !l.isHub)).sort((a, b) => b[1] - a[1]);
      const cluster = found.isHub ? 'Hub' : found.cluster >= 0 ? `${net.clusters.find(c => c.id === found!.cluster)?.lead ?? ''} group` : 'Island (no cluster)';
      this.showTip(
        event,
        this.tipTitle(found.id) +
          this.tipRow('Present in', this.fmt(found.presence) + ' systems') +
          this.tipRow('Cluster', cluster) +
          this.tipRow('Links shown', this.fmt(nb.length)) +
          (nb.length ? this.tipSub('Most shared with') + nb.slice(0, 5).map(([o, n]) => this.tipRow(o.id, String(n))).join('') : ''),
      );
    } else if (found) {
      this.moveTip(event);
    } else if (this.fnHover) {
      this.fnHover = null;
      this.renderFullNetwork();
      this.hideTip();
    }
  }

  private fnRelayout(): void {
    const minw = this.fullMinShared();
    if (minw === 1) {
      this.fnRestore();
      return;
    }
    this.fnStopAnimations();
    const vl = this.fnLinks.filter(l => !l.isHub && l.shared >= minw);
    const linked = new Set<FNNode>();
    vl.forEach(l => {
      linked.add(l.a);
      linked.add(l.b);
    });
    this.fnHubs.forEach(h => linked.add(h));
    this.fnLinked = linked;
    const nLinked = this.fnFree.filter(d => linked.has(d)).length;
    const ring = Math.max(420, Math.min(560, 280 + Math.sqrt(nLinked) * 9));
    const sim = d3
      .forceSimulation(this.fnFree)
      .alpha(1)
      .alphaDecay(0.03)
      .velocityDecay(0.38)
      .force(
        'link',
        d3
          .forceLink(vl.map(l => ({ source: l.a, target: l.b, shared: l.shared })))
          .distance((l: { shared: number }) => 14 + 46 / Math.sqrt(l.shared))
          .strength((l: { shared: number }) => Math.min(1, 0.25 + l.shared / 30)),
      )
      .force('charge', d3.forceManyBody().strength((d: d3.SimulationNodeDatum) => (linked.has(d as FNNode) ? -22 : -1.5)).distanceMax(180))
      .force('collide', d3.forceCollide((d: d3.SimulationNodeDatum) => this.fnRadius(d as FNNode) + 1).strength(0.7))
      .force(
        'r',
        d3
          .forceRadial((d: d3.SimulationNodeDatum) => (linked.has(d as FNNode) ? 0 : ring), 0, 0)
          .strength((d: d3.SimulationNodeDatum) => (linked.has(d as FNNode) ? 0.025 : 0.2)),
      )
      .on('tick', () => {
        this.fnPlaceHubs(minw);
        this.renderFullNetwork();
      })
      .on('end', () => {
        this.fnSim = undefined;
        this.fnRebuildQuadtree();
        this.renderFullNetwork();
      });
    this.fnSim = sim;
  }

  private fnRestore(): void {
    this.fnStopAnimations();
    this.fnLinked = new Set(this.fnNodes);
    const from = this.fnNodes.map((d): [number, number] => [d.x ?? d.ox, d.y ?? d.oy]);
    const timer = d3.timer(elapsed => {
      const k = Math.min(1, elapsed / 700);
      const e = d3.easeCubicInOut(k);
      this.fnNodes.forEach((d, i) => {
        d.x = from[i][0] + (d.ox - from[i][0]) * e;
        d.y = from[i][1] + (d.oy - from[i][1]) * e;
      });
      this.renderFullNetwork();
      if (k >= 1) {
        timer.stop();
        this.fnTimer = undefined;
        this.fnRebuildQuadtree();
        this.renderFullNetwork();
      }
    });
    this.fnTimer = timer;
  }

  private onFullControlsChange(): void {
    const minw = this.fullMinShared();
    const relayoutOn = this.fullRelayout();
    if (this.fnNodes.length === 0) return;
    clearTimeout(this.fnMinwTimer);
    if (relayoutOn) {
      this.fnMinwTimer = setTimeout(() => this.fnRelayout(), minw === 1 ? 0 : 180);
    } else {
      this.fnRestore();
    }
  }

  protected setFullMinShared(value: string): void {
    this.fullMinShared.set(Math.max(1, Number(value) || 1));
  }

  protected fullZoomIn(): void {
    const ref = this.fullCanvasRef();
    if (!ref || !this.fnZoom) return;
    d3.select(ref.nativeElement).transition().duration(250).call(this.fnZoom.scaleBy, 2);
  }

  protected fullZoomOut(): void {
    const ref = this.fullCanvasRef();
    if (!ref || !this.fnZoom) return;
    d3.select(ref.nativeElement).transition().duration(250).call(this.fnZoom.scaleBy, 0.5);
  }

  protected fullZoomFit(): void {
    const ref = this.fullCanvasRef();
    if (!ref || !this.fnZoom) return;
    d3.select(ref.nativeElement).transition().duration(350).call(this.fnZoom.transform, d3.zoomIdentity);
  }

  // ---- Plate 9: chord diagram among the most widespread factions ------------------------------
  private drawChord(): void {
    const ref = this.chordSvgRef();
    const net = this.factionNetwork();
    if (!ref || !net || net.chord.names.length === 0) {
      return;
    }
    const data: ChordData = net.chord;
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const size = 560;
    svg.attr('viewBox', `0 0 ${size} ${size}`);
    const outerR = size / 2 - 70;
    const innerR = outerR - 16;
    const g = svg.append('g').attr('transform', `translate(${size / 2},${size / 2})`);

    const chordLayout = d3.chord().padAngle(0.03).sortSubgroups(d3.descending);
    const chords = chordLayout(data.matrix);
    const arc = d3.arc<d3.ChordGroup>().innerRadius(innerR).outerRadius(outerR);
    const ribbon = d3.ribbon().radius(innerR);
    const selected = this.selectedCluster();

    g.append('g')
      .selectAll('path')
      .data(chords.groups)
      .join('path')
      .attr('d', arc)
      .attr('fill', d => this.clusterColor(data.cluster[d.index]))
      .attr('fill-opacity', d => (selected === null || data.cluster[d.index] === selected ? 1 : 0.2))
      .attr('stroke', this.cssVar('--cc-panel'))
      .on('pointerenter', (event: PointerEvent, d) =>
        this.showTip(
          event,
          this.tipTitle(data.names[d.index]) +
            this.tipRow('Present in', this.fmt(data.presence[d.index]) + ' systems'),
        ),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip())
      .on('click', (_event: PointerEvent, d) => this.toggleCluster(data.cluster[d.index]));

    g.append('g')
      .attr('fill-opacity', 0.75)
      .selectAll('path')
      .data(chords)
      .join('path')
      .attr('d', ribbon as never)
      .attr('fill', d => this.clusterColor(data.cluster[d.source.index]))
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 0.5)
      .on('pointerenter', (event: PointerEvent, d) =>
        this.showTip(
          event,
          this.tipTitle(`${data.names[d.source.index]} ↔ ${data.names[d.target.index]}`) +
            this.tipRow('Shared systems', this.fmt(d.source.value)),
        ),
      )
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => this.hideTip());

    g.append('g')
      .selectAll('text')
      .data(chords.groups)
      .join('text')
      .attr('transform', d => {
        const mid = (d.startAngle + d.endAngle) / 2;
        return `rotate(${(mid * 180) / Math.PI - 90}) translate(${outerR + 8},0) ${mid > Math.PI ? 'rotate(180)' : ''}`;
      })
      .attr('text-anchor', d => (((d.startAngle + d.endAngle) / 2) > Math.PI ? 'end' : 'start'))
      .attr('class', 'cc-axis-text')
      .attr('font-size', 11)
      .text(d => (data.names[d.index].length > 22 ? data.names[d.index].slice(0, 21) + '…' : data.names[d.index]));
  }

  // ---- Plate 10: the clusters on the galactic plane (canvas) ----------------------------------
  private mapW = 900;
  private mapH = 560;
  private mapDpr = 1;
  private mapBase = { k: 1, x: 0, y: 0 };
  private mapTransform = d3.zoomIdentity;
  private mapQuadtree?: d3.Quadtree<MapSystem>;
  private mapHover: MapSystem | null = null;
  private mapZoom?: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
  private mapResize?: ResizeObserver;
  private mapXExtent: [number, number] = [0, 1];
  private mapZExtent: [number, number] = [0, 1];
  private mapCoreBox: { x0: number; x1: number; z0: number; z1: number } | null = null;

  private mapFitBase(): void {
    const pad = 20;
    const [x0, x1] = this.mapXExtent;
    const [z0, z1] = this.mapZExtent;
    const k = Math.min((this.mapW - 2 * pad) / Math.max(1, x1 - x0), (this.mapH - 2 * pad) / Math.max(1, z1 - z0));
    this.mapBase = { k, x: this.mapW / 2 - k * ((x0 + x1) / 2), y: this.mapH / 2 + k * ((z0 + z1) / 2) };
  }

  private mapRebuildQuadtree(systems: readonly MapSystem[]): void {
    this.mapQuadtree = d3.quadtree<MapSystem>(
      systems as MapSystem[],
      s => this.mapBase.x + this.mapBase.k * s.x,
      s => this.mapBase.y - this.mapBase.k * s.z,
    );
  }

  private mapTransformFor(box: { x0: number; x1: number; z0: number; z1: number }): d3.ZoomTransform {
    const k = Math.min(this.mapW / ((box.x1 - box.x0) * this.mapBase.k), this.mapH / ((box.z1 - box.z0) * this.mapBase.k)) * 0.95;
    const cx = this.mapBase.x + this.mapBase.k * ((box.x0 + box.x1) / 2);
    const cy = this.mapBase.y - this.mapBase.k * ((box.z0 + box.z1) / 2);
    return d3.zoomIdentity.translate(this.mapW / 2, this.mapH / 2).scale(k).translate(-cx, -cy);
  }

  private initFactionMap(): void {
    const ref = this.mapCanvasRef();
    const net = this.factionNetwork();
    this.mapResize?.disconnect();
    if (!ref || !net || net.map.length === 0) {
      return;
    }
    const canvas = ref.nativeElement;
    this.mapXExtent = d3.extent(net.map, s => s.x) as [number, number];
    this.mapZExtent = d3.extent(net.map, s => s.z) as [number, number];
    const cx = d3.mean(net.map, s => s.x) ?? 0;
    const cz = d3.mean(net.map, s => s.z) ?? 0;
    const distances = net.map.map(s => Math.hypot(s.x - cx, s.z - cz)).sort((a, b) => a - b);
    const coreRadius = distances[Math.floor(distances.length * 0.85)] || 1000;
    this.mapCoreBox = { x0: cx - coreRadius, x1: cx + coreRadius, z0: cz - coreRadius, z1: cz + coreRadius };

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.6, 400])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.mapTransform = event.transform;
        this.mapHover = null;
        this.hideTip();
        this.renderFactionMap();
      });
    d3.select(canvas).call(zoom);
    this.mapZoom = zoom;

    const resize = () => {
      this.mapDpr = window.devicePixelRatio || 1;
      this.mapW = canvas.clientWidth || 900;
      this.mapH = canvas.clientHeight || 560;
      canvas.width = this.mapW * this.mapDpr;
      canvas.height = this.mapH * this.mapDpr;
      this.mapFitBase();
      this.mapRebuildQuadtree(net.map);
      this.renderFactionMap();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    this.mapResize = ro;
    resize();

    canvas.onpointermove = (event: PointerEvent) => this.onMapPointerMove(event);
    canvas.onpointerleave = () => {
      this.mapHover = null;
      this.renderFactionMap();
      this.hideTip();
    };
  }

  private mapApplyScope(): void {
    const net = this.factionNetwork();
    this.mapScope();
    const ref = this.mapCanvasRef();
    if (!net || !ref || !this.mapZoom) return;
    const target = this.mapScope() === 'core' && this.mapCoreBox ? this.mapTransformFor(this.mapCoreBox) : d3.zoomIdentity;
    d3.select(ref.nativeElement).transition().duration(350).call(this.mapZoom.transform, target);
  }

  private renderFactionMap(): void {
    const net = this.factionNetwork();
    const pick = this.selectedCluster();
    const ref = this.mapCanvasRef();
    if (!net || !ref) {
      return;
    }
    const canvas = ref.nativeElement;
    const ctx = canvas.getContext('2d')!;
    const { mapW: W, mapH: H, mapDpr: dpr, mapTransform: t, mapBase: base } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.cssVar('--cc-panel');
    ctx.fillRect(0, 0, W, H);

    const X = (s: MapSystem) => t.applyX(base.x + base.k * s.x);
    const Y = (s: MapSystem) => t.applyY(base.y - base.k * s.z);

    const scale = t.k * base.k;
    const step = scale > 0.6 ? 100 : scale > 0.15 ? 500 : 1000;
    ctx.strokeStyle = this.cssVar('--cc-grid');
    ctx.lineWidth = 1;
    ctx.font = `11px ${this.cssVar('--cc-f-mono')}`;
    ctx.fillStyle = this.cssVar('--cc-ink-3');
    const x0 = (t.invertX(0) - base.x) / base.k;
    const x1 = (t.invertX(W) - base.x) / base.k;
    const z1 = (base.y - t.invertY(0)) / base.k;
    const z0 = (base.y - t.invertY(H)) / base.k;
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const sx = Math.round(t.applyX(base.x + base.k * gx)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
      ctx.stroke();
      ctx.fillText(this.fmt(gx), sx + 3, H - 6);
    }
    for (let gz = Math.ceil(z0 / step) * step; gz <= z1; gz += step) {
      const sy = Math.round(t.applyY(base.y - base.k * gz)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
      ctx.stroke();
      ctx.fillText(this.fmt(gz), 4, sy - 4);
    }

    const rr = Math.max(1.6, Math.min(4, 1.4 * Math.sqrt(t.k)));
    const order = [-1, 7, 6, 5, 4, 3, 2, 1, 0];
    for (const g of order) {
      ctx.fillStyle = g < 0 ? this.cssVar('--cc-s0') : this.clusterColor(g);
      ctx.globalAlpha = pick === null || pick === g ? (g < 0 ? 0.75 : 0.9) : 0.08;
      ctx.beginPath();
      for (const s of net.map) {
        if (s.cluster !== g) continue;
        const x = X(s);
        const y = Y(s);
        if (x < -5 || x > W + 5 || y < -5 || y > H + 5) continue;
        ctx.moveTo(x + rr, y);
        ctx.arc(x, y, rr, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const solX = t.applyX(base.x);
    const solY = t.applyY(base.y);
    ctx.strokeStyle = this.cssVar('--cc-ink');
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(solX, solY, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this.cssVar('--cc-ink');
    ctx.font = `600 12px ${this.cssVar('--cc-f-body')}`;
    ctx.fillText('Sol', solX + 9, solY - 8);
    ctx.fillStyle = this.cssVar('--cc-ink-3');
    ctx.font = `11px ${this.cssVar('--cc-f-mono')}`;
    ctx.fillText('↑ towards galactic core', 10, 16);

    if (this.mapHover) {
      const x = X(this.mapHover);
      const y = Y(this.mapHover);
      ctx.strokeStyle = this.cssVar('--cc-ink');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, rr + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private onMapPointerMove(event: PointerEvent): void {
    const net = this.factionNetwork();
    const ref = this.mapCanvasRef();
    if (!net || !ref || !this.mapQuadtree) return;
    const canvas = ref.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const t = this.mapTransform;
    const mx = t.invertX(event.clientX - rect.left);
    const my = t.invertY(event.clientY - rect.top);
    const found = this.mapQuadtree.find(mx, my, 10 / t.k) ?? null;
    const pick = this.selectedCluster();
    const visible = found && (pick === null || pick === found.cluster);
    if (visible && found !== this.mapHover) {
      this.mapHover = found;
      this.renderFactionMap();
      const cluster = found.cluster >= 0 ? `${net.clusters.find(c => c.id === found!.cluster)?.lead ?? ''} group` : '—';
      this.showTip(
        event,
        this.tipTitle(found.systemName) +
          this.tipRow('Controller', found.controller ?? '—') +
          this.tipRow('Canonn present', found.canonnPresent ? 'yes' : 'no') +
          this.tipRow('Cluster', cluster),
      );
    } else if (visible) {
      this.moveTip(event);
    } else if (this.mapHover) {
      this.mapHover = null;
      this.renderFactionMap();
      this.hideTip();
    }
  }

  protected mapZoomIn(): void {
    const ref = this.mapCanvasRef();
    if (!ref || !this.mapZoom) return;
    d3.select(ref.nativeElement).transition().duration(250).call(this.mapZoom.scaleBy, 2);
  }

  protected mapZoomOut(): void {
    const ref = this.mapCanvasRef();
    if (!ref || !this.mapZoom) return;
    d3.select(ref.nativeElement).transition().duration(250).call(this.mapZoom.scaleBy, 0.5);
  }

  protected mapZoomFit(): void {
    this.mapApplyScope();
  }

  /** Shared gridlines + value-axis labels for a linear y-scale bar chart. */
  private drawAxisGridlines(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    y: d3.ScaleLinear<number, number>,
    m: { l: number; t: number; b: number },
    width: number,
    tickCount = 5,
  ): void {
    const ticks = y.ticks(tickCount);
    svg
      .append('g')
      .selectAll('line')
      .data(ticks)
      .join('line')
      .attr('x1', m.l)
      .attr('x2', width - 14)
      .attr('y1', d => y(d))
      .attr('y2', d => y(d))
      .attr('stroke', this.cssVar('--cc-grid'));
    svg
      .append('g')
      .selectAll('text')
      .data(ticks)
      .join('text')
      .attr('x', m.l - 8)
      .attr('y', d => y(d) + 4)
      .attr('text-anchor', 'end')
      .attr('class', 'cc-axis-text')
      .text(d => this.fmt(d));
  }
}

/** Straight-line distance from Sol, in light years, from a row's galactic x/y/z. */
function distanceLy(row: BgsRow): number {
  return Math.sqrt(row.x * row.x + row.y * row.y + row.z * row.z);
}

/** The path for a bar with rounded top corners (or square, when it sits under another segment). */
function roundedTopBarPath(x: number, width: number, yTop: number, yBottom: number, round: boolean): string {
  const r = round ? Math.min(4, Math.max(0, yBottom - yTop)) : 0;
  return `M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + width - r}Q${x + width},${yTop} ${x + width},${yTop + r}V${yBottom}Z`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c as '&' | '<' | '>' | '"']);
}
