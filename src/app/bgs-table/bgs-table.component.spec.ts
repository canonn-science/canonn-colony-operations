import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { BgsRow, BgsSnapshot, CanonnBgsService } from '../canonn-bgs.service';
import { BgsConfig, NO_PRIORITY } from '../data/priority';
import { InfluenceChartDialogComponent } from '../influence-chart-dialog/influence-chart-dialog.component';
import { BgsTableComponent } from './bgs-table.component';

/** A minimal, fully-populated row — tests override only the fields they care about. */
function row(systemName: string, overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName,
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    canonnHistory: [],
    cdsrHistory: [],
    canonnChange: null,
    cdsrChange: null,
    systemAddress: '',
    influenceAverages: {},
    architect: null,
    notAColony: false,
    preferredFaction: null,
    preferredFactionRecorded: false,
    hasCanonnStation: false,
    factionDetails: [],
    stations: [],
    stationCount: null,
    factions: [],
    warState: null,
    warDetails: null,
    warIsCanonnVsCanonn: false,
    electionState: null,
    electionDetails: null,
    electionIsCanonnVsCanonn: false,
    retreatState: null,
    retreatDetails: null,
    expansionState: null,
    bodyCount: null,
    population: null,
    x: 0,
    y: 0,
    z: 0,
    updatedAt: null,
    watchlist: [],
    priority: NO_PRIORITY,
    powerplay: null,
    ...overrides,
  };
}

const TOTAL_SYSTEMS = 250;

/** `TOTAL_SYSTEMS` systems named `System 000`…, each with a distinct Canonn influence, position and priority score, rising with its number. */
function allSystems(): BgsRow[] {
  return Array.from({ length: TOTAL_SYSTEMS }, (_unused, i) =>
    row(`System ${String(i).padStart(3, '0')}`, {
      canonnInfluence: i,
      x: i,
      priority: { ...NO_PRIORITY, tier: 'P2', score: i },
    }),
  );
}

function snapshot(rows: BgsRow[]): BgsSnapshot {
  return { rows, generatedAt: '2026-10-14T09:30:12', config: {} as BgsConfig };
}

describe('BgsTableComponent over the whole list', () => {
  let fixture: ComponentFixture<BgsTableComponent>;
  let component: BgsTableComponent;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let service: {
    getSystems: ReturnType<typeof vi.fn>;
    getArchitectRegistry: ReturnType<typeof vi.fn>;
    typeahead: ReturnType<typeof vi.fn>;
  };

  /** Reaches past `protected`/`private` — these are the component's externally observable state. */
  function pageSize(): number {
    return component['pageSize']();
  }
  function visibleNames(): string[] {
    return component['visibleRows']().map(r => r.systemName);
  }
  function total(): number | null {
    return component['displayTotalCount']();
  }

  async function createWith(rows: BgsRow[]): Promise<void> {
    service.getSystems.mockReset();
    service.getSystems.mockResolvedValue(snapshot(rows));
    fixture = TestBed.createComponent(BgsTableComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  }

  beforeEach(async () => {
    dialogOpen = vi.fn();
    service = {
      getSystems: vi.fn(),
      getArchitectRegistry: vi.fn().mockResolvedValue([]),
      typeahead: vi.fn().mockResolvedValue({ min_max: [], values: [] }),
    };

    await TestBed.configureTestingModule({
      imports: [BgsTableComponent],
      providers: [
        { provide: CanonnBgsService, useValue: service },
        { provide: MatDialog, useValue: { open: dialogOpen, openDialogs: [] } },
      ],
    }).compileComponents();

    await createWith(allSystems());
  });

  describe('paging', () => {
    it('loads the list once and shows the first display page of it, highest priority first', () => {
      expect(service.getSystems).toHaveBeenCalledTimes(1);
      expect(pageSize()).toBe(10);
      expect(visibleNames()).toEqual(
        Array.from({ length: 10 }, (_unused, i) => `System ${String(TOTAL_SYSTEMS - 1 - i).padStart(3, '0')}`),
      );
      expect(total()).toBe(TOTAL_SYSTEMS);
      expect(component['displayTotalPages']()).toBe(25);
    });

    it('pages forward and back without asking for anything more', () => {
      component['nextPage']();
      component['nextPage']();
      expect(visibleNames()[0]).toBe('System 229');

      component['previousPage']();
      expect(visibleNames()[0]).toBe('System 239');
      expect(service.getSystems).toHaveBeenCalledTimes(1);
    });

    it('changes the page size and goes back to the first page', () => {
      component['nextPage']();

      component['setPageSize'](100);

      expect(component['pageIndex']()).toBe(0);
      expect(visibleNames()).toHaveLength(100);
      expect(component['displayTotalPages']()).toBe(3);
    });

    it('stops at the last page, which holds what is left over', () => {
      component['setPageSize'](100);
      component['nextPage']();
      component['nextPage']();
      component['nextPage']();

      expect(component['pageIndex']()).toBe(2);
      expect(visibleNames()).toHaveLength(50);
      expect(component['hasNextPage']()).toBe(false);
    });
  });

  describe('loading', () => {
    it('shows nothing, and offers a retry, when the list fails to load', async () => {
      service.getSystems.mockReset();
      service.getSystems.mockRejectedValue(new Error('timeout'));
      fixture = TestBed.createComponent(BgsTableComponent);
      component = fixture.componentInstance;
      await fixture.whenStable();

      expect(component['errorMessage']()).toBe('Failed to load BGS data: timeout');
      expect(visibleNames()).toEqual([]);
      expect(component['loading']()).toBe(false);

      service.getSystems.mockResolvedValue(snapshot(allSystems()));
      component['retry']();
      await fixture.whenStable();

      expect(component['errorMessage']()).toBeNull();
      expect(total()).toBe(TOTAL_SYSTEMS);
    });
  });

  describe('sorting a column', () => {
    it('opens sorted by priority, most urgent first, and says so on the header', () => {
      expect(component['mode']()).toBe('column');
      expect(visibleNames()[0]).toBe('System 249');
      expect(component['sortIndicator']('priority')).toBe('▼');
    });

    it('flips the priority order on a click, and back again on the next', () => {
      component['sortByColumn']('priority');
      expect(visibleNames()[0]).toBe('System 000');
      expect(component['sortIndicator']('priority')).toBe('▲');

      component['sortByColumn']('priority');
      expect(visibleNames()[0]).toBe('System 249');
      expect(component['sortIndicator']('priority')).toBe('▼');
    });

    it('goes back to priority, highest first, after another column has been sorted', () => {
      component['sortByColumn']('canonn');
      component['sortByColumn']('priority');

      expect(visibleNames()[0]).toBe('System 249');
    });

    it('sorts any other column ascending on the first click, and flips on the second', () => {
      component['sortByColumn']('canonn');
      expect(visibleNames()[0]).toBe('System 000');

      component['sortByColumn']('canonn');
      expect(visibleNames()[0]).toBe('System 249');
    });

    it('sorts a faction\'s change biggest gain first on the first click, then biggest loss first', () => {
      const change = (points: number) => ({ points, window: '7d' as const, direction: 'up' as const, perDay: null, spanDays: 7 });
      service.getSystems.mockResolvedValue(
        snapshot([
          row('Loser', { canonnChange: change(-4) }),
          row('Winner', { canonnChange: change(6) }),
          row('Steady', { canonnChange: change(0) }),
          row('Unknown'),
        ]),
      );
      void component['loadSystems']();

      return fixture.whenStable().then(() => {
        component['sortByColumn']('canonnChange');
        expect(visibleNames()).toEqual(['Winner', 'Steady', 'Loser', 'Unknown']);
        expect(component['sortIndicator']('canonnChange')).toBe('▼');

        component['sortByColumn']('canonnChange');
        expect(visibleNames()).toEqual(['Loser', 'Steady', 'Winner', 'Unknown']);
        expect(component['sortIndicator']('canonnChange')).toBe('▲');
      });
    });

    it('keeps the change and percentage sorts apart, only one active at a time', () => {
      component['sortByColumn']('canonn');
      expect(component['sortIndicator']('canonn')).toBe('▲');
      expect(component['sortIndicator']('canonnChange')).toBeNull();

      component['sortByColumn']('canonnChange');
      expect(component['sortIndicator']('canonn')).toBeNull();
      expect(component['sortIndicator']('canonnChange')).not.toBeNull();
    });

    it('starts again from the first page', () => {
      component['nextPage']();
      component['nextPage']();

      component['sortByColumn']('canonn');

      expect(component['pageIndex']()).toBe(0);
    });

    it('does not fetch anything: the list it already holds is re-sorted', () => {
      component['sortByColumn']('priority');
      component['sortByColumn']('cdsr');
      component['sortByColumn']('factionCount');

      expect(service.getSystems).toHaveBeenCalledTimes(1);
    });

    it('sorts by priority across every page, not just the visible one', () => {
      component['setPageSize'](100);
      component['nextPage']();

      expect(visibleNames()[0]).toBe('System 149');
      expect(visibleNames()[99]).toBe('System 050');
    });
  });

  describe('quick filters', () => {
    beforeEach(async () => {
      await createWith([
        row('Quiet'),
        row('War', { warState: 'active', architect: 'Cmdr A' }),
        row('Election', { electionState: 'pending' }),
        row('Mine', { architect: 'Cmdr Example', factions: [{ name: 'Canonn', influencePercent: 40 }] }),
        row('Outpost', { hasCanonnStation: true }),
        row('CanonnPref', { preferredFaction: 'Canonn' }),
        row('CdsrPref', { preferredFaction: 'Canonn Deep Space Research' }),
      ]);
    });

    it('narrows to systems in, or about to be in, a war or election, and counts them', () => {
      component['toggleWarElection']();

      expect(visibleNames()).toEqual(['Election', 'War']);
      expect(total()).toBe(2);

      component['toggleWarElection']();
      expect(total()).toBe(7);
    });

    it('narrows to systems with a Canonn-named station', () => {
      component['toggleCanonnStation']();
      expect(visibleNames()).toEqual(['Outpost']);

      component['toggleCanonnStation']();
      expect(total()).toBe(7);
    });

    it('narrows to systems with no architect, or to a named one', () => {
      component['setArchitectFilterMode']('none');
      expect(visibleNames()).toEqual(['CanonnPref', 'CdsrPref', 'Election', 'Outpost', 'Quiet']);

      component['architectFilterControl'].setValue('cmdr example');
      component['applyArchitectFilterName']();
      expect(visibleNames()).toEqual(['Mine']);

      component['setArchitectFilterMode']('all');
      expect(total()).toBe(7);
    });

    it('narrows to systems by preferred faction', () => {
      component['setPreferenceFilterMode']('canonn');
      expect(visibleNames()).toEqual(['CanonnPref']);

      component['setPreferenceFilterMode']('cdsr');
      expect(visibleNames()).toEqual(['CdsrPref']);

      component['setPreferenceFilterMode']('any-canonn');
      expect(visibleNames()).toEqual(['CanonnPref', 'CdsrPref']);

      component['setPreferenceFilterMode']('all');
      expect(total()).toBe(7);
    });

    it('narrows to Canonn-affiliated systems, or to a named faction', () => {
      component['setFactionFilterMode']('canonn');
      expect(visibleNames()).toEqual(['CanonnPref', 'CdsrPref', 'Mine']);

      component['factionFilterControl'].setValue('Nobody Here');
      component['applyFactionFilterName']();
      expect(visibleNames()).toEqual([]);
      expect(total()).toBe(0);
    });

    it('keeps the filter when the sort changes', () => {
      component['toggleWarElection']();
      component['sortByColumn']('architect');
      component['sortByColumn']('architect');

      // War has an architect and Election does not; descending puts the one with a value first.
      expect(visibleNames()).toEqual(['War', 'Election']);
    });

    it('goes back to the first page when a filter changes', async () => {
      await createWith(allSystems());
      component['nextPage']();

      component['toggleNeedsRecon']();

      expect(component['pageIndex']()).toBe(0);
    });

    it('offers the factions of the whole list as suggestions for the faction filter', () => {
      component['factionFilterControl'].setValue('can');

      expect(component['factionFilterSuggestions']()).toEqual(['Canonn']);
    });
  });

  describe('distance', () => {
    it('sorts nearest first from a searched system, without fetching anything', async () => {
      component['typeaheadCache'].set('system 100', { name: 'System 100', x: 100, y: 0, z: 0 });

      component['systemSearchControl'].setValue('System 100');
      component['onSystemSearchSubmit']();
      await fixture.whenStable();

      expect(visibleNames().slice(0, 3)).toEqual(['System 100', 'System 099', 'System 101']);
      expect(component['anchorName']()).toBe('System 100');
      expect(service.getSystems).toHaveBeenCalledTimes(1);
    });

    it('says so when a searched system is not found, and leaves the order alone', async () => {
      component['systemSearchControl'].setValue('Nowhere');
      component['onSystemSearchSubmit']();
      await fixture.whenStable();

      expect(component['searchError']()).toBe('System "Nowhere" not found.');
      expect(component['mode']()).toBe('column');
    });
  });

  describe('keeping the list fresh', () => {
    it('swaps in a newer list the service has fetched, keeping the order and filters', async () => {
      component['setArchitectFilterMode']('none');
      service.getSystems.mockResolvedValue(snapshot([row('Only One', { priority: { ...NO_PRIORITY, score: 50 } })]));

      await component['refreshIfStale']();

      expect(visibleNames()).toEqual(['Only One']);
      expect(total()).toBe(1);
      expect(component['architectFilterMode']()).toBe('none');
    });

    it('steps back to the last page when the new list is shorter than where the user was', async () => {
      component['setPageSize'](10);
      for (let i = 0; i < 20; i++) {
        component['nextPage']();
      }
      service.getSystems.mockResolvedValue(snapshot(allSystems().slice(0, 35)));

      await component['refreshIfStale']();

      expect(component['pageIndex']()).toBe(3);
      expect(visibleNames()).toHaveLength(5);
    });

    it('keeps showing what it has when the refresh fails', async () => {
      service.getSystems.mockRejectedValue(new Error('offline'));

      await component['refreshIfStale']();

      expect(total()).toBe(TOTAL_SYSTEMS);
      expect(component['errorMessage']()).toBeNull();
    });
  });

  describe('influence chart', () => {
    it('opens the history chart of the system, highlighting the faction whose sparkline was clicked', () => {
      const varati = row('Varati', { systemAddress: '3932277478106', influenceAverages: { Canonn: 0.45 } });

      component['openInfluenceChart'](varati, 'Canonn Deep Space Research');

      expect(dialogOpen).toHaveBeenCalledTimes(1);
      const [dialogComponent, config] = dialogOpen.mock.calls[0];
      expect(dialogComponent).toBe(InfluenceChartDialogComponent);
      expect(config.data).toEqual({
        systemName: 'Varati',
        systemAddress: '3932277478106',
        averages: { Canonn: 0.45 },
        highlight: 'Canonn Deep Space Research',
      });
    });
  });

  describe('export', () => {
    it('hands over every row of the current filters and sort, not just the page on screen', () => {
      let exported: BgsRow[] = [];

      component['exportRows'](rows => (exported = rows));

      expect(exported).toHaveLength(TOTAL_SYSTEMS);
      expect(exported[0].systemName).toBe('System 249');
      expect(component['exportError']()).toBeNull();
    });

    it('reports a failure to write the file', () => {
      component['exportRows'](() => {
        throw new Error('disk full');
      });

      expect(component['exportError']()).toBe('Failed to export data. Please try again.');
    });
  });

  describe('share link', () => {
    const originalHref = window.location.href;

    afterEach(() => {
      history.pushState({}, '', originalHref);
    });

    it('copies a URL carrying every active quick filter and the current sort', async () => {
      history.pushState({}, '', '/');
      await createWith([row('Quiet'), row('War', { warState: 'active', architect: 'Cmdr A' })]);

      component['toggleWarElection']();
      component['setPageSize'](50);
      component['sortByColumn']('architect');

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      await component['copyShareLink']();

      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}${window.location.pathname}?pageSize=50&warElection=1&sort=architect&dir=asc`,
      );
      expect(component['linkCopied']()).toBe(true);
    });

    it('omits every quick filter left at its default, keeping only the (always-active) sort', async () => {
      history.pushState({}, '', '/');
      await createWith([row('Quiet')]);

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      await component['copyShareLink']();

      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}${window.location.pathname}?sort=priority&dir=desc`,
      );
    });

    it('restores the quick filters, sort and page from the URL on load', async () => {
      history.pushState(
        {},
        '',
        '/?pageSize=50&warElection=1&architect=Cmdr%20A&preference=canonn&sort=architect&dir=desc&page=2',
      );
      await createWith([
        row('Quiet'),
        row('War', { warState: 'active', architect: 'Cmdr A' }),
        row('Mine', { architect: 'Cmdr A' }),
      ]);

      expect(pageSize()).toBe(50);
      expect(component['warElectionOnly']()).toBe(true);
      expect(component['architectFilterMode']()).toBe('name');
      expect(component['architectFilterControl'].value).toBe('Cmdr A');
      expect(component['preferenceFilterMode']()).toBe('canonn');
      expect(component['sortColumn']()).toBe('architect');
      expect(component['sortDirection']()).toBe('desc');
      expect(component['pageIndex']()).toBe(1);
    });

    it('resolves a `near` link by searching for the named system and sorting by distance', async () => {
      service.typeahead.mockResolvedValue({
        min_max: [{ name: 'Varati Ring', x: 5, y: 0, z: 0 }],
        values: ['Varati Ring'],
      });
      history.pushState({}, '', '/?near=Varati+Ring');
      await createWith([row('Close', { x: 4 }), row('Far', { x: 100 })]);
      await fixture.whenStable();

      expect(component['mode']()).toBe('distance');
      expect(visibleNames()).toEqual(['Close', 'Far']);
    });

    it('ignores an unrecognised sort column rather than throwing', async () => {
      history.pushState({}, '', '/?sort=not-a-real-column');

      await expect(createWith([row('Quiet')])).resolves.not.toThrow();
      expect(component['sortColumn']()).toBe('priority');
    });
  });
});
