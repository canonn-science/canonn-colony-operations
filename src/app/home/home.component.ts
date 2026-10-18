import { ChangeDetectionStrategy, Component, OnDestroy, computed, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { faCheck, faLink } from '@fortawesome/free-solid-svg-icons';
import { BgsTableComponent } from '../bgs-table/bgs-table.component';
import { CanonnLogoComponent } from '../canonn-logo/canonn-logo.component';
import { ColonyCensusComponent } from '../colony-census/colony-census.component';

/** The tabs in display order; a shared link's `tab` query param names one (Priorities is the default and carries none). */
const TAB_PARAMS = ['priorities', 'architects', 'factions'] as const;
type TabId = (typeof TAB_PARAMS)[number];

const TAB_LABELS: Record<TabId, string> = { priorities: 'Priorities', architects: 'Architects', factions: 'Factions' };

/**
 * The landing page: the Canonn logo, title and subtitle (with the share-link button), then a tab
 * bar - Priorities (the main table, the default), Architects and Factions (the two halves of the
 * colony census).
 */
@Component({
  selector: 'app-home',
  imports: [
    MatButtonModule,
    MatTabsModule,
    MatTooltipModule,
    FaIconComponent,
    BgsTableComponent,
    CanonnLogoComponent,
    ColonyCensusComponent,
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnDestroy {
  protected readonly faCheck = faCheck;
  protected readonly faLink = faLink;
  protected readonly loading = signal(true);
  protected readonly linkCopied = signal(false);
  private linkCopiedResetHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly table = viewChild(BgsTableComponent);

  protected readonly tabLabels = TAB_LABELS;
  /** The tabs left to right. The selected tab is always first: picking another moves it to the front and the one just left to the end. */
  protected readonly tabOrder = signal<readonly TabId[]>(TAB_PARAMS);
  private readonly currentTab = computed(() => this.tabOrder()[0]);

  constructor() {
    // A shared link's `tab` param opens that tab, rearranged as if it had been clicked.
    const wanted = new URLSearchParams(window.location.search).get('tab');
    const index = TAB_PARAMS.findIndex(t => t === wanted);
    if (index > 0) {
      this.selectTab(index);
    }
  }

  protected selectTab(index: number): void {
    const order = this.tabOrder();
    if (index <= 0 || index >= order.length) {
      return;
    }
    const [current, picked] = [order[0], order[index]];
    this.tabOrder.set([picked, ...order.filter(t => t !== current && t !== picked), current]);
  }

  ngOnDestroy(): void {
    clearTimeout(this.linkCopiedResetHandle);
  }

  /** Copies a link that reopens the current tab: on Priorities it carries the table's filters and sort, elsewhere just `?tab=`. */
  protected async copyShareLink(): Promise<void> {
    const tab = this.currentTab();
    const query = tab === 'priorities' ? (this.table()?.shareQuery() ?? '') : `tab=${tab}`;
    const url = `${window.location.origin}${window.location.pathname}${query ? '?' + query : ''}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    this.linkCopied.set(true);
    clearTimeout(this.linkCopiedResetHandle);
    this.linkCopiedResetHandle = setTimeout(() => this.linkCopied.set(false), 1500);
  }
}
