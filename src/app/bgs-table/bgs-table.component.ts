import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import {
  faCheck,
  faChevronLeft,
  faChevronRight,
  faCircleInfo,
  faCopy,
  faDownload,
  faLink,
  faMagnifyingGlass,
} from '@fortawesome/free-solid-svg-icons';
import {
  BgsRow,
  CANONN_FACTION,
  CDSR_FACTION,
  CanonnBgsService,
  TypeaheadSystem,
  rowWithAssignment,
} from '../canonn-bgs.service';
import {
  AssignArchitectDialogComponent,
  AssignArchitectDialogData,
} from '../assign-architect-dialog/assign-architect-dialog.component';
import { CanonnLogoComponent } from '../canonn-logo/canonn-logo.component';
import { InfluenceChangeComponent } from '../influence-change/influence-change.component';
import {
  InfluenceChartDialogComponent,
  InfluenceChartDialogData,
} from '../influence-chart-dialog/influence-chart-dialog.component';
import { InfluenceSparklineComponent } from '../influence-sparkline/influence-sparkline.component';
import { LoadingTerminalComponent } from '../loading-terminal/loading-terminal.component';
import {
  PriorityWatchlistDialogComponent,
  PriorityWatchlistDialogData,
} from '../priority-watchlist-dialog/priority-watchlist-dialog.component';
import { ArchitectSubmission } from '../data/architect-form';
import { architectNames, suggestArchitects } from '../data/architect-registry';
import {
  OrderColumn,
  OrderDirection,
  RowFilters,
  filterRows,
  sortRowsByColumn,
  sortRowsByDistance,
} from '../data/bgs-order';
import { exportRowsToCsv, exportRowsToJson } from '../data/export';
import { FreshnessInfo, computeFreshness } from '../data/freshness';
import { PriorityAssessment, currentPriority } from '../data/priority';
import { readYourName } from '../data/your-name';

/**
 * How the table is currently ordered:
 * - 'column': by a column's value — priority, highest first, until the user clicks another
 *   header (the default).
 * - 'distance': the user searched a system; sorted by distance from it.
 * - 'paged': by name, the order the API sends the systems in. Nothing selects this today; it is
 *   what an ordering with nothing to order by falls back to.
 * The whole list is loaded in one go, so every ordering and quick filter is worked out here.
 */
type Mode = 'paged' | 'distance' | 'column';

/** Columns the user can click a header to sort by. */
type SortColumn = OrderColumn;
type SortDirection = OrderDirection;

/** The Architect quick filter's modes: everyone, systems with no architect, or one named architect. */
type ArchitectFilterMode = 'all' | 'none' | 'name';
/** The Faction quick filter's modes: everyone, only Canonn-affiliated systems, or one named faction. */
type FactionFilterMode = 'all' | 'canonn' | 'name';
/** The Preference quick filter's modes: everyone, either Canonn faction, Canonn only, or CDSR only. */
type PreferenceFilterMode = 'all' | 'any-canonn' | 'canonn' | 'cdsr';

/** The Preference quick filter's options, in display order. */
const PREFERENCE_FILTER_OPTIONS: ReadonlyArray<{ value: PreferenceFilterMode; label: string }> = [
  { value: 'all', label: 'Any' },
  { value: 'any-canonn', label: 'Any Canonn' },
  { value: 'canonn', label: CANONN_FACTION },
  { value: 'cdsr', label: CDSR_FACTION },
];

/** Columns whose first click sorts the largest values first. */
const MOST_FIRST_COLUMNS: ReadonlySet<SortColumn> = new Set<SortColumn>(['priority', 'canonnChange', 'cdsrChange']);

/** Every column that can be named in a shared link's `sort` parameter. */
const SORT_COLUMNS: ReadonlySet<SortColumn> = new Set<SortColumn>([
  'canonn',
  'cdsr',
  'canonnChange',
  'cdsrChange',
  'controllingFaction',
  'architect',
  'preferredFaction',
  'factionCount',
  'freshness',
  'priority',
]);

/** Page sizes the "Page size" quick filter offers. */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/** A named point in space the table can be sorted by distance from. A BgsRow satisfies this too. */
interface AnchorPoint {
  systemName: string;
  x: number;
  y: number;
  z: number;
}

/** The system name the "sort by distance" search box starts with. */
const DEFAULT_SEARCH_SYSTEM = 'Varati';
/** Debounce for typeahead suggestion lookups, in ms. */
const SUGGESTION_DEBOUNCE_MS = 300;
/** Minimum query length before firing a typeahead lookup. */
const SUGGESTION_MIN_LENGTH = 3;

function toAnchorPoint(system: TypeaheadSystem): AnchorPoint {
  return { systemName: system.name, x: system.x, y: system.y, z: system.z };
}

@Component({
  selector: 'app-bgs-table',
  imports: [
    DecimalPipe,
    ReactiveFormsModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatSelectModule,
    MatTooltipModule,
    FaIconComponent,
    CanonnLogoComponent,
    InfluenceChangeComponent,
    InfluenceSparklineComponent,
    LoadingTerminalComponent,
  ],
  templateUrl: './bgs-table.component.html',
  styleUrl: './bgs-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BgsTableComponent implements OnDestroy {
  private readonly bgsService = inject(CanonnBgsService);
  private readonly dialog = inject(MatDialog);

  protected readonly faChevronLeft = faChevronLeft;
  protected readonly faChevronRight = faChevronRight;
  protected readonly faMagnifyingGlass = faMagnifyingGlass;
  protected readonly faCopy = faCopy;
  protected readonly faCheck = faCheck;
  protected readonly faDownload = faDownload;
  protected readonly faLink = faLink;
  protected readonly faCircleInfo = faCircleInfo;
  /** Both Canonn-affiliated factions — their bars are highlighted orange in the Factions chart. */
  protected readonly canonnFactionNames: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);
  protected readonly encodeURIComponent = encodeURIComponent;
  /** What the first load is really doing, for the terminal shown while the list is on its way. */
  protected readonly loadLog = this.bgsService.loadLog;

  /**
   * The clock the Freshness column's pills are computed against. Recomputed once a minute
   * and on window focus — ample given the coarsest displayed unit is a day — so a long-lived
   * tab doesn't show a pill that's silently gone stale itself.
   */
  private readonly now = signal(Date.now());
  private nowTimerHandle: ReturnType<typeof setInterval> | undefined;
  private readonly onWindowFocus = () => {
    this.now.set(Date.now());
    void this.refreshIfStale();
  };

  protected readonly pageIndex = signal(0);
  protected readonly loading = signal(true);
  /** The system name last copied to the clipboard, shown as a brief checkmark on its row. */
  protected readonly copiedSystem = signal<string | null>(null);
  private copiedResetHandle: ReturnType<typeof setTimeout> | undefined;
  /** Briefly true after the share-link button copies a URL, to swap its icon for a checkmark. */
  protected readonly linkCopied = signal(false);
  private linkCopiedResetHandle: ReturnType<typeof setTimeout> | undefined;
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly exportError = signal<string | null>(null);

  protected readonly mode = signal<Mode>('column');

  /** Every system, in the API's (name) order; null until the list has loaded. */
  private readonly allRows = signal<BgsRow[] | null>(null);
  /** The first system, the default reference for the search box until the user searches one. */
  private readonly defaultAnchor = signal<BgsRow | null>(null);

  // --- 'distance' mode state --------------------------------------------------------------
  /** The searched system rows are now sorted by distance from. */
  private readonly selectedAnchor = signal<AnchorPoint | null>(null);

  // --- 'column' mode state --------------------------------------------------------------
  /** Priority, most urgent first, until the user picks another column. */
  private readonly sortColumn = signal<SortColumn | null>('priority');
  private readonly sortDirection = signal<SortDirection>('desc');

  // --- system search box ------------------------------------------------------------------
  protected readonly systemSearchControl = new FormControl(DEFAULT_SEARCH_SYSTEM);
  protected readonly filteredSystems = signal<string[]>([]);
  protected readonly searchError = signal<string | null>(null);
  /** name (lowercase) -> coordinates, from the most recent typeahead responses. */
  private readonly typeaheadCache = new Map<string, TypeaheadSystem>();
  private suggestionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSuggestionQuery: string | null = null;
  private suggestionGeneration = 0;

  // --- quick filters ------------------------------------------------------------------------
  protected readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  /** Rows shown per page until the user picks a different size. */
  protected readonly pageSize = signal<number>(PAGE_SIZE_OPTIONS[0]);
  protected readonly warElectionOnly = signal(false);
  /** FR-5: "needs recon" pairs naturally with the distance sort — stale systems near me. */
  protected readonly needsReconOnly = signal(false);
  /** Only systems with a station that has "canonn" in its name. */
  protected readonly canonnStationOnly = signal(false);
  protected readonly architectFilterMode = signal<ArchitectFilterMode>('all');
  private readonly architectFilterName = signal('');
  protected readonly factionFilterMode = signal<FactionFilterMode>('all');
  private readonly factionFilterName = signal('');
  protected readonly preferenceFilterOptions = PREFERENCE_FILTER_OPTIONS;
  protected readonly preferenceFilterMode = signal<PreferenceFilterMode>('all');

  /** Text boxes for the Architect/Faction quick filters — separate from the *applied* filter, so typing doesn't filter until submitted. */
  protected readonly architectFilterControl = new FormControl('', { nonNullable: true });
  protected readonly factionFilterControl = new FormControl('', { nonNullable: true });
  private readonly architectFilterQuery = signal('');
  private readonly factionFilterQuery = signal('');

  /** Every architect name in the registry, for the Architect quick filter's typeahead. */
  private readonly architectRegistryNames = signal<string[]>([]);
  protected readonly architectFilterSuggestions = computed(() =>
    suggestArchitects(this.architectRegistryNames(), this.architectFilterQuery()),
  );
  /** Every faction name in the list. */
  private readonly knownFactionNames = computed(() => {
    const names = new Set<string>();
    for (const row of this.allRows() ?? []) {
      for (const faction of row.factions) {
        names.add(faction.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  });
  protected readonly factionFilterSuggestions = computed(() =>
    suggestArchitects(this.knownFactionNames(), this.factionFilterQuery()),
  );

  /** The quick filters as {@link filterRows} takes them. A filter that's off is simply absent. */
  private readonly filters = computed<RowFilters>(() => {
    const filters: RowFilters = {};
    if (this.warElectionOnly()) {
      filters.warElection = true;
    }
    if (this.needsReconOnly()) {
      filters.needsRecon = true;
    }
    if (this.canonnStationOnly()) {
      filters.canonnStation = true;
    }
    switch (this.architectFilterMode()) {
      case 'none':
        filters.noArchitect = true;
        break;
      case 'name':
        filters.architect = this.architectFilterName();
        break;
    }
    switch (this.factionFilterMode()) {
      case 'canonn':
        filters.hasFaction = [CANONN_FACTION, CDSR_FACTION];
        break;
      case 'name':
        filters.hasFaction = [this.factionFilterName()];
        break;
    }
    switch (this.preferenceFilterMode()) {
      case 'any-canonn':
        filters.preferredFaction = [CANONN_FACTION, CDSR_FACTION];
        break;
      case 'canonn':
        filters.preferredFaction = [CANONN_FACTION];
        break;
      case 'cdsr':
        filters.preferredFaction = [CDSR_FACTION];
        break;
    }
    return filters;
  });

  /** The list narrowed by the active quick filters. */
  private readonly filteredRows = computed<BgsRow[] | null>(() => {
    const all = this.allRows();
    if (!all) {
      return null;
    }
    const filters = this.filters();
    if (Object.keys(filters).length === 0) {
      return all;
    }
    // The clock only matters to the needs-recon test; reading it otherwise would re-sort every minute.
    return filterRows(all, filters, filters.needsRecon ? this.now() : 0);
  });

  /** {@link filteredRows} in the current order. */
  private readonly sortedRows = computed<BgsRow[] | null>(() => {
    const base = this.filteredRows();
    if (!base) {
      return null;
    }
    switch (this.mode()) {
      case 'distance': {
        const origin = this.selectedAnchor();
        return origin ? sortRowsByDistance(base, origin) : base;
      }
      case 'column': {
        const column = this.sortColumn();
        return column ? sortRowsByColumn(base, column, this.sortDirection()) : base;
      }
      default:
        return base;
    }
  });

  /**
   * The system the search box is currently showing — always "the first system in the list":
   * the first system by default, the searched system in distance mode (which may not itself
   * be a tracked system, so the first *row* isn't necessarily 0 ly away), and whichever system
   * currently tops the column sort in column mode.
   */
  protected readonly anchor = computed<AnchorPoint | null>(() => {
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

  /** The rows for the currently-visible page. */
  protected readonly visibleRows = computed<BgsRow[]>(() => {
    const rows = this.sortedRows();
    if (!rows) {
      return [];
    }
    const size = this.pageSize();
    const start = this.pageIndex() * size;
    return rows.slice(start, start + size);
  });

  protected readonly displayTotalCount = computed(() => this.sortedRows()?.length ?? null);

  protected readonly displayTotalPages = computed(() => {
    const count = this.displayTotalCount();
    return count != null ? Math.max(1, Math.ceil(count / this.pageSize())) : null;
  });

  protected readonly hasNextPage = computed(() => {
    const total = this.displayTotalPages();
    return total !== null && this.pageIndex() + 1 < total;
  });

  constructor() {
    void this.loadSystems();
    void this.loadArchitectFilterNames();
    this.architectFilterControl.setValue(readYourName());
    this.applyFiltersFromUrl();

    this.nowTimerHandle = setInterval(() => {
      this.now.set(Date.now());
      void this.refreshIfStale();
    }, 60_000);
    window.addEventListener('focus', this.onWindowFocus);

    // Keep the search box showing whatever system the table is currently measured from — the
    // first system, a search result, or the current top row of a column sort — without
    // fighting the user's own in-progress typing (this only reacts to the anchor actually
    // changing, which only happens on a deliberate action).
    effect(() => {
      const name = this.anchorName();
      if (name !== null) {
        this.systemSearchControl.setValue(name, { emitEvent: false });
      }
    });

    this.architectFilterControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => this.architectFilterQuery.set(value));
    this.factionFilterControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => this.factionFilterQuery.set(value));
  }

  ngOnDestroy(): void {
    if (this.suggestionDebounceTimer !== null) {
      clearTimeout(this.suggestionDebounceTimer);
    }
    clearTimeout(this.copiedResetHandle);
    clearTimeout(this.linkCopiedResetHandle);
    clearInterval(this.nowTimerHandle);
    window.removeEventListener('focus', this.onWindowFocus);
  }

  /** Loads the whole system list (once; the service remembers it). */
  private async loadSystems(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const snapshot = await this.bgsService.getSystems();
      this.allRows.set(snapshot.rows);
      if (this.defaultAnchor() === null && snapshot.rows.length > 0) {
        this.defaultAnchor.set(snapshot.rows[0]);
      }
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? `Failed to load BGS data: ${error.message}` : 'Failed to load BGS data.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Swaps in a newer list when the service has fetched one: it serves what it holds until that is
   * ten minutes old and fetches again after, so asking is cheap. A failed refresh is ignored —
   * the table keeps showing what it has, and the next tick or focus tries again.
   */
  private async refreshIfStale(): Promise<void> {
    if (this.loading() || this.allRows() === null) {
      return;
    }
    try {
      const snapshot = await this.bgsService.getSystems();
      if (snapshot.rows !== this.allRows()) {
        this.allRows.set(snapshot.rows);
        const pages = this.displayTotalPages();
        if (pages !== null && this.pageIndex() >= pages) {
          this.pageIndex.set(pages - 1);
        }
      }
    } catch {
      // Keep what is on screen.
    }
  }

  /** Copies a system name to the clipboard and shows a brief checkmark in its place. */
  protected async copySystemName(systemName: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(systemName);
    } catch {
      return;
    }
    this.copiedSystem.set(systemName);
    clearTimeout(this.copiedResetHandle);
    this.copiedResetHandle = setTimeout(() => this.copiedSystem.set(null), 1500);
  }

  /** Copies a URL carrying every active quick filter and the current sort, and shows a brief checkmark on the button. */
  protected async copyShareLink(): Promise<void> {
    const query = this.buildShareQueryParams().toString();
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

  /** The current quick filters and sort/distance-search state, as query params a loaded page can read back via {@link applyFiltersFromUrl}. A filter/sort left at its default is simply omitted. */
  private buildShareQueryParams(): URLSearchParams {
    const params = new URLSearchParams();

    if (this.pageSize() !== PAGE_SIZE_OPTIONS[0]) {
      params.set('pageSize', String(this.pageSize()));
    }
    if (this.pageIndex() > 0) {
      params.set('page', String(this.pageIndex() + 1));
    }
    if (this.warElectionOnly()) {
      params.set('warElection', '1');
    }
    if (this.needsReconOnly()) {
      params.set('needsRecon', '1');
    }
    if (this.canonnStationOnly()) {
      params.set('canonnStation', '1');
    }
    switch (this.architectFilterMode()) {
      case 'none':
        params.set('architect', 'none');
        break;
      case 'name':
        params.set('architect', this.architectFilterName());
        break;
    }
    switch (this.factionFilterMode()) {
      case 'canonn':
        params.set('faction', 'canonn');
        break;
      case 'name':
        params.set('faction', this.factionFilterName());
        break;
    }
    if (this.preferenceFilterMode() !== 'all') {
      params.set('preference', this.preferenceFilterMode());
    }

    switch (this.mode()) {
      case 'distance': {
        const anchor = this.selectedAnchor();
        if (anchor) {
          params.set('near', anchor.systemName);
        }
        break;
      }
      case 'column': {
        const column = this.sortColumn();
        if (column) {
          params.set('sort', column);
          params.set('dir', this.sortDirection());
        }
        break;
      }
    }

    return params;
  }

  /**
   * Applies the quick filters and sort/distance-search a shared link's query params carry —
   * the inverse of {@link buildShareQueryParams}. Run once at startup; an unrecognised or
   * malformed value is simply ignored, leaving that filter at its default.
   */
  private applyFiltersFromUrl(): void {
    if (!window.location.search) {
      return;
    }
    const params = new URLSearchParams(window.location.search);

    const pageSizeParam = Number(params.get('pageSize'));
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeParam)) {
      this.pageSize.set(pageSizeParam);
    }

    if (params.get('warElection') === '1') {
      this.warElectionOnly.set(true);
    }
    if (params.get('needsRecon') === '1') {
      this.needsReconOnly.set(true);
    }
    if (params.get('canonnStation') === '1') {
      this.canonnStationOnly.set(true);
    }

    const architect = params.get('architect');
    if (architect === 'none') {
      this.architectFilterMode.set('none');
    } else if (architect) {
      this.architectFilterMode.set('name');
      this.architectFilterName.set(architect);
      this.architectFilterControl.setValue(architect, { emitEvent: false });
      this.architectFilterQuery.set(architect);
    }

    const faction = params.get('faction');
    if (faction === 'canonn') {
      this.factionFilterMode.set('canonn');
    } else if (faction) {
      this.factionFilterMode.set('name');
      this.factionFilterName.set(faction);
      this.factionFilterControl.setValue(faction, { emitEvent: false });
      this.factionFilterQuery.set(faction);
    }

    const preference = params.get('preference');
    if (preference === 'any-canonn' || preference === 'canonn' || preference === 'cdsr') {
      this.preferenceFilterMode.set(preference);
    }

    const near = params.get('near');
    const sortColumnParam = params.get('sort');
    if (near) {
      void this.searchBySystemName(near);
    } else if (sortColumnParam && SORT_COLUMNS.has(sortColumnParam as SortColumn)) {
      this.sortColumn.set(sortColumnParam as SortColumn);
      this.sortDirection.set(params.get('dir') === 'desc' ? 'desc' : 'asc');
      this.mode.set('column');
    }

    const page = Number(params.get('page'));
    if (Number.isInteger(page) && page > 1) {
      this.pageIndex.set(page - 1);
    }
  }

  /** Exports every row matching the current quick filters (regardless of page), in the current order, as a JSON file. */
  protected exportJson(): void {
    this.exportRows(rows => exportRowsToJson(rows, this.now()));
  }

  /** Exports the same rows as {@link exportJson}, as a CSV file. */
  protected exportCsv(): void {
    this.exportRows(rows => exportRowsToCsv(rows, this.now()));
  }

  private exportRows(write: (rows: BgsRow[]) => void): void {
    this.exportError.set(null);
    const rows = this.sortedRows();
    if (!rows) {
      this.exportError.set('Failed to load data to export.');
      return;
    }
    try {
      write(rows);
    } catch {
      this.exportError.set('Failed to export data. Please try again.');
    }
  }

  /**
   * Left/right arrow keys page through the table, as the pager's Previous/Next buttons do. Ignored
   * while a dialog is open, while typing or choosing in a field, with modifier keys held, or while
   * the list is still loading.
   */
  @HostListener('window:keydown', ['$event'])
  protected onArrowKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) {
      return;
    }
    if (this.dialog.openDialogs.length > 0 || this.loading()) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement) {
      const inField = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      const inWidget = target.closest('[role="combobox"], [role="listbox"], [role="slider"]') !== null;
      if (inField || inWidget) {
        return;
      }
    }
    event.preventDefault();
    if (event.key === 'ArrowLeft') {
      this.previousPage();
    } else {
      this.nextPage();
    }
  }

  protected previousPage(): void {
    if (this.pageIndex() === 0) {
      return;
    }
    this.pageIndex.update(p => p - 1);
  }

  protected nextPage(): void {
    if (!this.hasNextPage()) {
      return;
    }
    this.pageIndex.update(p => p + 1);
  }

  protected retry(): void {
    void this.loadSystems();
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.pageIndex.set(0);
  }

  protected toggleWarElection(): void {
    this.warElectionOnly.update(active => !active);
    this.pageIndex.set(0);
  }

  protected toggleNeedsRecon(): void {
    this.needsReconOnly.update(active => !active);
    this.pageIndex.set(0);
  }

  protected toggleCanonnStation(): void {
    this.canonnStationOnly.update(active => !active);
    this.pageIndex.set(0);
  }

  protected setArchitectFilterMode(mode: 'all' | 'none'): void {
    this.architectFilterMode.set(mode);
    this.architectFilterName.set('');
    this.pageIndex.set(0);
  }

  protected onArchitectFilterOptionSelected(name: string): void {
    this.architectFilterControl.setValue(name, { emitEvent: false });
    this.architectFilterQuery.set(name);
    this.applyArchitectFilterName();
  }

  protected applyArchitectFilterName(): void {
    const name = this.architectFilterControl.value.trim();
    if (!name) {
      this.setArchitectFilterMode('all');
      return;
    }
    this.architectFilterMode.set('name');
    this.architectFilterName.set(name);
    this.pageIndex.set(0);
  }

  protected setFactionFilterMode(mode: 'all' | 'canonn'): void {
    this.factionFilterMode.set(mode);
    this.factionFilterName.set('');
    this.pageIndex.set(0);
  }

  protected onFactionFilterOptionSelected(name: string): void {
    this.factionFilterControl.setValue(name, { emitEvent: false });
    this.factionFilterQuery.set(name);
    this.applyFactionFilterName();
  }

  protected applyFactionFilterName(): void {
    const name = this.factionFilterControl.value.trim();
    if (!name) {
      this.setFactionFilterMode('all');
      return;
    }
    this.factionFilterMode.set('name');
    this.factionFilterName.set(name);
    this.pageIndex.set(0);
  }

  protected setPreferenceFilterMode(mode: PreferenceFilterMode): void {
    this.preferenceFilterMode.set(mode);
    this.pageIndex.set(0);
  }

  /**
   * Sorts the whole table by the given column, toggling direction on a repeat click. A fresh
   * click defaults to ascending, except where "first click" should read as "most first": Priority
   * (highest first, not the numerically-smallest score) and the influence changes (biggest gain
   * first — a repeat click then brings the biggest losses to the top).
   */
  protected sortByColumn(column: SortColumn): void {
    if (this.mode() === 'column' && this.sortColumn() === column) {
      this.sortDirection.update(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortColumn.set(column);
      this.sortDirection.set(MOST_FIRST_COLUMNS.has(column) ? 'desc' : 'asc');
      this.mode.set('column');
    }
    this.pageIndex.set(0);
  }

  /** '▲'/'▼' for the currently-sorted column's header, null for every other header. */
  protected sortIndicator(column: SortColumn): string | null {
    if (this.mode() !== 'column' || this.sortColumn() !== column) {
      return null;
    }
    return this.sortDirection() === 'asc' ? '▲' : '▼';
  }

  /** The Freshness column's pill contents for a row, recomputed as {@link now} ticks forward. */
  protected freshnessFor(row: BgsRow): FreshnessInfo {
    return computeFreshness(row.updatedAt, this.now());
  }

  /** The Priority column's badge contents for a row, with its recon-age flag recomputed as {@link now} ticks forward (that flag doesn't affect the score itself). */
  protected priorityFor(row: BgsRow): PriorityAssessment {
    return currentPriority(row, this.now());
  }

  /** Hover text for the Priority pill: the reasons list, plus a refresh request when the reading is stale — informational, since staleness doesn't change the score. */
  protected priorityTitle(priority: PriorityAssessment): string {
    if (priority.tier === 'out-of-scope') {
      return 'Do not work the BGS in this system';
    }
    const reasons = priority.reasons.map(r => r.label).join('\n');
    return priority.needsRecon ? `${reasons}\nStale reading — please fly through this system to refresh it.` : reasons;
  }

  /** Accessible text equivalent of the Factions mini bar chart, for screen readers. */
  protected factionsSummary(row: BgsRow): string {
    return row.factions.map(f => `${f.name}: ${f.influencePercent.toFixed(1)}%`).join(', ');
  }

  /** Hover text for the System Name link: the Inara hint plus body count and population. */
  protected systemNameTitle(row: BgsRow): string {
    const bodyCount = row.bodyCount !== null ? row.bodyCount.toLocaleString() : '—';
    const population = row.population !== null ? row.population.toLocaleString() : '—';
    return `View ${row.systemName} on Inara\nBody count: ${bodyCount}\nPopulation: ${population}`;
  }

  /**
   * Opens the Architect Registry dialog for a colony with no architect on file. Anything it
   * submits is folded straight into the loaded rows, so the table updates without a refetch.
   */
  protected openAssignDialog(row: BgsRow): void {
    const data: AssignArchitectDialogData = { row };
    this.dialog
      .open<AssignArchitectDialogComponent, AssignArchitectDialogData, ArchitectSubmission>(
        AssignArchitectDialogComponent,
        { data, autoFocus: 'first-tabbable', restoreFocus: true },
      )
      .afterClosed()
      .subscribe(submission => {
        if (submission) {
          this.applyAssignment(submission);
        }
      });
  }

  /** Opens the influence history chart for a system, from one of its sparklines; `faction` is the line drawn heavier. */
  protected openInfluenceChart(row: BgsRow, faction: string): void {
    const data: InfluenceChartDialogData = {
      systemName: row.systemName,
      systemAddress: row.systemAddress,
      averages: row.influenceAverages,
      highlight: faction,
    };
    this.dialog.open(InfluenceChartDialogComponent, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      maxWidth: 'min(900px, 94vw)',
    });
  }

  /** Hover/aria text for a row's info button. */
  protected infoButtonTitle(row: BgsRow): string {
    return `System Info for ${row.systemName}`;
  }

  /** Opens the system info dialog from the info button next to System Name, on every row. */
  protected openWatchlistDialog(row: BgsRow): void {
    const data: PriorityWatchlistDialogData = { row };
    this.dialog.open(PriorityWatchlistDialogComponent, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      // Wide enough for its faction and station tables, but not stretched across a full-width
      // page, where the rows would be too far from their labels to read.
      maxWidth: 'min(1168px, 90vw)',
    });
  }

  /** Reflects a successful submission in the loaded rows — including re-scoring the system's priority. */
  private applyAssignment(submission: ArchitectSubmission): void {
    this.allRows.update(rows =>
      rows
        ? rows.map(row => (row.systemName === submission.systemName ? rowWithAssignment(row, submission) : row))
        : rows,
    );
  }

  /** Bound to the search input's (input) event; debounces suggestion lookups. */
  protected onSearchInput(): void {
    const value = this.systemSearchControl.value ?? '';
    if (this.suggestionDebounceTimer !== null) {
      clearTimeout(this.suggestionDebounceTimer);
    }
    this.suggestionDebounceTimer = setTimeout(() => {
      this.suggestionDebounceTimer = null;
      void this.runSuggestions(value);
    }, SUGGESTION_DEBOUNCE_MS);
  }

  protected onSystemOptionSelected(name: string): void {
    void this.searchBySystemName(name);
  }

  protected onSystemSearchSubmit(): void {
    const value = (this.systemSearchControl.value ?? '').trim();
    if (value) {
      void this.searchBySystemName(value);
    }
  }

  private async runSuggestions(value: string): Promise<void> {
    if (value === this.lastSuggestionQuery) {
      return;
    }
    this.lastSuggestionQuery = value;
    const generation = ++this.suggestionGeneration;

    if (!value || value.trim().length < SUGGESTION_MIN_LENGTH) {
      this.filteredSystems.set([]);
      return;
    }

    try {
      const response = await this.bgsService.typeahead(value.trim());
      if (generation !== this.suggestionGeneration) {
        return;
      }
      for (const system of response.min_max ?? []) {
        this.typeaheadCache.set(system.name.toLowerCase(), system);
      }
      this.filteredSystems.set(response.values ?? []);
    } catch {
      if (generation === this.suggestionGeneration) {
        this.filteredSystems.set([]);
      }
    }
  }

  /** Resolves `name` to coordinates (via the typeahead cache, or a fresh lookup) and re-sorts the table by distance from it. */
  private async searchBySystemName(name: string): Promise<void> {
    this.searchError.set(null);

    const cached = this.typeaheadCache.get(name.toLowerCase());
    if (cached) {
      this.selectAnchorPoint(toAnchorPoint(cached));
      return;
    }

    this.loading.set(true);
    try {
      const response = await this.bgsService.typeahead(name);
      const match = (response.min_max ?? []).find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!match) {
        this.searchError.set(`System "${name}" not found.`);
        return;
      }
      this.typeaheadCache.set(match.name.toLowerCase(), match);
      this.selectAnchorPoint(toAnchorPoint(match));
    } catch {
      this.searchError.set(`Unable to search for "${name}". Please try again.`);
    } finally {
      this.loading.set(false);
    }
  }

  private selectAnchorPoint(point: AnchorPoint): void {
    this.selectedAnchor.set(point);
    this.mode.set('distance');
    this.pageIndex.set(0);
  }

  /** Loads the architect registry's names once, for the Architect quick filter's typeahead. */
  private async loadArchitectFilterNames(): Promise<void> {
    try {
      this.architectRegistryNames.set(architectNames(await this.bgsService.getArchitectRegistry()));
    } catch {
      // Suggestions are a convenience; the filter's free-text entry still works without them.
    }
  }
}
