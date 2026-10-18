import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
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
  FullNetworkNode,
  MapSystem,
  computeFactionNetwork,
} from '../data/faction-network';
import { LoadingTerminalComponent } from '../loading-terminal/loading-terminal.component';

type LoadStatus = 'loading' | 'ready' | 'error';
type RivalsUsFilter = 'all' | UsSide;
type RivalsSort = 'score' | 'conf' | 'lead';

/** Where the station-family colour comes from in the template; kept here so the template stays declarative. */
const STATION_FAMILY_COLOR: Record<string, string> = {
  Construction: 'var(--cc-s2)',
  Outpost: 'var(--cc-s3)',
  Surface: 'var(--cc-s1)',
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

/**
 * A live-data companion to the published "Canonn Colony Census" and "Canonn Faction Atlas"
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
  imports: [LoadingTerminalComponent],
  templateUrl: './colony-census.component.html',
  styleUrl: './colony-census.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColonyCensusComponent implements OnInit {
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
  protected readonly fullMinShared = signal(1);
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

  // Mutable simulation/zoom state for the two canvas plates — not signals: d3 mutates these every
  // tick/zoom gesture, and routing that through change detection would be wasted work.
  private fullSimNodes: (FullNetworkNode & d3.SimulationNodeDatum)[] = [];
  private fullSim?: d3.Simulation<FullNetworkNode & d3.SimulationNodeDatum, undefined>;
  private fullSimLinks: { source: FullNetworkNode & d3.SimulationNodeDatum; target: FullNetworkNode & d3.SimulationNodeDatum; shared: number }[] = [];
  private fullTransform = d3.zoomIdentity;
  private fullHover: FullNetworkNode | null = null;
  private mapTransform = d3.zoomIdentity;
  private mapHover: MapSystem | null = null;

  constructor() {
    effect(() => this.drawInfluenceHistogram());
    effect(() => this.drawFreshnessHistogram());
    effect(() => this.drawArchitectDistribution());
    effect(() => this.drawArchitectMinimap());
    effect(() => this.drawPopulationScatter());
    effect(() => this.drawRivals());
    effect(() => this.drawFootprintStrip());
    effect(() => this.drawFactionWeb());
    effect(() => this.drawChord());
    effect(() => this.drawFullNetwork());
    effect(() => this.drawFactionMap());
    effect(() => {
      if (this.fullCanvasRef() && !this.fullZoomReady) {
        this.fullZoomReady = true;
        this.onFullCanvasReady();
      }
    });
    effect(() => {
      if (this.mapCanvasRef() && !this.mapZoomReady) {
        this.mapZoomReady = true;
        this.onMapCanvasReady();
      }
    });
  }

  private fullZoomReady = false;
  private mapZoomReady = false;

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.status.set('loading');
    this.selectedArchitect.set(null);
    this.selectedRival.set(null);
    this.selectedCluster.set(null);
    this.fullSimNodes = [];
    this.fullSim?.stop();
    this.fullSim = undefined;
    try {
      const snapshot = await this.bgsService.getSystems();
      this.generatedAt.set(snapshot.generatedAt);
      this.rows.set(snapshot.rows);
      this.stats.set(computeCensusStats(snapshot.rows));
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
    const m = { l: 44, r: 14, t: 16, b: 34 };
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
      .attr('fill', this.cssVar('--cc-s2'))
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
      .attr('fill', p => this.cssVar(p.hasArchitect ? '--cc-s2' : '--cc-s1'))
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
  private drawFactionWeb(): void {
    const ref = this.webSvgRef();
    const net = this.factionNetwork();
    if (!ref || !net || net.web.nodes.length === 0) {
      return;
    }
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const el = ref.nativeElement;
    const W = el.clientWidth || 900;
    const H = 560;
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    type WebNode = FactionNode & d3.SimulationNodeDatum;
    const nodes: WebNode[] = net.web.nodes.map(n => ({ ...n }));
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const links = net.web.links.map(l => ({ a: l.a, b: l.b, shared: l.shared, lift: l.lift }));
    const simLinks = links.map(l => ({ ...l, source: nodeById.get(l.a)!, target: nodeById.get(l.b)! }));

    const r = d3.scaleSqrt([1, Math.max(1, d3.max(nodes, n => n.presence) ?? 1)], [3.5, 17]);
    const maxLift = Math.max(4, d3.max(links, l => l.lift) ?? 4);
    const lw = d3.scaleLinear([1, maxLift], [0.6, 3]).clamp(true);

    const sim = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink(simLinks)
          .id((d: d3.SimulationNodeDatum) => (d as WebNode).id)
          .distance(58)
          .strength(0.3),
      )
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force(
        'collide',
        d3.forceCollide((d: WebNode) => r(d.presence) + 2),
      )
      .stop();
    for (let i = 0; i < 240; i++) sim.tick();

    const g = svg.append('g');
    const linkSel = g
      .append('g')
      .selectAll('line')
      .data(simLinks)
      .join('line')
      .attr('x1', d => d.source.x!)
      .attr('y1', d => d.source.y!)
      .attr('x2', d => d.target.x!)
      .attr('y2', d => d.target.y!)
      .attr('stroke', this.cssVar('--cc-grid'))
      .attr('stroke-width', d => lw(d.lift));

    const selected = this.selectedCluster();
    const nodeSel = g
      .append('g')
      .selectAll<SVGCircleElement, WebNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('cx', d => d.x!)
      .attr('cy', d => d.y!)
      .attr('r', d => r(d.presence))
      .attr('fill', d => this.clusterColor(d.cluster))
      .attr('fill-opacity', d => (selected === null || d.cluster === selected ? 1 : 0.18))
      .attr('stroke', this.cssVar('--cc-panel'))
      .attr('stroke-width', 1);

    const adjacency = new Map<string, Set<string>>();
    for (const l of links) {
      (adjacency.get(l.a) ?? adjacency.set(l.a, new Set()).get(l.a)!).add(l.b);
      (adjacency.get(l.b) ?? adjacency.set(l.b, new Set()).get(l.b)!).add(l.a);
    }

    const reposition = () => {
      nodeSel.attr('cx', d => d.x!).attr('cy', d => d.y!);
      linkSel.attr('x1', d => d.source.x!).attr('y1', d => d.source.y!).attr('x2', d => d.target.x!).attr('y2', d => d.target.y!);
    };

    nodeSel.call(
      d3
        .drag<SVGCircleElement, WebNode>()
        .on('drag', (event, d) => {
          d.x = event.x;
          d.y = event.y;
          reposition();
        }),
    );

    nodeSel
      .on('pointerenter', (event: PointerEvent, d) => {
        const neighbors = adjacency.get(d.id) ?? new Set();
        nodeSel.attr('fill-opacity', n => (n === d || neighbors.has(n.id) ? 1 : 0.12));
        linkSel.attr('stroke-opacity', l => (l.a === d.id || l.b === d.id ? 0.8 : 0.08));
        const cluster = net.clusters.find(c => c.id === d.cluster);
        this.showTip(
          event,
          this.tipTitle(d.id) +
            this.tipRow('Present in', this.fmt(d.presence) + ' systems') +
            this.tipRow('Controls', this.fmt(d.controls) + ' systems') +
            this.tipRow('Cluster', cluster ? cluster.lead + ' group' : 'Other'),
        );
      })
      .on('pointermove', (event: PointerEvent) => this.moveTip(event))
      .on('pointerleave', () => {
        const sel = this.selectedCluster();
        nodeSel.attr('fill-opacity', n => (sel === null || n.cluster === sel ? 1 : 0.18));
        linkSel.attr('stroke-opacity', 1);
        this.hideTip();
      })
      .on('click', (_event: PointerEvent, d) => this.toggleCluster(d.cluster));
  }

  // ---- Plate 8: the full network — every faction, every shared-system pair (canvas) ----------
  private initFullSimNodes(net: FactionNetworkData): void {
    const byId = new Map<string, FullNetworkNode & d3.SimulationNodeDatum>();
    this.fullSimNodes = net.full.nodes.map((n, i) => {
      const angle = (n.cluster < 0 ? 8 : n.cluster % 8) * (Math.PI / 4) + (i % 7) * 0.03;
      const radius = n.isHub ? 0 : 140 + ((i * 37) % 260);
      const node = { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius } as FullNetworkNode & d3.SimulationNodeDatum;
      byId.set(n.id, node);
      return node;
    });
    this.fullSimLinks = net.full.links.map(l => ({
      source: this.fullSimNodes[l.a],
      target: this.fullSimNodes[l.b],
      shared: l.shared,
    }));
  }

  private runFullSimulation(visibleLinks: { source: FullNetworkNode & d3.SimulationNodeDatum; target: FullNetworkNode & d3.SimulationNodeDatum; shared: number }[]): void {
    this.fullSim?.stop();
    const sim = d3
      .forceSimulation(this.fullSimNodes)
      .force(
        'link',
        d3
          .forceLink(visibleLinks)
          .distance(34)
          .strength(0.04),
      )
      .force('charge', d3.forceManyBody().strength(-18).distanceMax(320))
      .force('center', d3.forceCenter(0, 0))
      .force(
        'radial',
        d3
          .forceRadial((d: d3.SimulationNodeDatum) => ((d as FullNetworkNode).isHub ? 0 : 160), 0, 0)
          .strength((d: d3.SimulationNodeDatum) => ((d as FullNetworkNode).isHub ? 0.4 : 0.02)),
      )
      .stop();
    for (let i = 0; i < 160; i++) sim.tick();
    this.fullSim = sim;
  }

  private drawFullNetwork(): void {
    const ref = this.fullCanvasRef();
    const net = this.factionNetwork();
    if (!ref || !net || net.full.nodes.length === 0) {
      return;
    }
    const canvas = ref.nativeElement;
    const needsInit = this.fullSimNodes.length === 0;
    if (needsInit) {
      this.initFullSimNodes(net);
    }
    const minShared = this.fullMinShared();
    const showHubs = this.fullShowHubs();
    const relayout = this.fullRelayout();
    const visibleLinks = this.fullSimLinks.filter(l => l.shared >= minShared && (showHubs || (!l.source.isHub && !l.target.isHub)));
    if (relayout) {
      this.runFullSimulation(visibleLinks);
    }
    this.renderFullCanvas(canvas, net, visibleLinks, minShared, showHubs);
  }

  private renderFullCanvas(
    canvas: HTMLCanvasElement,
    net: FactionNetworkData,
    visibleLinks: { source: FullNetworkNode & d3.SimulationNodeDatum; target: FullNetworkNode & d3.SimulationNodeDatum; shared: number }[],
    minShared: number,
    showHubs: boolean,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 560;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = this.fullTransform;
    ctx.save();
    ctx.translate(W / 2 + t.x, H / 2 + t.y);
    ctx.scale(t.k, t.k);

    const r = d3.scaleSqrt([1, Math.max(1, d3.max(this.fullSimNodes, n => n.presence) ?? 1)], [1.4, 7]);
    const hover = this.fullHover;
    const hoverNeighbors = new Set<string>();
    if (hover) {
      for (const l of visibleLinks) {
        if (l.source.id === hover.id) hoverNeighbors.add(l.target.id);
        if (l.target.id === hover.id) hoverNeighbors.add(l.source.id);
      }
    }

    ctx.lineWidth = 1 / t.k;
    for (const l of visibleLinks) {
      const dim = hover && l.source.id !== hover.id && l.target.id !== hover.id;
      ctx.strokeStyle = dim ? this.cssVar('--cc-grid') : l.source.isHub || l.target.isHub ? this.cssVar('--cc-accent') : this.cssVar('--cc-ink-3');
      ctx.globalAlpha = dim ? 0.12 : l.source.isHub || l.target.isHub ? 0.55 : 0.3;
      ctx.beginPath();
      ctx.moveTo(l.source.x!, l.source.y!);
      ctx.lineTo(l.target.x!, l.target.y!);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const n of this.fullSimNodes) {
      if (n.isHub && !showHubs) continue;
      const dim = hover && n.id !== hover.id && !hoverNeighbors.has(n.id);
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.isHub ? 9 : r(n.presence), 0, Math.PI * 2);
      ctx.fillStyle = n.isHub ? this.cssVar('--cc-accent') : this.clusterColor(n.cluster);
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.fill();
      if (n.isHub) {
        ctx.lineWidth = 1.5 / t.k;
        ctx.strokeStyle = this.cssVar('--cc-panel');
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.font = `11px ${this.cssVar('--cc-f-mono')}`;
    ctx.fillStyle = this.cssVar('--cc-ink-3');
    ctx.fillText(`${this.fmt(this.fullSimNodes.length)} factions · ${this.fmt(visibleLinks.length)} links shown (≥ ${minShared} shared)`, 10, H - 10);
  }

  protected onFullCanvasReady(): void {
    const ref = this.fullCanvasRef();
    if (!ref) return;
    const canvas = ref.nativeElement;
    const sel = d3.select(canvas);
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 8])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.fullTransform = event.transform;
        this.drawFullNetwork();
      });
    sel.call(zoom);
    sel.on('pointermove', (event: PointerEvent) => {
      const net = this.factionNetwork();
      if (!net) return;
      const W = canvas.clientWidth || 900;
      const H = canvas.clientHeight || 560;
      const [mx, my] = d3.pointer(event);
      const t = this.fullTransform;
      const x = (mx - W / 2 - t.x) / t.k;
      const y = (my - H / 2 - t.y) / t.k;
      let found: (FullNetworkNode & d3.SimulationNodeDatum) | null = null;
      let bestDist = 12 / t.k;
      for (const n of this.fullSimNodes) {
        const d = Math.hypot((n.x ?? 0) - x, (n.y ?? 0) - y);
        if (d < bestDist) {
          bestDist = d;
          found = n;
        }
      }
      if (found !== this.fullHover) {
        this.fullHover = found;
        this.drawFullNetwork();
      }
      if (found) {
        const cluster = net.clusters.find(c => c.id === found!.cluster);
        this.showTip(
          event,
          this.tipTitle(found.id) +
            this.tipRow('Present in', this.fmt(found.presence) + ' systems') +
            this.tipRow('Cluster', found.isHub ? 'Hub' : cluster ? cluster.lead + ' group' : 'Other'),
        );
      } else {
        this.hideTip();
      }
    });
    sel.on('pointerleave', () => {
      this.fullHover = null;
      this.hideTip();
      this.drawFullNetwork();
    });
  }

  protected setFullMinShared(value: string): void {
    this.fullMinShared.set(Math.max(1, Number(value) || 1));
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
  private drawFactionMap(): void {
    const ref = this.mapCanvasRef();
    const net = this.factionNetwork();
    if (!ref || !net) {
      return;
    }
    const canvas = ref.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 900;
    const H = canvas.clientHeight || 560;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const scope = this.mapScope();
    const systems = scope === 'core' ? net.map.filter(s => Math.hypot(s.x, s.z) < 4000) : net.map;
    const xs = d3.extent(systems, s => s.x) as [number, number];
    const zs = d3.extent(systems, s => s.z) as [number, number];
    const pad = Math.max(100, (xs[1] - xs[0]) * 0.05);
    const x = d3.scaleLinear([xs[0] - pad, xs[1] + pad], [0, W]);
    const z = d3.scaleLinear([zs[0] - pad, zs[1] + pad], [H, 0]);

    const t = this.mapTransform;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const selected = this.selectedCluster();
    const hover = this.mapHover;
    for (const s of systems) {
      const dim = (selected !== null && s.cluster !== selected) || (hover !== null && hover !== s);
      ctx.beginPath();
      ctx.arc(x(s.x), z(s.z), s.canonnPresent ? 2.1 : 1.3, 0, Math.PI * 2);
      ctx.fillStyle = s.cluster >= 0 ? this.clusterColor(s.cluster) : this.cssVar('--cc-s0');
      ctx.globalAlpha = dim ? 0.15 : s.canonnPresent ? 0.95 : 0.55;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x(0), z(0), 5 / t.k, 0, Math.PI * 2);
    ctx.strokeStyle = this.cssVar('--cc-ink');
    ctx.lineWidth = 1.5 / t.k;
    ctx.stroke();
    ctx.restore();
    this.mapScaleRef = { x, z };
  }

  private mapScaleRef: { x: d3.ScaleLinear<number, number>; z: d3.ScaleLinear<number, number> } | null = null;

  protected onMapCanvasReady(): void {
    const ref = this.mapCanvasRef();
    if (!ref) return;
    const canvas = ref.nativeElement;
    const sel = d3.select(canvas);
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.5, 20])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        this.mapTransform = event.transform;
        this.drawFactionMap();
      });
    sel.call(zoom);
    sel.on('pointermove', (event: PointerEvent) => {
      const net = this.factionNetwork();
      if (!net || !this.mapScaleRef) return;
      const [mx, my] = d3.pointer(event);
      const t = this.mapTransform;
      const px = (mx - t.x) / t.k;
      const py = (my - t.y) / t.k;
      const scope = this.mapScope();
      const systems = scope === 'core' ? net.map.filter(s => Math.hypot(s.x, s.z) < 4000) : net.map;
      let found: MapSystem | null = null;
      let bestDist = 6;
      for (const s of systems) {
        const d = Math.hypot(this.mapScaleRef.x(s.x) - px, this.mapScaleRef.z(s.z) - py);
        if (d < bestDist) {
          bestDist = d;
          found = s;
        }
      }
      if (found !== this.mapHover) {
        this.mapHover = found;
        this.drawFactionMap();
      }
      if (found) {
        const cluster = net.clusters.find(c => c.id === found!.cluster);
        this.showTip(
          event,
          this.tipTitle(found.systemName) +
            this.tipRow('Controller', found.controller ?? '—') +
            this.tipRow('Canonn present', found.canonnPresent ? 'yes' : 'no') +
            this.tipRow('Cluster', cluster ? cluster.lead + ' group' : '—'),
        );
      } else {
        this.hideTip();
      }
    });
    sel.on('pointerleave', () => {
      this.mapHover = null;
      this.hideTip();
      this.drawFactionMap();
    });
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
