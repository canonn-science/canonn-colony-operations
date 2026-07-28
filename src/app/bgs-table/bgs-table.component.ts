import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { BGS_PAGE_SIZE, BgsRow, CANONN_FACTION, CanonnBgsService } from '../canonn-bgs.service';
import { CanonnLogoComponent } from '../canonn-logo/canonn-logo.component';
import { distanceLy } from '../data/distance';

/**
 * How the table is currently ordered:
 * - 'paged': server-paged, in API order (the default).
 * - 'distance': the user clicked a system; sorted by distance from it.
 * - 'column': the user clicked a sortable header; sorted by that column's value.
 */
type Mode = 'paged' | 'distance' | 'column';

/** Columns the user can click a header to sort by. */
type SortColumn = 'canonn' | 'cdsr' | 'controllingFaction' | 'architect' | 'preferredFaction' | 'factionCount';
type SortDirection = 'asc' | 'desc';

function columnValue(row: BgsRow, column: SortColumn): string | number | null {
  switch (column) {
    case 'canonn':
      return row.canonnInfluence;
    case 'cdsr':
      return row.cdsrInfluence;
    case 'controllingFaction':
      return row.controllingFaction;
    case 'architect':
      return row.architect;
    case 'preferredFaction':
      return row.preferredFaction;
    case 'factionCount':
      return row.factions.length;
  }
}

/** Sorts a column's values with nulls (no data) always last, regardless of direction. */
function compareColumnValues(a: string | number | null, b: string | number | null, direction: SortDirection): number {
  if (a === null) {
    return b === null ? 0 : 1;
  }
  if (b === null) {
    return -1;
  }
  const cmp = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  return direction === 'asc' ? cmp : -cmp;
}

@Component({
  selector: 'app-bgs-table',
  imports: [DecimalPipe, MatButtonModule, FaIconComponent, CanonnLogoComponent],
  templateUrl: './bgs-table.component.html',
  styleUrl: './bgs-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BgsTableComponent {
  private readonly bgsService = inject(CanonnBgsService);

  protected readonly faChevronLeft = faChevronLeft;
  protected readonly faChevronRight = faChevronRight;
  protected readonly canonnFactionName = CANONN_FACTION;
  /** Placeholder rows shown while data is still loading. */
  protected readonly skeletonRows = Array.from({ length: 12 }, (_, i) => i);

  protected readonly pageIndex = signal(0);
  protected readonly loading = signal(true);
  protected readonly errorMessage = signal<string | null>(null);
  /** Set while fetching every page for a full-dataset sort; null the rest of the time. */
  protected readonly loadProgress = signal<{ loaded: number; total: number } | null>(null);

  protected readonly mode = signal<Mode>('paged');

  // --- paged mode state -----------------------------------------------------------------
  private readonly rows = signal<BgsRow[]>([]);
  private readonly totalCount = signal<number | null>(null);
  private readonly totalPages = signal<number | null>(null);
  /** The first system loaded on startup — the default Distance reference until the user clicks one. */
  private readonly defaultAnchor = signal<BgsRow | null>(null);

  // --- 'distance' mode state --------------------------------------------------------------
  /** The clicked system rows are now sorted by distance from. */
  private readonly selectedAnchor = signal<BgsRow | null>(null);

  // --- 'column' mode state --------------------------------------------------------------
  private readonly sortColumn = signal<SortColumn | null>(null);
  private readonly sortDirection = signal<SortDirection>('asc');

  /** Every system, fetched once needed for a 'distance' or 'column' sort; reused for later re-sorts. */
  private readonly fullDataset = signal<BgsRow[] | null>(null);

  private readonly sortedRows = computed<BgsRow[] | null>(() => {
    const full = this.fullDataset();
    if (!full) {
      return null;
    }
    switch (this.mode()) {
      case 'distance': {
        const anchorPoint = this.selectedAnchor();
        return anchorPoint
          ? [...full].sort((a, b) => distanceLy(anchorPoint, a) - distanceLy(anchorPoint, b))
          : null;
      }
      case 'column': {
        const column = this.sortColumn();
        if (!column) {
          return null;
        }
        const direction = this.sortDirection();
        return [...full].sort((a, b) => compareColumnValues(columnValue(a, column), columnValue(b, column), direction));
      }
      default:
        return null;
    }
  });

  /**
   * The system the Distance column (and its tooltip) is currently measured from — always
   * "the first system in the list": the first-ever-loaded system in paged mode, the clicked
   * system in distance mode, and whichever system currently tops the column sort in column
   * mode (so re-sorting or flipping direction recalculates every Distance value).
   */
  protected readonly anchor = computed<BgsRow | null>(() => {
    switch (this.mode()) {
      case 'distance':
        return this.selectedAnchor();
      case 'column':
        return this.sortedRows()?.[0] ?? null;
      default:
        return this.defaultAnchor();
    }
  });
  protected readonly anchorName = computed(() => this.anchor()?.systemName ?? null);

  /** The rows for the currently-visible page, regardless of mode. */
  protected readonly visibleRows = computed<BgsRow[]>(() => {
    if (this.mode() !== 'paged') {
      const sorted = this.sortedRows();
      if (!sorted) {
        return [];
      }
      const start = this.pageIndex() * BGS_PAGE_SIZE;
      return sorted.slice(start, start + BGS_PAGE_SIZE);
    }
    return this.rows();
  });

  protected readonly displayTotalCount = computed(() => {
    if (this.mode() !== 'paged') {
      return this.sortedRows()?.length ?? null;
    }
    return this.totalCount();
  });

  protected readonly displayTotalPages = computed(() => {
    if (this.mode() !== 'paged') {
      const count = this.sortedRows()?.length;
      return count != null ? Math.max(1, Math.ceil(count / BGS_PAGE_SIZE)) : null;
    }
    return this.totalPages();
  });

  protected readonly hasNextPage = computed(() => {
    const total = this.displayTotalPages();
    return total === null || this.pageIndex() + 1 < total;
  });

  constructor() {
    void this.loadPage(0);
  }

  protected previousPage(): void {
    if (this.pageIndex() === 0) {
      return;
    }
    if (this.mode() !== 'paged') {
      this.pageIndex.update(p => p - 1);
    } else {
      void this.loadPage(this.pageIndex() - 1);
    }
  }

  protected nextPage(): void {
    if (!this.hasNextPage()) {
      return;
    }
    if (this.mode() !== 'paged') {
      this.pageIndex.update(p => p + 1);
    } else {
      void this.loadPage(this.pageIndex() + 1);
    }
  }

  protected retry(): void {
    if (this.mode() !== 'paged') {
      void this.ensureFullDataset();
    } else {
      void this.loadPage(this.pageIndex());
    }
  }

  /** Makes `row` the Distance reference and re-sorts the whole table by distance from it. */
  protected selectAnchor(row: BgsRow): void {
    this.selectedAnchor.set(row);
    this.mode.set('distance');
    this.pageIndex.set(0);
    void this.ensureFullDataset();
  }

  /** Sorts the whole table by the given column — ascending, then descending on a repeat click. */
  protected sortByColumn(column: SortColumn): void {
    if (this.mode() === 'column' && this.sortColumn() === column) {
      this.sortDirection.update(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortColumn.set(column);
      this.sortDirection.set('asc');
      this.mode.set('column');
    }
    this.pageIndex.set(0);
    void this.ensureFullDataset();
  }

  /** '▲'/'▼' for the currently-sorted column's header, null for every other header. */
  protected sortIndicator(column: SortColumn): string | null {
    if (this.mode() !== 'column' || this.sortColumn() !== column) {
      return null;
    }
    return this.sortDirection() === 'asc' ? '▲' : '▼';
  }

  protected distanceTo(row: BgsRow): number | null {
    const from = this.anchor();
    return from ? distanceLy(from, row) : null;
  }

  /** Accessible text equivalent of the Factions mini bar chart, for screen readers. */
  protected factionsSummary(row: BgsRow): string {
    return row.factions.map(f => `${f.name}: ${f.influencePercent.toFixed(1)}%`).join(', ');
  }

  private async loadPage(page: number): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.bgsService.getPage(page);
      this.pageIndex.set(result.page);
      this.rows.set(result.rows);
      this.totalCount.set(result.totalCount);
      this.totalPages.set(result.totalPages);
      this.loading.set(false);

      if (this.defaultAnchor() === null && result.rows.length > 0) {
        this.defaultAnchor.set(result.rows[0]);
      }

      // Pre-fetch the next page in the background so paging forward feels instant.
      if (result.page + 1 < result.totalPages) {
        this.bgsService.prefetchPage(result.page + 1);
      }
    } catch (error) {
      this.loading.set(false);
      this.errorMessage.set(
        error instanceof Error ? `Failed to load BGS data: ${error.message}` : 'Failed to load BGS data.',
      );
    }
  }

  /** Fetches the full dataset once (subsequent re-sorts just reorder what's already cached). */
  private async ensureFullDataset(): Promise<void> {
    if (this.fullDataset()) {
      return;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const all = await this.bgsService.getAllRows((loaded, total) => {
        this.loadProgress.set({ loaded, total });
      });
      this.fullDataset.set(all);
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? `Failed to load full dataset: ${error.message}` : 'Failed to load full dataset.',
      );
    } finally {
      this.loading.set(false);
      this.loadProgress.set(null);
    }
  }
}
