import { TestBed } from '@angular/core/testing';
import { BGS_PAGE_SIZE, CanonnBgsService } from './canonn-bgs.service';
import { logger } from './data/logger';

const BGS_ENDPOINT = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query/canonnbgs';
const ARCHITECTS_ENDPOINT = `${BGS_ENDPOINT}/architects`;
const TOKEN = 'test-token';

/** Escapes regex metacharacters so a URL can be matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BGS_PAGE_URL = new RegExp(`^${escapeRegExp(BGS_ENDPOINT)}/${TOKEN}/(\\d+)$`);

/**
 * Stands in for the real Cloud Function, but paging 520 systems 500-at-a-time instead of the
 * 50-at-a-time BGS_PAGE_SIZE assumes — reproducing the API change from issue #7 that broke
 * pagination when it was hardcoded to the old page size.
 */
const REAL_API_PAGE_SIZE = 500;
const TOTAL_SYSTEMS = 520;

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Not Found',
    text: () => Promise.resolve(body),
  } as Response;
}

function systemRecord(name: string) {
  return { name, controlling_minor_faction: null, x: 0, y: 0, z: 0 };
}

function fakeFetch(url: string): Promise<Response> {
  if (url === BGS_ENDPOINT) {
    return Promise.resolve(textResponse(JSON.stringify(TOKEN)));
  }
  if (url.startsWith(`${ARCHITECTS_ENDPOINT}/`)) {
    return Promise.resolve(textResponse('[]'));
  }
  if (url.startsWith('https://docs.google.com/')) {
    return Promise.reject(new Error('sheet unavailable in test'));
  }
  const pageMatch = BGS_PAGE_URL.exec(url);
  if (pageMatch) {
    const page = Number(pageMatch[1]);
    const start = page * REAL_API_PAGE_SIZE;
    if (start >= TOTAL_SYSTEMS) {
      // The real API's actual last page is well before BGS_PAGE_SIZE-based math would stop
      // asking for more — this is the 404 issue #7 reported as a "network error".
      return Promise.resolve(textResponse('Not Found', 404));
    }
    const count = Math.min(REAL_API_PAGE_SIZE, TOTAL_SYSTEMS - start);
    const results = Array.from({ length: count }, (_unused, i) => systemRecord(`System ${start + i}`));
    return Promise.resolve(textResponse(JSON.stringify({ count: TOTAL_SYSTEMS, from: start, results })));
  }
  return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
}

function bgsPageRequestCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter(url => BGS_PAGE_URL.test(url)).length;
}

describe('CanonnBgsService pagination against a differently-sized API page (issue #7)', () => {
  let service: CanonnBgsService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(fakeFetch);
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives totalPages from the API\'s actual page size instead of the hardcoded default', async () => {
    const first = await service.getPage(0);

    expect(first.rows.length).toBe(REAL_API_PAGE_SIZE);
    expect(first.totalPages).toBe(2); // ceil(520 / 500), the true number of pages
    expect(first.totalPages).not.toBe(Math.ceil(TOTAL_SYSTEMS / BGS_PAGE_SIZE)); // the old, wrong answer (11)
  });

  it('fetches every system without requesting pages past the API\'s real last page', async () => {
    const rows = await service.getAllRows();

    expect(rows.length).toBe(TOTAL_SYSTEMS);
    expect(rows[0].systemName).toBe('System 0');
    expect(rows[TOTAL_SYSTEMS - 1].systemName).toBe(`System ${TOTAL_SYSTEMS - 1}`);
    // Only the 2 pages that actually exist (0 and 1) were requested — not the 11 that
    // BGS_PAGE_SIZE-based math would have tried, most of which would 404.
    expect(bgsPageRequestCount(fetchMock)).toBe(2);
  });

  it('keeps using the size discovered from page 0 even when a later page is short', async () => {
    await service.getPage(0);
    const last = await service.getPage(1);

    // Page 1 only has 20 rows (the true last page); that shouldn't be mistaken for the API's
    // per-page size and used to recompute totalPages.
    expect(last.rows.length).toBe(TOTAL_SYSTEMS - REAL_API_PAGE_SIZE);
    expect(last.totalPages).toBe(2);
  });
});

interface FactionPresenceFixture {
  name: string;
  influence: number;
  active_states?: string[];
  pending_states?: string[];
}

function systemWithPresences(
  name: string,
  presences: FactionPresenceFixture[],
  extra: { body_count?: number; population?: number } = {},
) {
  return { name, controlling_minor_faction: null, x: 0, y: 0, z: 0, minor_faction_presences: presences, ...extra };
}

describe('CanonnBgsService state summarisation (retreat, FR-1/FR-2)', () => {
  let service: CanonnBgsService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let records: ReturnType<typeof systemWithPresences>[];

  beforeEach(() => {
    localStorage.clear();
    records = [];
    fetchMock = vi.fn((url: string) => {
      if (url === BGS_ENDPOINT) {
        return Promise.resolve(textResponse(JSON.stringify(TOKEN)));
      }
      if (url.startsWith(`${ARCHITECTS_ENDPOINT}/`)) {
        return Promise.resolve(textResponse('[]'));
      }
      if (url.startsWith('https://docs.google.com/')) {
        return Promise.reject(new Error('sheet unavailable in test'));
      }
      if (BGS_PAGE_URL.test(url)) {
        return Promise.resolve(textResponse(JSON.stringify({ count: records.length, from: 0, results: records })));
      }
      return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an active retreat for a single faction, with no second corroborator required', async () => {
    records = [
      systemWithPresences('Varati Ring', [
        { name: 'Canonn Deep Space Research', influence: 0.021, active_states: ['Retreat'] },
        { name: 'Other Faction', influence: 0.5 },
      ]),
    ];

    const page = await service.getPage(0);

    expect(page.rows[0].retreatState).toBe('active');
    expect(page.rows[0].retreatDetails).toBe('Retreat: Canonn Deep Space Research (2.1%)');
  });

  it('does not log an anomaly for an unpaired pending retreat (R9 only applies to two-party states)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const logSpy = vi.spyOn(logger, 'log');
    records = [
      systemWithPresences('Varati Ring', [
        { name: 'Canonn Deep Space Research', influence: 0.05, pending_states: ['Retreat'] },
      ]),
    ];

    const page = await service.getPage(0);
    const anomalyCalls = (calls: unknown[][]) => calls.filter(([message]) => message === 'BGS conflict-state anomaly');

    expect(page.rows[0].retreatState).toBe('pending');
    expect(anomalyCalls(warnSpy.mock.calls)).toEqual([]);
    expect(anomalyCalls(logSpy.mock.calls)).toEqual([]);
  });

  it('suppresses the retreat icon for a faction in its own home system', async () => {
    records = [
      systemWithPresences('Varati', [{ name: 'Canonn', influence: 0.02, active_states: ['Retreat'] }]),
    ];

    const page = await service.getPage(0);

    expect(page.rows[0].retreatState).toBeNull();
  });

  it('still surfaces a retreat for the same faction away from its home system', async () => {
    records = [
      systemWithPresences('Some Other System', [{ name: 'Canonn', influence: 0.02, active_states: ['Retreat'] }]),
    ];

    const page = await service.getPage(0);

    expect(page.rows[0].retreatState).toBe('active');
  });

  it('maps body_count and population through to the row, defaulting to null when the API omits them', async () => {
    records = [
      systemWithPresences('With Data', [], { body_count: 32, population: 26481079 }),
      systemWithPresences('Without Data', []),
    ];

    const page = await service.getPage(0);

    expect(page.rows[0].bodyCount).toBe(32);
    expect(page.rows[0].population).toBe(26481079);
    expect(page.rows[1].bodyCount).toBeNull();
    expect(page.rows[1].population).toBeNull();
  });
});
