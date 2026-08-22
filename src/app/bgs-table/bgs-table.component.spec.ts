import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { BgsPage, BgsRow, CanonnBgsService } from '../canonn-bgs.service';
import { BgsTableComponent } from './bgs-table.component';

/** A minimal, fully-populated row — only `systemName` varies between rows in these tests. */
function row(systemName: string): BgsRow {
  return {
    systemName,
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    factions: [],
    warState: null,
    warDetails: null,
    warIsCanonnVsCanonn: false,
    electionState: null,
    electionDetails: null,
    electionIsCanonnVsCanonn: false,
    x: 0,
    y: 0,
    z: 0,
    updatedAt: null,
  };
}

/** Stands in for the real API's own page size — deliberately much bigger than any display page size. */
const SERVER_PAGE_SIZE = 500;
const TOTAL_SYSTEMS = 4106;

function serverPage(page: number): BgsPage {
  const start = page * SERVER_PAGE_SIZE;
  const count = Math.max(0, Math.min(SERVER_PAGE_SIZE, TOTAL_SYSTEMS - start));
  return {
    page,
    rows: Array.from({ length: count }, (_unused, i) => row(`System ${start + i}`)),
    totalCount: TOTAL_SYSTEMS,
    totalPages: Math.max(1, Math.ceil(TOTAL_SYSTEMS / SERVER_PAGE_SIZE)),
  };
}

describe('BgsTableComponent paging against a large API page size (issue #7 follow-up)', () => {
  let fixture: ComponentFixture<BgsTableComponent>;
  let component: BgsTableComponent;
  let service: { getPage: ReturnType<typeof vi.fn>; prefetchPage: ReturnType<typeof vi.fn>; getArchitectRegistry: ReturnType<typeof vi.fn> };

  /** Reaches past `protected`/`private` — these are the component's externally observable state. */
  function pageSize(): number {
    return component['pageSize']();
  }
  function visibleRows(): BgsRow[] {
    return component['visibleRows']();
  }

  beforeEach(async () => {
    service = {
      getPage: vi.fn((page: number) => Promise.resolve(serverPage(page))),
      prefetchPage: vi.fn(),
      getArchitectRegistry: vi.fn().mockResolvedValue([]),
    };

    await TestBed.configureTestingModule({
      imports: [BgsTableComponent],
      providers: [
        { provide: CanonnBgsService, useValue: service },
        { provide: MatDialog, useValue: {} },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BgsTableComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('shows only the default display page size on load, not the whole (500-row) server page', () => {
    expect(pageSize()).toBe(10);
    expect(visibleRows().length).toBe(10);
    expect(visibleRows()[0].systemName).toBe('System 0');
    expect(service.getPage).toHaveBeenCalledTimes(1);
    expect(service.getPage).toHaveBeenCalledWith(0);
  });

  it('switches to a larger display page size using only what was already downloaded', async () => {
    service.getPage.mockClear();

    component['setPageSize'](100);
    await fixture.whenStable();

    expect(pageSize()).toBe(100);
    expect(visibleRows().length).toBe(100);
    // The first server page already had 500 rows buffered — no fetch was needed for this.
    expect(service.getPage).not.toHaveBeenCalled();
  });

  it('fetches another server page only once paging forward runs past what is buffered', async () => {
    component['setPageSize'](100);
    await fixture.whenStable();
    service.getPage.mockClear();

    // Display pages of 100 rows fit 5 to a 500-row server page — pages 2-5 stay within it.
    for (let i = 0; i < 4; i++) {
      component['nextPage']();
      await fixture.whenStable();
    }
    expect(service.getPage).not.toHaveBeenCalled();
    expect(visibleRows().length).toBe(100);
    expect(visibleRows()[0].systemName).toBe('System 400');

    // The 6th display page (rows 500-600) needs the second server page.
    component['nextPage']();
    await fixture.whenStable();

    expect(service.getPage).toHaveBeenCalledWith(1);
    expect(visibleRows().length).toBe(100);
    expect(visibleRows()[0].systemName).toBe('System 500');
  });

  it('does not fetch the same server page twice when a page-size change races the initial load', async () => {
    service.getPage.mockClear();

    // The constructor's own initial buffering fires (and reaches the service) synchronously;
    // racing a page-size change immediately after, before that first fetch resolves, must not
    // capture the same server page index and issue a second request for it.
    const freshFixture = TestBed.createComponent(BgsTableComponent);
    const freshComponent = freshFixture.componentInstance;
    freshComponent['setPageSize'](100);
    await freshFixture.whenStable();

    const pageZeroCalls = service.getPage.mock.calls.filter(([page]) => page === 0).length;
    expect(pageZeroCalls).toBe(1);
    expect(freshComponent['visibleRows']().length).toBe(100);
    expect(freshComponent['visibleRows']()[0].systemName).toBe('System 0');
  });
});
