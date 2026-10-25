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
  /** The tabs left to right, in a fixed order. */
  protected readonly tabOrder: readonly TabId[] = TAB_PARAMS;
  protected readonly selectedIndex = signal(0);
  private readonly currentTab = computed(() => this.tabOrder[this.selectedIndex()]);

  constructor() {
    // A shared link's `tab` param opens that tab.
    const wanted = new URLSearchParams(window.location.search).get('tab');
    const index = TAB_PARAMS.findIndex(t => t === wanted);
    if (index > 0) {
      this.selectedIndex.set(index);
    }
  }

  protected selectTab(index: number): void {
    this.selectedIndex.set(index);
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
