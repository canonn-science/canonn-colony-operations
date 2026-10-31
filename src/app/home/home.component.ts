import { ChangeDetectionStrategy, Component, OnDestroy, computed, signal, viewChildren } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { faCheck, faLink } from '@fortawesome/free-solid-svg-icons';
import { BgsTableComponent } from '../bgs-table/bgs-table.component';
import { CanonnLogoComponent } from '../canonn-logo/canonn-logo.component';
import { ColonyCensusComponent } from '../colony-census/colony-census.component';
import { ASSIGN_PARAM } from '../data/assign-architect-link';
import { PRIORITY_PARAM } from '../data/priority-link';

/** The tabs in display order; a shared link's `tab` query param names one (Priorities is the default and carries none; All Systems carries `tab=all` along with the table's own params). */
const TAB_PARAMS = ['priorities', 'all', 'architects', 'factions'] as const;
type TabId = (typeof TAB_PARAMS)[number];

const TAB_LABELS: Record<TabId, string> = { priorities: 'Priorities', all: 'All Systems', architects: 'Architects', factions: 'Factions' };

/**
 * The landing page: the Canonn logo, title and subtitle (with the share-link button), then a tab
 * bar - Priorities (the P0 systems, the default), All Systems (the full table), Architects and Factions (the two halves of the
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
  /** The tables opened so far (a tab's content is kept once visited); the current tab's is told apart by its tier. */
  private readonly tables = viewChildren(BgsTableComponent);

  protected readonly tabLabels = TAB_LABELS;
  /** The tabs left to right, in a fixed order. */
  protected readonly tabOrder: readonly TabId[] = TAB_PARAMS;
  protected readonly selectedIndex = signal(0);
  private readonly currentTab = computed(() => this.tabOrder[this.selectedIndex()]);

  constructor() {
    const params = new URLSearchParams(window.location.search);
    // A link naming a system (`priority`, `assign`) always opens All Systems, since the system may not be P0.
    const wanted = params.get(PRIORITY_PARAM) || params.get(ASSIGN_PARAM) ? 'all' : params.get('tab');
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

  /** Copies a link that reopens the current tab: on a table tab it carries the table's filters and sort, elsewhere just `?tab=`. */
  protected async copyShareLink(): Promise<void> {
    const tab = this.currentTab();
    const tier = tab === 'priorities' ? 'P0' : undefined;
    const tableQuery = this.tables().find(t => t.tier() === tier)?.shareQuery() ?? '';
    const query =
      tab === 'priorities' ? tableQuery : tab === 'all' ? ['tab=all', tableQuery].filter(Boolean).join('&') : `tab=${tab}`;
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
