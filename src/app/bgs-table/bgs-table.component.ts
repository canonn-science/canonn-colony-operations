import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { faCheck, faChevronLeft, faChevronRight, faCopy, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import {
  BGS_PAGE_SIZE,
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
import { ArchitectSubmission } from '../data/architect-form';
import { architectNames, suggestArchitects } from '../data/architect-registry';
import { distanceLy } from '../data/distance';
import { readYourName } from '../data/your-name';

/**
 * How the table is currently ordered:
 * - 'paged': server-paged, in API order (the default).
 * - 'distance': the user searched a system; sorted by distance from it.
 * - 'column': the user clicked a sortable header; sorted by that column's value.
 */
type Mode = 'paged' | 'distance' | 'column';

/** Columns the user can click a header to sort by. */
type SortColumn = 'canonn' | 'cdsr' | 'controllingFaction' | 'architect' | 'preferredFaction' | 'factionCount';
type SortDirection = 'asc' | 'desc';

/** The Architect quick filter's modes: everyone, systems with no architect, or one named architect. */
type ArchitectFilterMode = 'all' | 'none' | 'name';
/** The Faction quick filter's modes: everyone, only Canonn-affiliated systems, or one named faction. */
type FactionFilterMode = 'all' | 'canonn' | 'name';

/** Page sizes the "Page size" quick filter offers. */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/** A named point in space the Distance column can be measured from. A BgsRow satisfies this too. */
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
    MatSelectModule,
    FaIconComponent,
    CanonnLogoComponent,
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
  /** Both Canonn-affiliated factions — their bars are highlighted orange in the Factions chart. */
  protected readonly canonnFactionNames: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);
  protected readonly encodeURIComponent = encodeURIComponent;
  /** Placeholder rows shown while data is still loading. */
  protected readonly skeletonRows = Array.from({ length: 12 }, (_, i) => i);

  protected readonly pageIndex = signal(0);
  protected readonly loading = signal(true);
  /** The system name last copied to the clipboard, shown as a brief checkmark on its row. */
  protected readonly copiedSystem = signal<string | null>(null);
  private copiedResetHandle: ReturnType<typeof setTimeout> | undefined;
  protected readonly errorMessage = signal<string | null>(null);
  /** Set while fetching every page for a full-dataset sort; null the rest of the time. */
  protected readonly loadProgress = signal<{ loaded: number; total: number } | null>(null);

  protected readonly mode = signal<Mode>('paged');

  // --- paged mode state -----------------------------------------------------------------
  private readonly rows = signal<BgsRow[]>([]);
  private readonly totalCount = signal<number | null>(null);
  private readonly totalPages = signal<number | null>(null);
  /** The first system loaded on startup — the default Distance reference until the user searches one. */
  private readonly defaultAnchor = signal<BgsRow | null>(null);

  // --- 'distance' mode state --------------------------------------------------------------
  /** The searched system rows are now sorted by distance from. */
  private readonly selectedAnchor = signal<AnchorPoint | null>(null);

  // --- 'column' mode state --------------------------------------------------------------
  private readonly sortColumn = signal<SortColumn | null>(null);
  private readonly sortDirection = signal<SortDirection>('asc');

  /** Every system, fetched once needed for a 'distance' or 'column' sort; reused for later re-sorts. */
  private readonly fullDataset = signal<BgsRow[] | null>(null);

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
  protected readonly pageSize = signal<number>(BGS_PAGE_SIZE);
  protected readonly warElectionOnly = signal(false);
  protected readonly architectFilterMode = signal<ArchitectFilterMode>('all');
  private readonly architectFilterName = signal('');
  protected readonly factionFilterMode = signal<FactionFilterMode>('all');
  private readonly factionFilterName = signal('');

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
  /** Every faction name seen so far — grows as more of the dataset is loaded. */
  private readonly knownFactionNames = computed(() => {
    const names = new Set<string>();
    for (const row of this.fullDataset() ?? this.rows()) {
      for (const faction of row.factions) {
        names.add(faction.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  });
  protected readonly factionFilterSuggestions = computed(() =>
    suggestArchitects(this.knownFactionNames(), this.factionFilterQuery()),
  );

  protected readonly filtersActive = computed(
    () => this.warElectionOnly() || this.architectFilterMode() !== 'all' || this.factionFilterMode() !== 'all',
  );

  /**
   * Whether the table is paginating client-side over {@link fullDataset} rather than fetching
   * server-paged results — required by a non-default page size or any quick filter (there's no
   * server-side support for either), and by the existing 'distance'/'column' sort modes. Sticky:
   * once the full dataset has been fetched there's no reason to go back to incremental paging.
   */
  protected readonly usingFullDataset = computed(
    () =>
      this.mode() !== 'paged' ||
      this.filtersActive() ||
      this.pageSize() !== BGS_PAGE_SIZE ||
      this.fullDataset() !== null,
  );

  /** {@link fullDataset}, narrowed by the active quick filters. */
  private readonly filteredDataset = computed<BgsRow[] | null>(() => {
    const full = this.fullDataset();
    if (!full) {
      return null;
    }
    let rows = full;
    if (this.warElectionOnly()) {
      rows = rows.filter(row => row.warState !== null || row.electionState !== null);
    }
    switch (this.architectFilterMode()) {
      case 'none':
        rows = rows.filter(row => row.architect === null);
        break;
      case 'name': {
        const key = this.architectFilterName().toLowerCase();
        rows = rows.filter(row => (row.architect ?? '').toLowerCase() === key);
        break;
      }
    }
    switch (this.factionFilterMode()) {
      case 'canonn':
        rows = rows.filter(row => row.factions.some(faction => this.canonnFactionNames.has(faction.name)));
        break;
      case 'name': {
        const key = this.factionFilterName().toLowerCase();
        rows = rows.filter(row => row.factions.some(faction => faction.name.toLowerCase() === key));
        break;
      }
    }
    return rows;
  });

  private readonly sortedRows = computed<BgsRow[] | null>(() => {
    const base = this.filteredDataset();
    if (!base) {
      return null;
    }
    switch (this.mode()) {
      case 'distance': {
        const anchorPoint = this.selectedAnchor();
        return anchorPoint ? [...base].sort((a, b) => distanceLy(anchorPoint, a) - distanceLy(anchorPoint, b)) : base;
      }
      case 'column': {
        const column = this.sortColumn();
        if (!column) {
          return base;
        }
        const direction = this.sortDirection();
        return [...base].sort((a, b) => compareColumnValues(columnValue(a, column), columnValue(b, column), direction));
      }
      default:
        return base;
    }
  });

  /**
   * The system the Distance column (and its tooltip, and the search box) is currently
   * measured from — always "the first system in the list": the first-ever-loaded system in
   * paged mode, the searched system in distance mode (which may not itself be in the
   * dataset, so the first *row* isn't necessarily 0.00 ly away), and whichever system
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

  /** The rows for the currently-visible page, regardless of mode. */
  protected readonly visibleRows = computed<BgsRow[]>(() => {
    if (this.usingFullDataset()) {
      const sorted = this.sortedRows();
      if (!sorted) {
        return [];
      }
      const size = this.pageSize();
      const start = this.pageIndex() * size;
      return sorted.slice(start, start + size);
    }
    return this.rows();
  });

  protected readonly displayTotalCount = computed(() => {
    if (this.usingFullDataset()) {
      return this.sortedRows()?.length ?? null;
    }
    return this.totalCount();
  });

  protected readonly displayTotalPages = computed(() => {
    if (this.usingFullDataset()) {
      const count = this.sortedRows()?.length;
      const size = this.pageSize();
      return count != null ? Math.max(1, Math.ceil(count / size)) : null;
    }
    return this.totalPages();
  });

  protected readonly hasNextPage = computed(() => {
    const total = this.displayTotalPages();
    return total === null || this.pageIndex() + 1 < total;
  });

  constructor() {
    void this.loadPage(0);
    void this.loadArchitectFilterNames();
    this.architectFilterControl.setValue(readYourName());

    // Keep the search box showing whatever system the Distance column is currently
    // measured from — the first-loaded system, a search result, or the current top row
    // of a column sort — without fighting the user's own in-progress typing (this only
    // reacts to the anchor actually changing, which only happens on a deliberate action).
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

    // A quick filter or a non-default page size needs the full dataset — fetch it the moment
    // one becomes active (sortByColumn/selectAnchorPoint already do the same for sort modes).
    effect(() => {
      if (this.usingFullDataset()) {
        void this.ensureFullDataset();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.suggestionDebounceTimer !== null) {
      clearTimeout(this.suggestionDebounceTimer);
    }
    clearTimeout(this.copiedResetHandle);
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

  protected previousPage(): void {
    if (this.pageIndex() === 0) {
      return;
    }
    if (this.usingFullDataset()) {
      this.pageIndex.update(p => p - 1);
    } else {
      void this.loadPage(this.pageIndex() - 1);
    }
  }

  protected nextPage(): void {
    if (!this.hasNextPage()) {
      return;
    }
    if (this.usingFullDataset()) {
      this.pageIndex.update(p => p + 1);
    } else {
      void this.loadPage(this.pageIndex() + 1);
    }
  }

  protected retry(): void {
    if (this.usingFullDataset()) {
      void this.ensureFullDataset();
    } else {
      void this.loadPage(this.pageIndex());
    }
  }

  protected setPageSize(size: number): void {
    this.pageSize.set(size);
    this.pageIndex.set(0);
  }

  protected toggleWarElection(): void {
    this.warElectionOnly.update(active => !active);
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

  /** Reflects a successful submission in whichever row collections are currently loaded. */
  private applyAssignment(submission: ArchitectSubmission): void {
    const patch = (rows: BgsRow[]): BgsRow[] =>
      rows.map(row => (row.systemName === submission.systemName ? rowWithAssignment(row, submission) : row));
    this.rows.update(patch);
    const full = this.fullDataset();
    if (full) {
      this.fullDataset.set(patch(full));
    }
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

  /** Resolves `name` to coordinates (via the typeahead cache, or a fresh lookup) and re-anchors the table on it. */
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
        this.loading.set(false);
        this.searchError.set(`System "${name}" not found.`);
        return;
      }
      this.typeaheadCache.set(match.name.toLowerCase(), match);
      this.selectAnchorPoint(toAnchorPoint(match));
    } catch {
      this.loading.set(false);
      this.searchError.set(`Unable to search for "${name}". Please try again.`);
    }
  }

  private selectAnchorPoint(point: AnchorPoint): void {
    this.selectedAnchor.set(point);
    this.mode.set('distance');
    this.pageIndex.set(0);
    void this.ensureFullDataset();
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

  /** In-flight full-dataset fetch, so the effect below and a deliberate sort/filter don't race to start a second one. */
  private fullDatasetPromise: Promise<void> | null = null;

  /** Fetches the full dataset once (subsequent re-sorts/filters just reorder or narrow what's already cached). */
  private async ensureFullDataset(): Promise<void> {
    if (this.fullDataset()) {
      return;
    }
    if (this.fullDatasetPromise) {
      return this.fullDatasetPromise;
    }
    this.loading.set(true);
    this.errorMessage.set(null);
    this.fullDatasetPromise = (async () => {
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
        this.fullDatasetPromise = null;
      }
    })();
    return this.fullDatasetPromise;
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
