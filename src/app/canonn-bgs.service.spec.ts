import { TestBed } from '@angular/core/testing';
import { BGS_PAGE_SIZE, CanonnBgsService } from './canonn-bgs.service';

const BGS_ENDPOINT = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query/canonnbgs';
const ARCHITECTS_ENDPOINT = `${BGS_ENDPOINT}/architects`;
const TOKEN = 'test-token';
const BGS_PAGE_URL = new RegExp(`^${BGS_ENDPOINT}/${TOKEN}/(\\d+)$`);

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
