import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CanonnBgsService } from '../canonn-bgs.service';
import { CensusStats, computeCensusStats } from '../data/census-stats';
import { LoadingTerminalComponent } from '../loading-terminal/loading-terminal.component';

type LoadStatus = 'loading' | 'ready' | 'error';

/** Where the station-family colour comes from in the template; kept here so the template stays declarative. */
const STATION_FAMILY_COLOR: Record<string, string> = {
  Construction: 'var(--cc-s2)',
  Outpost: 'var(--cc-s3)',
  Surface: 'var(--cc-s1)',
  Starport: 'var(--cc-s7)',
  Other: 'var(--cc-s0)',
  Unknown: 'var(--cc-s0)',
};

/**
 * A live-data companion to the static "Canonn Colony Census" and "Canonn Faction Atlas" reports:
 * same visual language (plates, stat tiles, the Saira/IBM Plex type system), but every number
 * here is computed from whatever {@link CanonnBgsService.getSystems} has loaded right now,
 * instead of a one-time snapshot baked into a published page. The full interactive charts
 * (rival network, faction map, population scatter) stay on those pages — linked from the
 * subtitle — since reproducing them live here would duplicate a lot of hand-rolled D3 for no
 * real benefit over a page that's refreshed on request.
 */
@Component({
  selector: 'app-colony-census',
  imports: [RouterLink, LoadingTerminalComponent],
  templateUrl: './colony-census.component.html',
  styleUrl: './colony-census.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColonyCensusComponent implements OnInit {
  private readonly bgsService = inject(CanonnBgsService);

  protected readonly status = signal<LoadStatus>('loading');
  protected readonly errorMessage = signal('');
  protected readonly generatedAt = signal<string | null>(null);
  protected readonly rowCount = signal(0);
  protected readonly stats = signal<CensusStats | null>(null);
  protected readonly loadLog = this.bgsService.loadLog;
  protected readonly stationFamilyColor = STATION_FAMILY_COLOR;

  protected readonly singleSystemArchitects = computed(
    () => this.stats()?.architects.filter(a => a.count === 1).length ?? 0,
  );
  protected readonly topArchitects = computed(() => this.stats()?.architects.slice(0, 15) ?? []);
  protected readonly maxArchitectCount = computed(() => this.stats()?.architects[0]?.count ?? 1);
  protected readonly maxPreferredTotal = computed(() => {
    const preferred = this.stats()?.preferred ?? [];
    return Math.max(1, ...preferred.map(p => p.got + p.miss));
  });
  protected readonly maxStationCount = computed(() => this.stats()?.stations[0]?.count ?? 1);
  protected readonly maxInfluenceBin = computed(() => {
    const bins = this.stats()?.influenceBins ?? [];
    return Math.max(1, ...bins.map(b => b.canonnControls + b.other));
  });
  protected readonly maxFreshnessBin = computed(() => {
    const bins = this.stats()?.freshnessBins ?? [];
    return Math.max(1, ...bins.map(b => b.count));
  });
  protected readonly maxRivalCount = computed(() => this.stats()?.rivals[0]?.leadCount ?? 1);

  /** The three footprint cards' numbers, derived from {@link CensusStats.footprint}. */
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

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.status.set('loading');
    try {
      const snapshot = await this.bgsService.getSystems();
      this.generatedAt.set(snapshot.generatedAt);
      this.rowCount.set(snapshot.rows.length);
      this.stats.set(computeCensusStats(snapshot.rows));
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
}
