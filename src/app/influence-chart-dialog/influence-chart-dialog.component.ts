import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { CanonnBgsService } from '../canonn-bgs.service';
import {
  AverageLine,
  ConflictSpan,
  FactionSeries,
  axisMax,
  axisTicks,
  buildAverages,
  buildConflictSpans,
  buildSeries,
  conflictsAt,
  describeConflict,
  nearestIndex,
  snapshotTimes,
  timeTicks,
  valueAt,
} from '../data/influence-history';

/** The system whose history the dialog charts, and the faction whose sparkline was clicked (drawn heavier). */
export interface InfluenceChartDialogData {
  systemName: string;
  systemAddress: string;
  /** The tracked factions' average influence (0-1 fractions) from the list, for the dashed lines. */
  averages: Record<string, number | null>;
  highlight: string | null;
}

/** Drawing space of the SVG (its viewBox); the element itself scales to the dialog's width. */
const WIDTH = 780;
const HEIGHT = 340;
const MARGIN = { left: 48, right: 20, top: 14, bottom: 32 };
const X_TICKS = 6;

/** Canonn is the site's orange; CDSR a deeper, redder one. Nobody else is allowed an orange. */
const CANONN_COLOUR = 'var(--color-accent)';
const CDSR_COLOUR = '#cc4400';

/** For every other faction — blues, greens, purples, pinks and whites, nothing near orange. Cycled in A-Z order, so a faction keeps its colour. */
const OTHER_COLOURS: readonly string[] = [
  '#4dabf7',
  '#51cf66',
  '#b197fc',
  '#22d3ee',
  '#f06595',
  '#e9ecef',
  '#8ce99a',
  '#748ffc',
];

/** A drag on the plot shorter than this (in drawing units) is a click, not a zoom. */
const MIN_SELECTION = 6;

type Status = 'loading' | 'ready' | 'empty' | 'error';

/** One line on the chart: a faction's history, or its dashed average. */
interface ChartLine {
  /** Unique; the legend toggles by it. */
  key: string;
  label: string;
  colour: string;
  dashed: boolean;
  heavy: boolean;
  visible: boolean;
  /** SVG polyline points; empty when there is just the one reading. */
  path: string;
  /** Each reading, placed. */
  dots: { x: number; y: number }[];
  /** The latest value, as text, for the legend. */
  latest: string;
}

/**
 * A system's influence over time — every faction in it, with Canonn and CDSR in the site's own
 * colours and a dashed line at each tracked faction's long-run average — opened by clicking a
 * sparkline in the table. Drawn as plain SVG so it matches the rest of the page rather than
 * pulling in a charting library; hover (or the arrow keys) reads off every faction at a snapshot.
 */
@Component({
  selector: 'app-influence-chart-dialog',
  imports: [MatButtonModule, MatDialogModule],
  templateUrl: './influence-chart-dialog.component.html',
  styleUrl: './influence-chart-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfluenceChartDialogComponent implements OnInit {
  private readonly bgsService = inject(CanonnBgsService);
  private readonly data = inject<InfluenceChartDialogData>(MAT_DIALOG_DATA);

  protected readonly systemName = this.data.systemName;
  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly plot = {
    left: MARGIN.left,
    right: WIDTH - MARGIN.right,
    top: MARGIN.top,
    bottom: HEIGHT - MARGIN.bottom,
  };

  protected readonly status = signal<Status>('loading');
  protected readonly errorMessage = signal('');
  private readonly series = signal<FactionSeries[]>([]);
  private readonly averages = signal<AverageLine[]>([]);
  private readonly conflicts = signal<ConflictSpan[]>([]);
  /** Lines the user has switched off in the legend, by {@link ChartLine.key}. */
  private readonly hidden = signal<ReadonlySet<string>>(new Set());
  /** The snapshot the pointer or keyboard is on, as an index into {@link times}. */
  protected readonly hoverIndex = signal<number | null>(null);

  /** The zoomed-in time range, or null for the whole history. */
  protected readonly zoom = signal<{ from: number; to: number } | null>(null);
  /** The selection being dragged, as x positions in drawing units. */
  protected readonly selection = signal<{ from: number; to: number } | null>(null);

  private readonly allTimes = computed(() => snapshotTimes(this.series()));
  private readonly dataStart = computed(() => this.allTimes()[0] ?? 0);
  private readonly dataEnd = computed(() => this.allTimes()[this.allTimes().length - 1] ?? 0);
  private readonly start = computed(() => this.zoom()?.from ?? this.dataStart());
  private readonly end = computed(() => this.zoom()?.to ?? this.dataEnd());
  /** The snapshots in view — the places the hover can land. */
  protected readonly times = computed(() => this.allTimes().filter(t => t >= this.start() && t <= this.end()));
  protected readonly max = computed(() => axisMax(this.series(), this.averages()));

  protected readonly yTicks = computed(() => axisTicks(this.max()).map(value => ({ value, y: this.y(value) })));
  protected readonly xTicks = computed(() => {
    const short = this.end() - this.start() < 3 * DAY;
    return timeTicks(this.start(), this.end(), X_TICKS).map(time => ({
      time,
      x: this.x(time),
      label: short ? formatMoment(time) : formatDay(time),
    }));
  });
  /** Each war and election as a shaded band across the plot; open ones run to the end of the history. */
  protected readonly bands = computed(() =>
    this.conflicts().map(c => {
      const x1 = this.x(c.start);
      const x2 = this.x(c.end ?? this.dataEnd());
      return { family: c.family, x: x1, width: Math.max(2, x2 - x1) };
    }),
  );
  protected readonly hasWars = computed(() => this.conflicts().some(c => c.family === 'war'));
  protected readonly hasElections = computed(() => this.conflicts().some(c => c.family === 'election'));
  protected readonly selectionBox = computed(() => {
    const s = this.selection();
    return s ? { x: Math.min(s.from, s.to), width: Math.abs(s.to - s.from) } : null;
  });

  protected readonly lines = computed<ChartLine[]>(() => {
    const hidden = this.hidden();
    const names = this.series().map(s => s.name);
    const others = names.filter(name => !isTracked(name)).sort((a, b) => a.localeCompare(b));
    const colourOf = (name: string): string => {
      if (name === 'Canonn') {
        return CANONN_COLOUR;
      }
      if (isTracked(name)) {
        return CDSR_COLOUR;
      }
      return OTHER_COLOURS[others.indexOf(name) % OTHER_COLOURS.length];
    };
    // Averages run the whole history; the chart's clip path trims them to the zoom.
    const start = this.dataStart();
    const end = this.dataEnd();

    const factionLines = this.series().map<ChartLine>(s => {
      const dots = s.points.map(p => ({ x: this.x(p.time), y: this.y(p.value) }));
      return {
        key: s.name,
        label: s.label,
        colour: colourOf(s.name),
        dashed: false,
        heavy: s.name === this.data.highlight,
        visible: !hidden.has(s.name),
        path: dots.length > 1 ? dots.map(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' ') : '',
        dots,
        latest: `${s.points[s.points.length - 1].value.toFixed(1)}%`,
      };
    });
    const averageLines = this.averages()
      .filter(() => end > start)
      .map<ChartLine>(a => {
        const key = `${a.name}:avg`;
        const y = this.y(a.value);
        return {
          key,
          label: a.label,
          colour: colourOf(a.name),
          dashed: true,
          heavy: false,
          visible: !hidden.has(key),
          path: `${this.x(start)},${y.toFixed(1)} ${this.x(end)},${y.toFixed(1)}`,
          dots: [],
          latest: `${a.value.toFixed(1)}%`,
        };
      });
    return [...factionLines, ...averageLines];
  });

  /** What the tooltip lists at the hovered snapshot: each visible faction, highest first. */
  protected readonly tooltip = computed(() => {
    const index = this.hoverIndex();
    const times = this.times();
    if (index === null || index < 0 || index >= times.length) {
      return null;
    }
    const time = times[index];
    const hidden = this.hidden();
    const x = this.x(time);
    const entries = this.series()
      .filter(s => !hidden.has(s.name))
      .map(s => ({ s, value: valueAt(s, time) }))
      .filter((entry): entry is { s: FactionSeries; value: number } => entry.value !== null)
      .sort((a, b) => b.value - a.value)
      .map(({ s, value }) => ({
        label: s.label,
        colour: this.lines().find(l => l.key === s.name)?.colour ?? 'currentColor',
        value,
      }));
    return {
      when: formatMoment(time),
      conflicts: conflictsAt(this.conflicts(), time).map(describeConflict),
      rows: entries.map(e => ({ label: e.label, colour: e.colour, value: `${e.value.toFixed(1)}%` })),
      dots: entries.map(e => ({ x, y: this.y(e.value), colour: e.colour })),
      x,
      percent: (x / WIDTH) * 100,
    };
  });

  ngOnInit(): void {
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  protected toggle(key: string): void {
    this.hidden.update(current => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  /** Puts the hover on the snapshot nearest the pointer. */
  protected onPointerMove(event: PointerEvent): void {
    const x = this.drawingX(event);
    if (x === null) {
      return;
    }
    const selection = this.selection();
    if (selection) {
      this.selection.set({ from: selection.from, to: x });
      this.hoverIndex.set(null);
      return;
    }
    const index = nearestIndex(this.times(), this.timeAt(x));
    this.hoverIndex.set(index >= 0 ? index : null);
  }

  protected onPointerLeave(): void {
    if (!this.selection()) {
      this.hoverIndex.set(null);
    }
  }

  /** Starts a drag-to-zoom selection (primary button only; the pointer is captured so the drag can leave the chart). */
  protected onPointerDown(event: PointerEvent): void {
    const x = this.drawingX(event);
    if (x === null || event.button !== 0) {
      return;
    }
    (event.currentTarget as SVGGraphicsElement).setPointerCapture(event.pointerId);
    this.selection.set({ from: x, to: x });
  }

  /** Zooms to the dragged selection, if it is wide enough to mean it. */
  protected onPointerUp(): void {
    const box = this.selectionBox();
    this.selection.set(null);
    if (!box || box.width < MIN_SELECTION) {
      return;
    }
    const from = this.timeAt(box.x);
    const to = this.timeAt(box.x + box.width);
    if (to > from) {
      this.zoom.set({ from, to });
      this.hoverIndex.set(null);
    }
  }

  protected onPointerCancel(): void {
    this.selection.set(null);
  }

  protected resetZoom(): void {
    this.zoom.set(null);
    this.hoverIndex.set(null);
  }

  /** Left and right arrows step between snapshots; Escape clears the hover (and, as usual, a second one closes the dialog). */
  protected onKeyDown(event: KeyboardEvent): void {
    const count = this.times().length;
    if (count === 0) {
      return;
    }
    const current = this.hoverIndex();
    if (event.key === 'ArrowRight') {
      this.hoverIndex.set(current === null ? count - 1 : Math.min(count - 1, current + 1));
      event.preventDefault();
    } else if (event.key === 'ArrowLeft') {
      this.hoverIndex.set(current === null ? count - 1 : Math.max(0, current - 1));
      event.preventDefault();
    } else if (event.key === 'Escape' && (current !== null || this.selection() || this.zoom())) {
      if (this.selection()) {
        this.selection.set(null);
      } else if (current !== null) {
        this.hoverIndex.set(null);
      } else {
        this.zoom.set(null);
      }
      event.stopPropagation();
    }
  }

  /** The pointer's x in drawing units, kept inside the plot; null if the SVG has no size. */
  private drawingX(event: PointerEvent): number | null {
    const box = (event.currentTarget as SVGGraphicsElement).getBoundingClientRect();
    if (box.width === 0) {
      return null;
    }
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    return Math.min(WIDTH - MARGIN.right, Math.max(MARGIN.left, x));
  }

  /** The moment at drawing-unit x. */
  private timeAt(x: number): number {
    const fraction = (x - MARGIN.left) / (WIDTH - MARGIN.left - MARGIN.right);
    return this.start() + fraction * (this.end() - this.start());
  }

  private x(time: number): number {
    const span = this.end() - this.start();
    const fraction = span > 0 ? (time - this.start()) / span : 1;
    return MARGIN.left + fraction * (WIDTH - MARGIN.left - MARGIN.right);
  }

  private y(value: number): number {
    return HEIGHT - MARGIN.bottom - (value / this.max()) * (HEIGHT - MARGIN.top - MARGIN.bottom);
  }

  private async load(): Promise<void> {
    this.status.set('loading');
    if (!this.data.systemAddress) {
      this.errorMessage.set('This system has no address to look its history up by.');
      this.status.set('error');
      return;
    }
    try {
      // The bands are an extra: if the conflicts can't be had, the chart still draws without them.
      const conflicts = this.bgsService.getSystemConflicts(this.data.systemAddress).catch(() => []);
      const rows = await this.bgsService.getInfluenceHistory(this.data.systemAddress);
      const series = buildSeries(rows);
      this.conflicts.set(buildConflictSpans(await conflicts));
      this.series.set(series);
      this.averages.set(buildAverages(this.data.averages));
      this.status.set(series.length > 0 ? 'ready' : 'empty');
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not load the history.');
      this.status.set('error');
    }
  }
}

const DAY = 24 * 60 * 60 * 1000;

function isTracked(name: string): boolean {
  return name === 'Canonn' || name === 'Canonn Deep Space Research';
}

function formatDay(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMoment(time: number): string {
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
