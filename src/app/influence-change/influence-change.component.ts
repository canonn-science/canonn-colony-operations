import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { InfluenceChange, describeChange, formatPoints } from '../data/influence-change';

/**
 * The indicator beside a faction's influence percentage: a coloured arrow, the signed change in
 * points and the window it covers (`▲ +2.7 7d`), with the rate and history it rests on in the
 * tooltip. A dash when the tracker hasn't watched the system long enough to say.
 */
@Component({
  selector: 'app-influence-change',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (change(); as c) {
      <span
        class="change"
        [class.change--up]="c.direction === 'up'"
        [class.change--down]="c.direction === 'down'"
        [attr.title]="title()"
      >
        <span aria-hidden="true">{{ arrow() }} {{ points() }} <small>{{ c.window }}</small></span>
        <span class="visually-hidden">Influence change: {{ title() }}</span>
      </span>
    } @else {
      <span class="change change--none" title="Not enough history yet" aria-label="Not enough history yet">&ndash;</span>
    }
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .change {
      font-size: 0.75rem;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      color: var(--color-text-muted, #888);
      cursor: help;
    }

    .change--up {
      color: var(--color-success, #51cf66);
    }

    .change--down {
      color: var(--color-danger, #ff6b6b);
    }

    small {
      font-size: 0.85em;
      opacity: 0.8;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class InfluenceChangeComponent {
  /** The change to show; null when the tracker has too little history. */
  readonly change = input<InfluenceChange | null>(null);

  protected readonly arrow = computed(() => {
    switch (this.change()?.direction) {
      case 'up':
        return '▲';
      case 'down':
        return '▼';
      default:
        return '▶';
    }
  });
  protected readonly points = computed(() => {
    const change = this.change();
    return change ? formatPoints(change.points) : '';
  });
  protected readonly title = computed(() => {
    const change = this.change();
    return change ? describeChange(change) : '';
  });
}
