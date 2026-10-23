import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BgsRow, CANONN_FACTION, CDSR_FACTION } from '../canonn-bgs.service';
import {
  InfluenceChartDialogComponent,
  InfluenceChartDialogData,
} from '../influence-chart-dialog/influence-chart-dialog.component';
import { PriorityStory, StoryRival, buildPriorityStory } from '../data/priority-story';

/** The row whose card to show, and the whole snapshot for the cross-system history. */
export interface PriorityCardDialogData {
  row: BgsRow;
  rows: readonly BgsRow[];
}

/** Drawing space of the sparkline. */
const SPARK_W = 420;
const SPARK_H = 72;

/**
 * The priority card for one system, opened from its Priority pill: why it matters, what helps
 * right now, the path to full control, Powerplay pressure and our history with the factions
 * there. Every section comes from {@link buildPriorityStory}'s rules, so it works on any row.
 */
@Component({
  selector: 'app-priority-card-dialog',
  imports: [MatButtonModule, MatDialogModule],
  templateUrl: './priority-card-dialog.component.html',
  styleUrl: './priority-card-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PriorityCardDialogComponent {
  private readonly data = inject<PriorityCardDialogData>(MAT_DIALOG_DATA);
  private readonly dialog = inject(MatDialog);

  protected readonly row = this.data.row;
  protected readonly story: PriorityStory = buildPriorityStory(this.data.row, this.data.rows);
  protected readonly inara = `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(this.row.systemName)}`;
  protected readonly maxInfluence = Math.max(
    60,
    ...this.row.factions.map((f) => f.influencePercent),
  );

  protected readonly openRival = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly hoverFaction = signal<string | null>(null);
  protected readonly hoverPoint = signal<number | null>(null);

  protected readonly history =
    this.story.us === CDSR_FACTION ? this.row.cdsrHistory : this.row.canonnHistory;
  protected readonly spark = computed(() => {
    const v = this.history;
    if (v.length < 2) return null;
    const lo = Math.min(...v) - 1;
    const hi = Math.max(...v) + 1;
    const x = (i: number) => 6 + (i / (v.length - 1)) * (SPARK_W - 70);
    const y = (n: number) => SPARK_H - 6 - ((n - lo) / (hi - lo)) * (SPARK_H - 16);
    const pts = v.map((n, i) => ({ x: x(i), y: y(n), v: n }));
    const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${pts[0].x},${SPARK_H} ${line} ${pts[pts.length - 1].x},${SPARK_H}`;
    return { pts, line, area, w: SPARK_W, h: SPARK_H };
  });

  protected readonly hoverDetail = computed(() => {
    const name = this.hoverFaction();
    if (!name) return null;
    return this.row.factionDetails.find((f) => f.name === name) ?? null;
  });

  protected colourOf(faction: string): string {
    return faction === CANONN_FACTION
      ? 'var(--pc-canonn)'
      : faction === CDSR_FACTION
        ? 'var(--pc-cdsr)'
        : 'var(--pc-other)';
  }

  protected short(faction: string | null): string {
    return faction === CDSR_FACTION ? 'CDSR' : (faction ?? '—');
  }

  protected inaraFor(system: string): string {
    return `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(system)}`;
  }

  protected pips(n: number): boolean[] {
    return [0, 1, 2, 3].map((i) => i < n);
  }

  protected population(p: number | null): string {
    if (p === null) return '—';
    if (p >= 1e9) return `${(p / 1e9).toFixed(1)}bn`;
    if (p >= 1e6) return `${(p / 1e6).toFixed(1)}m`;
    return p.toLocaleString('en-GB');
  }

  protected toggleRival(r: StoryRival): void {
    this.openRival.update((cur) => (cur === r.faction ? null : r.faction));
  }

  protected onSparkMove(event: PointerEvent): void {
    const s = this.spark();
    if (!s) return;
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * s.w;
    let best = 0;
    s.pts.forEach((p, i) => {
      if (Math.abs(p.x - x) < Math.abs(s.pts[best].x - x)) best = i;
    });
    this.hoverPoint.set(best);
  }

  protected async copyDiscord(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.story.discord);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.copied.set(false);
    }
  }

  protected openHistory(): void {
    const data: InfluenceChartDialogData = {
      systemName: this.row.systemName,
      systemAddress: this.row.systemAddress,
      averages: this.row.influenceAverages,
      highlight: this.story.us,
    };
    this.dialog.open(InfluenceChartDialogComponent, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      maxWidth: 'min(900px, 94vw)',
    });
  }
}
