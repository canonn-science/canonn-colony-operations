import { ChangeDetectionStrategy, Component, OnDestroy, effect, input, signal, untracked } from '@angular/core';

/** A random integer from `min` to `max`, both included. */
function int(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** One of `items`, at random. */
function pick<T>(items: readonly T[]): T {
  return items[int(0, items.length - 1)];
}

/** `length` random hex digits, for the session ids and addresses a terminal ought to have. */
function hex(length: number): string {
  return Array.from({ length }, () => int(0, 15).toString(16)).join('').toUpperCase();
}

const BANNERS: readonly string[] = [
  'CANONN COLONY OPERATIONS TERMINAL',
  'CANONN BGS DIAGNOSTIC CONSOLE',
  'CANONN DEEP SPACE RESEARCH :: UPLINK',
  'THE CODEX WILL NOW SEE YOU',
  'COLONISATION COMMAND (UNOFFICIAL, UNSANCTIONED)',
  'PILOTS FEDERATION BGS BUREAU, ROOM 404',
];

const BOOT_STATUS: readonly string[] = [
  'BGS UPLINK ........ STANDING BY',
  'BGS UPLINK ........ WARMING UP',
  'BGS UPLINK ........ PROBABLY FINE',
  'BGS UPLINK ........ NEGOTIATING',
  'BGS UPLINK ........ AWAITING TICK',
];

/** What the terminal prints before anything else, so it never opens blank. Different on every load. */
function bootLines(): string[] {
  return [pick(BANNERS), `SESSION ${hex(4)}-${hex(4)} // ${pick(BOOT_STATUS)}`, ''];
}

/**
 * Filler for the stretches where the real work is just waiting on the network. Deliberately
 * silly: none of it describes what the page is actually doing (the real steps come in through
 * {@link LoadingTerminalComponent.realLines}).
 */
export const SILLY_LINES: readonly string[] = [
  'Reticulating minor faction splines...',
  'Asking Pranav Antal to please stop undermining things...',
  'Polishing the influence bars. They were getting dull.',
  'Calibrating the tick-o-meter (it runs five minutes late, as ever)...',
  'Counting stations. Fleet carriers do not count. We are not animals.',
  'Convincing Canonn and CDSR to stop fighting each other. Failed. Retrying...',
  'Defragmenting the galaxy map... 0%... 0%... 0%...',
  'Waking the cloud function. It was napping.',
  'Feeding the EDDN firehose into a very small cup...',
  'Checking whether anyone has flown through your system lately. Nobody has.',
  'Asking the architect registry who built that, and why there...',
  'Rounding scores half-to-even, as nature intended...',
  'Sorting thousands of systems by priority (and vibes)...',
  'Translating influence into feelings...',
  'Looking for the retreat button. Hiding it from Varati.',
  'Dusting off the Thargoid hearts. Nothing to see here.',
  'Warming up the hamster that powers the colonisation queue...',
  'Reminding the server that "slim" means slim.',
  'Waiting on the cloud. It is a very large cloud.',
  'Politely asking the tick to hurry up. It is ignoring us.',
  'Untangling the supply chain. Somebody sent 4,000 tonnes of biowaste to a Coriolis.',
  'Checking the small print on the colonisation contract...',
  'Teaching the server what a "faction" is. Slowly.',
  'Making sure nobody has turned Varati into a Fleet Carrier parking lot...',
  'Aligning the Guardian obelisks. They keep humming.',
  'Rebooting the Codex. Has anyone tried turning the galaxy off and on again?',
  'Counting influence. It was 42% a moment ago. Now it is 41.9%. Math is hard.',
  'Applying Occam\'s razor to the faction state machine. It bit back.',
  'Whispering sweet nothings to the minor faction database...',
  'Consulting the Thargoid oracle. It said "bzzzzzt".',
  'Removing the Thargoid from the data centre. Again.',
  'Checking that nobody expanded into Colonia while we were not looking...',
  'Politely declining to explain how a Mining Frigate got in here...',
  'Spinning up the BGS flux capacitor. 1.21 gigajoules of influence...',
  'Asking the Mission Board for a refund on the last seven ticks...',
  'Tightening the loose bolts on a Type-9. It will not help the BGS.',
];

/** Lines assembled from parts, with fresh numbers and names each time they are drawn. */
const SYSTEM_NAMES: readonly string[] = [
  'Varati',
  'Canonnia',
  'Col 285 Sector',
  'Synuefe',
  'Bei Dou Sector',
  'HIP 18601',
  'Qucerere',
  'Lagoon Sector',
  'Pegasi Sector',
  'Colonia',
  'Sol (just to see)',
];
const COMMODITIES: readonly string[] = [
  'Biowaste',
  'Steel',
  'Water',
  'Liquid Oxygen',
  'Superconductors',
  'Fruit and Vegetables',
  'Progenitor Cells',
  'Titanium',
];
const BEINGS: readonly string[] = [
  'the Federal administrator',
  'a very senior bartender',
  'the local data broker',
  'an unusually chatty pilot',
  'Salvation\'s second-in-command',
  'the Thargoid in accounts',
];
const NOUNS: readonly string[] = [
  'the influence gradient',
  'the faction rota',
  'the colonisation queue',
  'the retreat probability',
  'the architect lookup',
  'the expansion timetable',
];
const TASKS: readonly string[] = [
  'a very tall stack of spreadsheets',
  'the priority sort',
  'the war/election detector',
  'checking every station',
  'the influence calculator',
];

const GENERATORS: readonly (() => string)[] = [
  () => `Interrogating ${pick(SYSTEM_NAMES)}... ${int(2, 9)} factions found, ${int(0, 3)} of them suspicious.`,
  () => `Bribing ${pick(BEINGS)} with ${int(2, 900)} tonnes of ${pick(COMMODITIES)}...`,
  () => `Hyperspace jump charging... ${int(1, 99)}%... ${int(1, 99)}%... ${int(1, 99)}%...`,
  () => `Allocating ${int(2, 4000)} hamsters to ${pick(TASKS)}...`,
  () => `Recalculating ${pick(NOUNS)} (attempt ${int(2, 97)})...`,
  () => `Scanning 0x${hex(6)}... nothing. Scanning 0x${hex(6)}... also nothing.`,
  () => `Latency to ${pick(SYSTEM_NAMES)}: ${int(3, 740)} ms. Mostly vibes.`,
  () => `Asking ${pick(BEINGS)} about ${pick(NOUNS)}. Response: "${pick(['no comment', 'ask later', 'it depends', 'mmm', 'bzzzzzt', 'o7'])}".`,
];

/** How many generated lines are mixed into each load's pool, alongside the whole static list. */
const GENERATED_PER_LOAD = 10;

/** A fresh, shuffled pool of filler for one load: every static line, and some newly generated ones. */
export function fillerPool(): string[] {
  const generated = Array.from({ length: GENERATED_PER_LOAD }, () => pick(GENERATORS)());
  return shuffled([...SILLY_LINES, ...generated]);
}

/** How many lines the terminal keeps on screen; older ones scroll away. */
const MAX_LINES = 14;
/** The pause before the next filler line, in ms, picked at random so it doesn't tick like a clock. */
const MIN_DELAY_MS = 700;
const MAX_DELAY_MS = 1700;

/** A shuffled copy of `items` (Fisher–Yates). */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * A fake green-screen terminal (in the app's orange) shown while the system list loads. Real
 * progress lines passed in through {@link realLines} appear as they arrive; between them it
 * prints silly filler so the wait doesn't look stuck. Purely decorative: hidden from assistive
 * tech, which is told once that data is loading.
 */
@Component({
  selector: 'app-loading-terminal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="visually-hidden">Loading BGS data…</span>
    <div class="terminal" aria-hidden="true">
      @for (line of lines(); track $index) {
        <div class="terminal-line">{{ line }}</div>
      }
      <div class="terminal-line terminal-prompt">&gt;<span class="terminal-cursor"></span></div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .terminal {
      box-sizing: border-box;
      min-height: 280px;
      padding: 16px 20px;
      border: 1px solid #5a3200;
      border-radius: 6px;
      background:
        repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.28) 0, rgba(0, 0, 0, 0.28) 1px, transparent 1px, transparent 3px),
        #0a0600;
      box-shadow: inset 0 0 40px rgba(255, 153, 0, 0.08);
      color: #ff9900;
      font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9rem;
      line-height: 1.5;
      text-shadow: 0 0 6px rgba(255, 153, 0, 0.55);
      overflow: hidden;
      text-align: left;
    }

    .terminal-line {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      min-height: 1.5em;
    }

    .terminal-cursor {
      display: inline-block;
      width: 0.6em;
      height: 1.05em;
      margin-left: 0.35em;
      vertical-align: text-bottom;
      background: currentColor;
      animation: terminal-blink 1s steps(1) infinite;
    }

    @keyframes terminal-blink {
      50% {
        opacity: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .terminal-cursor {
        animation: none;
      }
    }
  `,
})
export class LoadingTerminalComponent implements OnDestroy {
  /** What the page is really doing, in the order it happened; each new entry is printed once. */
  readonly realLines = input<readonly string[]>([]);

  protected readonly lines = signal<string[]>(bootLines());

  private shownReal = 0;
  private pool: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const real = this.realLines();
      untracked(() => {
        for (; this.shownReal < real.length; this.shownReal++) {
          this.print(`[io] ${real[this.shownReal]}`);
        }
      });
    });
    this.scheduleFiller();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  private print(text: string): void {
    this.lines.update(lines => [...lines, text].slice(-MAX_LINES));
  }

  private scheduleFiller(): void {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    this.timer = setTimeout(() => {
      if (this.pool.length === 0) {
        this.pool = fillerPool();
      }
      this.print(`[..] ${this.pool.pop()}`);
      this.scheduleFiller();
    }, delay);
  }
}
