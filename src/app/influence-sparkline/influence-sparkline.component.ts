import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Drawing size in px; the points sit inside a margin that leaves room for the end dot. */
const WIDTH = 60;
const HEIGHT = 18;
const MARGIN = 4;

/**
 * A faction's influence over the last few weeks as a tiny line with a dot on the latest value —
 * drawn the way the BGS tracker's dashboard draws its own: the scale always includes zero, so
 * a flat line stays flat and a swing only looks big when it was.
 *
 * Values are oldest first, any unit (the shape is relative). A single value, which is what most
 * systems have until the tracker has watched them for a while, is just the dot at the right.
 */
@Component({
  selector: 'app-influence-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shape(); as s) {
      <svg [attr.width]="width" [attr.height]="height" [attr.viewBox]="'0 0 ' + width + ' ' + height" aria-hidden="true">
        @if (s.points.length > 1) {
          <polyline class="line" [attr.points]="s.line" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        }
        <circle class="dot" [attr.cx]="s.last[0]" [attr.cy]="s.last[1]" r="3" />
      </svg>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      line-height: 0;
    }

    .line {
      stroke: var(--color-accent, #ff9900);
      stroke-width: 1.75;
      opacity: 0.65;
    }

    .dot {
      fill: var(--color-accent, #ff9900);
      stroke: var(--color-surface, #000);
      stroke-width: 1.5;
    }
  `,
})
export class InfluenceSparklineComponent {
  /** The series, oldest first. Nothing is drawn for an empty one. */
  readonly values = input<readonly number[]>([]);

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;

  protected readonly shape = computed(() => {
    const values = this.values();
    if (values.length === 0) {
      return null;
    }
    const max = Math.max(...values, 0.0001);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const innerWidth = WIDTH - 2 * MARGIN;
    const innerHeight = HEIGHT - 2 * MARGIN;
    const points = values.map((value, index) => {
      // One value has no "before": put it at the latest end, where the dot belongs.
      const along = values.length === 1 ? 1 : index / (values.length - 1);
      return [MARGIN + along * innerWidth, MARGIN + (1 - (value - min) / span) * innerHeight] as const;
    });
    return {
      points,
      line: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      last: points[points.length - 1],
    };
  });
}
