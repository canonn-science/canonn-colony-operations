import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import * as d3 from 'd3';
import { AtlasStats, AtlasSystem, PrefGroup } from '../data/atlas-stats';

/** The story-style plates drawn by {@link CensusAtlasComponent}; the census page supplies each plate's heading. */
export type AtlasPlate =
  | 'footprint'
  | 'records'
  | 'recon'
  | 'builders'
  | 'control'
  | 'margins'
  | 'retreat'
  | 'week'
  | 'map'
  | 'named'
  | 'neighbours';

type MapView = 'near' | 'all';
type MapFilter = 'all' | 'pref' | 'move' | 'recon';

const PREF_LABEL: Record<PrefGroup, string> = {
  C: 'Prefers Canonn',
  D: 'Prefers CDSR',
  O: 'Prefers another faction',
  U: 'No preference recorded',
};
const RECON_PREVIEW = 20;

/**
 * The figure half of one "atlas" plate (the infographic-style plates added to the Architects and
 * Factions tabs): grids, bars, maps and lists drawn from {@link AtlasStats}. The census page owns
 * each plate's eyebrow, headline and description, so this component renders only the figure.
 *
 * Unencapsulated on purpose: most of it is d3-drawn SVG/canvas that never carries Angular's
 * scoping attributes. Every class is prefixed `ca-`, and colours come from the census page's
 * `--cc-*` custom properties, which inherit down into this element.
 */
@Component({
  selector: 'app-census-atlas',
  templateUrl: './census-atlas.component.html',
  styleUrl: './census-atlas.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CensusAtlasComponent implements OnDestroy {
  readonly stats = input.required<AtlasStats>();
  readonly plate = input.required<AtlasPlate>();

  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly prefLabel = PREF_LABEL;
  protected readonly tip = signal<{ visible: boolean; x: number; y: number; html: string }>({
    visible: false,
    x: 0,
    y: 0,
    html: '',
  });
  protected readonly width = signal(0);

  protected readonly showAllRecon = signal(false);
  protected readonly mapView = signal<MapView>('near');
  protected readonly mapFilter = signal<MapFilter>('all');

  private readonly gridRef = viewChild<ElementRef<HTMLCanvasElement>>('grid');
  private readonly packRef = viewChild<ElementRef<SVGSVGElement>>('pack');
  private readonly marginRef = viewChild<ElementRef<SVGSVGElement>>('margin');
  private readonly nfRef = viewChild<ElementRef<SVGSVGElement>>('nf');
  private readonly moversRef = viewChild<ElementRef<SVGSVGElement>>('movers');
  private readonly sparksRef = viewChild<ElementRef<HTMLElement>>('sparks');
  private readonly mapRef = viewChild<ElementRef<HTMLCanvasElement>>('map');
  private readonly nbRef = viewChild<ElementRef<SVGSVGElement>>('nb');
  private readonly ppRef = viewChild<ElementRef<SVGSVGElement>>('pp');

  private resize?: ResizeObserver;
  private gridOrder: AtlasSystem[] = [];
  private gridGeo = { cell: 7, cols: 1 };
  private mapPts: { x: number; y: number; s: AtlasSystem }[] = [];

  protected readonly coverageRows = computed(() => {
    const order: PrefGroup[] = ['C', 'D', 'O', 'U'];
    return order.map((g) => this.stats().coverage.find((c) => c.group === g)!).filter(Boolean);
  });
  protected readonly affiliationRows = computed(() => {
    const a = this.stats().affiliation;
    return [
      { label: 'Canonn member', value: a.member, cls: 'ca-c' },
      { label: 'Not a Canonn member', value: a.notMember, cls: 'ca-o' },
      { label: 'Membership unknown', value: a.unknown, cls: 'ca-o2' },
      { label: 'Not a colony', value: a.notColony, cls: 'ca-o3' },
      { label: 'Nothing recorded yet', value: a.none, cls: 'ca-none' },
    ];
  });
  protected readonly total = computed(() => this.stats().systems.length);
  protected readonly reconRows = computed(() =>
    this.showAllRecon() ? this.stats().recon : this.stats().recon.slice(0, RECON_PREVIEW),
  );
  protected readonly reconExact = computed(() => this.stats().recon.filter((r) => r.exact).length);
  protected readonly reconCanonn = computed(
    () => this.stats().recon.filter((r) => r.us === 'C').length,
  );
  protected readonly reconNear = computed(
    () => this.stats().recon.filter((r) => r.fromVarati <= 250).length,
  );
  protected readonly matrixRows = computed(() => {
    const m = this.stats().matrix;
    return (['C', 'D', 'O', 'U'] as PrefGroup[]).map((g) => ({
      group: g,
      label: PREF_LABEL[g],
      ...m[g],
      total: m[g].C + m[g].D + m[g].O,
    }));
  });
  protected readonly marginCounts = computed(() => {
    const all = this.stats().margins;
    return {
      close: all.filter((m) => m.margin < 5).length,
      middle: all.filter((m) => m.margin >= 5 && m.margin < 15).length,
      healthy: all.filter((m) => m.margin >= 15).length,
      total: all.length,
    };
  });
  protected readonly retreatPossible = computed(
    () => this.stats().lowInfluence.filter((l) => l.retreatPossible).length,
  );

  constructor() {
    effect(() => this.drawGrid());
    effect(() => this.drawPack());
    effect(() => this.drawMargins());
    effect(() => this.drawFactionCounts());
    effect(() => this.drawMovers());
    effect(() => this.drawSparks());
    effect(() => this.drawMap());
    effect(() =>
      this.drawHBars(
        this.nbRef(),
        this.stats().neighbours.map((n) => [n.faction, n.systems] as const),
        '--cc-other',
      ),
    );
    effect(() =>
      this.drawHBars(
        this.ppRef(),
        this.stats().powers.map((p) => [p.power, p.systems] as const),
        '--cc-ink-3',
      ),
    );
    queueMicrotask(() => {
      this.resize = new ResizeObserver((entries) =>
        this.width.set(Math.round(entries[0].contentRect.width)),
      );
      this.resize.observe(this.host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.resize?.disconnect();
  }

  protected round(value: number): number {
    return Math.round(value);
  }

  protected fmt(value: number): string {
    return d3.format(',')(value);
  }

  protected pct(part: number, total: number): string {
    return total ? `${((part / total) * 100).toFixed(1)}%` : '—';
  }

  protected inara(system: string): string {
    return 'https://inara.cz/elite/starsystem/?search=' + encodeURIComponent(system);
  }

  protected flexOf(value: number): string {
    return `${value} 0 0`;
  }

  private css(name: string): string {
    return getComputedStyle(this.host.nativeElement).getPropertyValue(name).trim();
  }

  private prefColor(g: PrefGroup): string {
    return this.css(
      g === 'C' ? '--cc-canonn' : g === 'D' ? '--cc-cdsr' : g === 'O' ? '--cc-other' : '--cc-unset',
    );
  }

  private ctrlColor(g: 'C' | 'D' | 'O'): string {
    return this.css(g === 'C' ? '--cc-canonn' : g === 'D' ? '--cc-cdsr' : '--cc-other');
  }

  protected showTip(event: PointerEvent | MouseEvent, html: string): void {
    this.tip.set({ visible: true, x: event.clientX, y: event.clientY, html });
  }

  protected hideTip(): void {
    this.tip.update((t) => ({ ...t, visible: false }));
  }

  private setupCanvas(
    canvas: HTMLCanvasElement,
    height: number,
  ): [CanvasRenderingContext2D, number] {
    const w = canvas.clientWidth || this.width() || 900;
    const r = window.devicePixelRatio || 1;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(height * r);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return [ctx, w];
  }

  // ---- Footprint grid -------------------------------------------------------------------------
  private drawGrid(): void {
    const ref = this.gridRef();
    const s = this.stats();
    this.width();
    if (!ref) return;
    const rank = (a: number) => (a === 1 ? 0 : a === 2 ? 1 : 2);
    const prefOrder: PrefGroup[] = ['C', 'D', 'O', 'U'];
    this.gridOrder = [...s.systems].sort(
      (a, b) =>
        prefOrder.indexOf(a.pref) - prefOrder.indexOf(b.pref) ||
        rank(a.arch) - rank(b.arch) ||
        a.name.localeCompare(b.name),
    );
    const canvas = ref.nativeElement;
    const W = canvas.clientWidth || 900;
    const cell = W < 520 ? 6 : W < 900 ? 7 : 8;
    const cols = Math.max(1, Math.floor(W / cell));
    const rows = Math.ceil(this.gridOrder.length / cols);
    const [ctx] = this.setupCanvas(canvas, rows * cell);
    this.gridGeo = { cell, cols };
    this.gridOrder.forEach((sys, k) => {
      const x = (k % cols) * cell;
      const y = Math.floor(k / cols) * cell;
      const c = this.prefColor(sys.pref);
      if (sys.arch === 1) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, cell - 1.2, cell - 1.2);
      } else if (sys.arch === 2) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, cell - 1.2, cell - 1.2);
      } else {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 2.2, cell - 2.2);
      }
    });
    ctx.globalAlpha = 1;
  }

  protected onGridMove(event: PointerEvent): void {
    const canvas = event.target as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const { cell, cols } = this.gridGeo;
    const c = Math.floor((event.clientX - r.left) / cell);
    const k = Math.floor((event.clientY - r.top) / cell) * cols + c;
    const s = c < cols ? this.gridOrder[k] : undefined;
    if (!s) return this.hideTip();
    const arch =
      s.arch === 1
        ? 'architect on record'
        : s.arch === 2
          ? 'recorded as not a colony'
          : 'no architect record yet';
    this.showTip(event, `<b>${escapeHtml(s.name)}</b>${PREF_LABEL[s.pref]} · ${arch}`);
  }

  // ---- Builders pack --------------------------------------------------------------------------
  private drawPack(): void {
    const ref = this.packRef();
    const builders = this.stats().builders;
    const W = Math.min(this.width() || 900, 1100);
    if (!ref || !builders.length) return;
    const H = Math.min(W, 760);
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    type Node = { b?: (typeof builders)[number]; children?: Node[] };
    const root = d3
      .hierarchy<Node>({ children: builders.map((b) => ({ b })) })
      .sum((d) => d.b?.count ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    d3.pack<Node>().size([W, H]).padding(1.5)(root);
    const dominant = (b: (typeof builders)[number]): PrefGroup =>
      (['C', 'D', 'O', 'U'] as PrefGroup[]).reduce(
        (best, g) => (b.byPref[g] > b.byPref[best] ? g : best),
        'C' as PrefGroup,
      );
    const onCanonn = this.css('--cc-on-canonn');
    const leaves = root.leaves() as d3.HierarchyCircularNode<Node>[];
    const g = svg
      .selectAll('g')
      .data(leaves)
      .join('g')
      .attr('transform', (d) => `translate(${d.x},${d.y})`);
    g.append('circle')
      .attr('r', (d) => d.r)
      .attr('fill', (d) => this.prefColor(dominant(d.data.b!)))
      .on('pointermove', (event: PointerEvent, d) => {
        const b = d.data.b!;
        this.showTip(
          event,
          `<b>${escapeHtml(b.name)}</b>${b.count} system${b.count > 1 ? 's' : ''} · Canonn ${b.byPref.C} · CDSR ${b.byPref.D} · other ${b.byPref.O} · none ${b.byPref.U}`,
        );
      })
      .on('pointerleave', () => this.hideTip());
    const big = g.filter((d) => d.r > 20);
    big
      .append('text')
      .attr('class', 'ca-pack-name')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.1em')
      .style('font-size', (d) => `${Math.min(15, d.r / 3.6)}px`)
      .style('fill', (d) => (dominant(d.data.b!) === 'C' ? onCanonn : '#fff'))
      .text((d) =>
        d.data.b!.name.length > 14 ? d.data.b!.name.slice(0, 13) + '…' : d.data.b!.name,
      );
    big
      .append('text')
      .attr('class', 'ca-pack-count')
      .attr('text-anchor', 'middle')
      .attr('dy', '1.3em')
      .style('font-size', (d) => `${Math.min(13, d.r / 4)}px`)
      .style('fill', (d) => (dominant(d.data.b!) === 'C' ? onCanonn : '#fff'))
      .text((d) => d.data.b!.count);
  }

  // ---- Margin of control ----------------------------------------------------------------------
  private drawMargins(): void {
    const ref = this.marginRef();
    const margins = this.stats().margins;
    const W = this.width() || 900;
    if (!ref) return;
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const rowH = 170;
    const m = { l: 76, r: 16, t: 12, b: 30 };
    const H = rowH * 2 + m.t + m.b;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const lo = -10;
    const hi = 100;
    const x = d3.scaleLinear([lo, hi], [m.l, W - m.r]);
    const bands: [number, number, string][] = [
      [lo, 5, '--cc-bad'],
      [5, 15, '--cc-warn'],
      [15, hi, '--cc-good'],
    ];
    for (const [a, b, c] of bands) {
      svg
        .append('rect')
        .attr('x', x(a))
        .attr('width', x(b) - x(a))
        .attr('y', m.t)
        .attr('height', rowH * 2)
        .attr('fill', this.css(c))
        .attr('opacity', 0.1);
    }
    const binner = d3
      .bin<number, number>()
      .domain([lo, hi])
      .thresholds(d3.range(lo, hi + 0.01, 2.5));
    (['C', 'D'] as const).forEach((who, i) => {
      const vals = margins
        .filter((p) => p.ctrl === who)
        .map((p) => Math.max(lo, Math.min(hi - 0.01, p.margin)));
      const bins = binner(vals);
      const top = m.t + i * rowH;
      const y = d3.scaleLinear([0, d3.max(bins, (b) => b.length) ?? 1], [top + rowH - 8, top + 22]);
      svg
        .append('g')
        .selectAll('rect')
        .data(bins)
        .join('rect')
        .attr('x', (b) => x(b.x0!) + 1)
        .attr('width', (b) => Math.max(0, x(b.x1!) - x(b.x0!) - 2))
        .attr('y', (b) => y(b.length))
        .attr('height', (b) => y(0) - y(b.length))
        .attr('rx', 2)
        .attr('fill', this.ctrlColor(who))
        .on('pointermove', (event: PointerEvent, b) =>
          this.showTip(
            event,
            `<b>${who === 'C' ? 'Canonn' : 'CDSR'} leads by ${b.x0}–${b.x1} pts</b>${this.fmt(b.length)} systems`,
          ),
        )
        .on('pointerleave', () => this.hideTip());
      svg
        .append('text')
        .attr('x', 0)
        .attr('y', top + rowH / 2)
        .attr('class', 'ca-row-label')
        .text(who === 'C' ? 'Canonn' : 'CDSR');
      svg
        .append('text')
        .attr('x', 0)
        .attr('y', top + rowH / 2 + 16)
        .attr('class', 'ca-axis')
        .text(`${this.fmt(vals.length)} systems`);
    });
    svg
      .append('g')
      .attr('transform', `translate(0,${m.t + rowH * 2})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([0, 15, 25, 50, 75, 100])
          .tickFormat((d) => `${d}`),
      )
      .call((g) => g.selectAll('text').attr('class', 'ca-axis'))
      .call((g) => g.selectAll('line,path').attr('stroke', this.css('--cc-rule')));
  }

  // ---- Factions per system --------------------------------------------------------------------
  private drawFactionCounts(): void {
    const ref = this.nfRef();
    const data = this.stats().factionCounts;
    const W = Math.min(this.width() || 600, 640);
    if (!ref) return;
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const H = 240;
    const m = { l: 48, r: 10, t: 22, b: 34 };
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3
      .scaleBand(
        data.map((d) => String(d.factions)),
        [m.l, W - m.r],
      )
      .padding(0.2);
    const y = d3.scaleLinear([0, d3.max(data, (d) => d.systems) ?? 1], [H - m.b, m.t]).nice();
    svg
      .append('g')
      .attr('transform', `translate(${m.l},0)`)
      .call(
        d3
          .axisLeft(y)
          .ticks(4)
          .tickSize(-(W - m.l - m.r)),
      )
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', this.css('--cc-grid')))
      .call((g) => g.selectAll('text').attr('class', 'ca-axis'));
    svg
      .append('g')
      .attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickFormat((d) => `${d}`))
      .call((g) => g.selectAll('text').attr('class', 'ca-axis'))
      .call((g) => g.selectAll('line,path').attr('stroke', this.css('--cc-rule')));
    svg
      .append('g')
      .selectAll('rect')
      .data(data)
      .join('rect')
      .attr('x', (d) => x(String(d.factions))!)
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.systems))
      .attr('height', (d) => y(0) - y(d.systems))
      .attr('rx', 3)
      .attr('fill', (d) => this.css(d.factions <= 3 ? '--cc-good' : '--cc-other'));
    svg
      .append('g')
      .selectAll('text')
      .data(data)
      .join('text')
      .attr('x', (d) => x(String(d.factions))! + x.bandwidth() / 2)
      .attr('y', (d) => y(d.systems) - 5)
      .attr('text-anchor', 'middle')
      .attr('class', 'ca-axis ca-strong')
      .text((d) => this.fmt(d.systems));
    svg
      .append('text')
      .attr('x', W / 2)
      .attr('y', H - 4)
      .attr('text-anchor', 'middle')
      .attr('class', 'ca-axis')
      .text('minor factions in the system');
  }

  // ---- This week ------------------------------------------------------------------------------
  private drawMovers(): void {
    const ref = this.moversRef();
    const all = this.stats().movers;
    const W = Math.min(this.width() || 600, 620);
    if (!ref) return;
    const rows = [
      ...all.slice(0, 7),
      ...all.slice(-7).filter((m) => !all.slice(0, 7).includes(m)),
    ].filter((m) => Math.abs(m.points) >= 0.5);
    rows.sort((a, b) => a.points - b.points);
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const rowH = 24;
    const H = Math.max(60, rows.length * rowH + 24);
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const ext = Math.max(5, d3.max(rows, (r) => Math.abs(r.points)) ?? 5) * 1.15;
    const x = d3.scaleLinear([-ext, ext], [10, W - 10]);
    svg
      .append('line')
      .attr('x1', x(0))
      .attr('x2', x(0))
      .attr('y1', 0)
      .attr('y2', H - 20)
      .attr('stroke', this.css('--cc-rule'));
    const g = svg
      .selectAll('g.ca-mv')
      .data(rows)
      .join('g')
      .attr('class', 'ca-mv')
      .attr('transform', (_d, i) => `translate(0,${i * rowH})`);
    g.append('rect')
      .attr('x', (d) => Math.min(x(0), x(d.points)))
      .attr('width', (d) => Math.abs(x(d.points) - x(0)))
      .attr('y', 4)
      .attr('height', 15)
      .attr('rx', 3)
      .attr('fill', (d) => this.ctrlColor(d.us))
      .attr('opacity', (d) => (d.points < 0 ? 0.6 : 1));
    g.append('text')
      .attr('x', (d) => (d.points < 0 ? x(0) + 6 : x(0) - 6))
      .attr('y', 16)
      .attr('text-anchor', (d) => (d.points < 0 ? 'start' : 'end'))
      .attr('class', 'ca-label')
      .text((d) => (d.name.length > 26 ? d.name.slice(0, 25) + '…' : d.name));
    g.append('text')
      .attr('x', (d) => (d.points < 0 ? x(d.points) - 4 : x(d.points) + 4))
      .attr('y', 16)
      .attr('text-anchor', (d) => (d.points < 0 ? 'end' : 'start'))
      .attr('class', 'ca-label ca-strong')
      .text((d) => `${d.points > 0 ? '+' : ''}${d.points.toFixed(1)}`);
    g.on('pointermove', (event: PointerEvent, d) =>
      this.showTip(
        event,
        `<b>${escapeHtml(d.name)}</b>${d.points > 0 ? '+' : ''}${d.points.toFixed(2)} pts in 7 days · run by ${escapeHtml(d.controller ?? '—')}`,
      ),
    ).on('pointerleave', () => this.hideTip());
    svg
      .append('text')
      .attr('x', 10)
      .attr('y', H - 4)
      .attr('class', 'ca-axis')
      .text('← fell');
    svg
      .append('text')
      .attr('x', W - 10)
      .attr('y', H - 4)
      .attr('text-anchor', 'end')
      .attr('class', 'ca-axis')
      .text('rose →');
  }

  private drawSparks(): void {
    const ref = this.sparksRef();
    const sparks = this.stats().sparks;
    if (!ref) return;
    const box = d3.select(ref.nativeElement);
    box.selectAll('*').remove();
    for (const s of sparks) {
      const cell = box.append('div').attr('class', 'ca-spark');
      cell.append('div').attr('class', 'ca-spark-name').attr('title', s.name).text(s.name);
      const svg = cell.append('svg').attr('viewBox', '0 0 160 50');
      const v = s.values;
      const x = d3.scaleLinear([0, v.length - 1], [2, 124]);
      const y = d3.scaleLinear([(d3.min(v) ?? 0) - 1, (d3.max(v) ?? 1) + 1], [46, 6]);
      const c = this.ctrlColor(s.us);
      svg
        .append('path')
        .attr(
          'd',
          d3
            .area<number>()
            .x((_d, i) => x(i))
            .y0(48)
            .y1((d) => y(d))(v)!,
        )
        .attr('fill', c)
        .attr('opacity', 0.15);
      svg
        .append('path')
        .attr(
          'd',
          d3
            .line<number>()
            .x((_d, i) => x(i))
            .y((d) => y(d))(v)!,
        )
        .attr('fill', 'none')
        .attr('stroke', c)
        .attr('stroke-width', 2);
      svg
        .append('circle')
        .attr('cx', x(v.length - 1))
        .attr('cy', y(v[v.length - 1]))
        .attr('r', 3)
        .attr('fill', c);
      svg
        .append('text')
        .attr('x', 130)
        .attr('y', y(v[v.length - 1]) + 4)
        .attr('class', 'ca-label ca-strong')
        .text(`${Math.round(v[v.length - 1])}%`);
      svg
        .append('title')
        .text(
          `${s.name} · ${v.length} readings, ${d3.min(v)!.toFixed(1)}–${d3.max(v)!.toFixed(1)}%`,
        );
    }
  }

  // ---- Map ------------------------------------------------------------------------------------
  protected setMapView(v: MapView): void {
    this.mapView.set(v);
  }

  protected setMapFilter(f: MapFilter): void {
    this.mapFilter.set(f);
  }

  private drawMap(): void {
    const ref = this.mapRef();
    const s = this.stats();
    const view = this.mapView();
    const filter = this.mapFilter();
    this.width();
    if (!ref) return;
    const canvas = ref.nativeElement;
    const W = canvas.clientWidth || 900;
    const H = Math.round(Math.min(W * (view === 'near' ? 0.62 : 0.7), 720));
    const [ctx] = this.setupCanvas(canvas, H);
    ctx.fillStyle = this.css('--cc-panel');
    ctx.fillRect(0, 0, W, H);
    const V = s.varati ?? { x: -178.65625, y: 77.125, z: -87.125 };
    let x0: number, x1: number, z0: number, z1: number;
    if (view === 'near') {
      const R = 400;
      const asp = W / H;
      x0 = V.x - R * Math.max(1, asp);
      x1 = V.x + R * Math.max(1, asp);
      z0 = V.z - R / Math.min(1, asp);
      z1 = V.z + R / Math.min(1, asp);
    } else {
      const xs = s.systems.map((p) => p.x);
      const zs = s.systems.map((p) => p.z);
      x0 = (d3.min(xs) ?? 0) - 500;
      x1 = (d3.max(xs) ?? 0) + 500;
      z0 = (d3.min(zs) ?? 0) - 500;
      z1 = (d3.max(zs) ?? 0) + 500;
      const k = Math.max((x1 - x0) / W, (z1 - z0) / H);
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      x0 = cx - (k * W) / 2;
      x1 = cx + (k * W) / 2;
      z0 = cz - (k * H) / 2;
      z1 = cz + (k * H) / 2;
    }
    const px = (x: number) => ((x - x0) / (x1 - x0)) * W;
    const pz = (z: number) => H - ((z - z0) / (z1 - z0)) * H;
    ctx.font = `11px ${this.css('--cc-f-mono') || 'monospace'}`;
    ctx.strokeStyle = this.css('--cc-rule');
    ctx.fillStyle = this.css('--cc-ink-3');
    if (view === 'near') {
      for (const r of [100, 250]) {
        const rr = (r / (x1 - x0)) * W;
        ctx.beginPath();
        ctx.arc(px(V.x), pz(V.z), rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${r} ly`, px(V.x) + rr * 0.71 + 4, pz(V.z) - rr * 0.71 - 4);
      }
    } else {
      ctx.fillText('↑ towards the galactic core', 10, 18);
    }
    const reconSet = new Set(s.recon.map((r) => r.name));
    const list = s.systems.filter((p) =>
      filter === 'all'
        ? true
        : filter === 'pref'
          ? p.pref === 'C'
          : filter === 'recon'
            ? reconSet.has(p.name)
            : p.weekChange !== null && Math.abs(p.weekChange) >= 3,
    );
    const big = filter !== 'all';
    this.mapPts = [];
    for (const g of ['O', 'D', 'C'] as const) {
      ctx.fillStyle = this.ctrlColor(g);
      ctx.globalAlpha = g === 'O' ? 0.5 : 0.92;
      for (const p of list) {
        if (p.ctrl !== g) continue;
        const X = px(p.x);
        const Y = pz(p.z);
        if (X < -5 || X > W + 5 || Y < -5 || Y > H + 5) continue;
        ctx.beginPath();
        ctx.arc(X, Y, big ? 3.4 : view === 'near' ? 2.1 : 1.8, 0, Math.PI * 2);
        ctx.fill();
        this.mapPts.push({ x: X, y: Y, s: p });
      }
    }
    ctx.globalAlpha = 1;
    if (filter === 'move') {
      ctx.lineWidth = 1.5;
      for (const p of this.mapPts) {
        ctx.strokeStyle = this.css((p.s.weekChange ?? 0) < 0 ? '--cc-bad' : '--cc-good');
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const label = (text: string, X: number, Y: number) => {
      ctx.strokeStyle = this.css('--cc-ink');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X, Y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `600 12px ${this.css('--cc-f-body') || 'sans-serif'}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = this.css('--cc-panel');
      ctx.strokeText(text, X + 10, Y + 4);
      ctx.fillStyle = this.css('--cc-ink');
      ctx.fillText(text, X + 10, Y + 4);
    };
    label('Varati', px(V.x), pz(V.z));
    if (view === 'all') {
      const far = s.systems.find((p) => p.name === 'Canonnia');
      if (far) label('Canonnia', px(far.x), pz(far.z));
    }
  }

  protected onMapMove(event: PointerEvent): void {
    const r = (event.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = event.clientX - r.left;
    const my = event.clientY - r.top;
    let best: (typeof this.mapPts)[number] | null = null;
    let bd = 49;
    for (const p of this.mapPts) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) return this.hideTip();
    const s = best.s;
    const ctrl = s.ctrl === 'C' ? 'Canonn' : s.ctrl === 'D' ? 'CDSR' : 'another faction';
    const parts = [
      `Run by ${ctrl} · ${PREF_LABEL[s.pref].toLowerCase()}`,
      `${this.fmt(Math.round(s.fromVarati))} ly from Varati`,
      s.canonnInfluence !== null ? `Canonn ${s.canonnInfluence.toFixed(1)}%` : '',
      s.cdsrInfluence !== null ? `CDSR ${s.cdsrInfluence.toFixed(1)}%` : '',
      s.weekChange !== null && Math.abs(s.weekChange) >= 0.5
        ? `7-day change ${s.weekChange > 0 ? '+' : ''}${s.weekChange.toFixed(1)} pts`
        : '',
    ].filter(Boolean);
    this.showTip(event, `<b>${escapeHtml(s.name)}</b>${parts.join('<br>')}`);
  }

  // ---- Horizontal bars (neighbours, powers) ---------------------------------------------------
  private drawHBars(
    ref: ElementRef<SVGSVGElement> | undefined,
    rows: readonly (readonly [string, number])[],
    colorVar: string,
  ): void {
    const W = Math.min(this.width() || 600, 620);
    if (!ref) return;
    const svg = d3.select(ref.nativeElement);
    svg.selectAll('*').remove();
    const rowH = 24;
    const left = Math.min(220, W * 0.46);
    const H = rows.length * rowH + 6;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r[1]) ?? 1], [left, W - 48]);
    const g = svg
      .selectAll('g')
      .data(rows)
      .join('g')
      .attr('transform', (_d, i) => `translate(0,${i * rowH})`);
    g.append('text')
      .attr('x', left - 8)
      .attr('y', 16)
      .attr('text-anchor', 'end')
      .attr('class', 'ca-label')
      .text((d) => (d[0].length > 30 ? d[0].slice(0, 29) + '…' : d[0]));
    g.append('rect')
      .attr('x', left)
      .attr('y', 5)
      .attr('height', 14)
      .attr('rx', 3)
      .attr('width', (d) => Math.max(1, x(d[1]) - left))
      .attr('fill', this.css(colorVar));
    g.append('text')
      .attr('x', (d) => x(d[1]) + 6)
      .attr('y', 16)
      .attr('class', 'ca-label ca-strong')
      .text((d) => this.fmt(d[1]));
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c as '&' | '<' | '>' | '"'],
  );
}
