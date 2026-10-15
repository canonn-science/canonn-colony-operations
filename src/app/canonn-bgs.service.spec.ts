import { TestBed } from '@angular/core/testing';
import { CanonnBgsService, SYSTEMS_MAX_AGE_MS } from './canonn-bgs.service';
import { ArchitectSubmission, AFFILIATION_NOT_A_COLONY } from './data/architect-form';
import { logger } from './data/logger';
import { BgsConfig } from './data/priority';

const QUERY_BASE = 'https://us-central1-canonn-api-236217.cloudfunctions.net/query';
const SYSTEMS_URL = `${QUERY_BASE}/bgs/systems?view=all&slim=1`;

/** The constants the API sends along with the list. */
const CONFIG: BgsConfig = {
  tracked_names: ['Canonn', 'Canonn Deep Space Research'],
  thresholds: {
    low_influence: 0.05,
    close_gap: 0.02,
    trend_flat_per_day: 0.002,
    trend_steep_per_day: 0.01,
    trend_horizon_days: 30,
    trend_warn_days: 7,
  },
  needs_recon_hours: 48,
  placeholders: ['', '-', 'n/a', 'na', 'none', 'nobody', "don't know"],
  priority: {
    tiers: [
      { tier: 'P0', min: 85 },
      { tier: 'P1', min: 65 },
      { tier: 'P2', min: 40 },
      { tier: 'P3', min: 20 },
    ],
    history_adj_min: -10,
    history_adj_max: 20,
    score_ceiling: 99,
    gap_score_cap: 80,
    gap_score_floor: 5,
    guard_warn_pct: 3,
    guard_critical_pct: 1,
    guard_warn_days: 14,
    guard_critical_days: 7,
  },
};

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: () => Promise.resolve(body),
  } as Response;
}

interface FakeApi {
  /** The systems the list endpoint holds. */
  records: unknown[];
  /** Extra top-level fields of the list response, or fields to leave out (undefined). */
  envelope: Record<string, unknown>;
}

/** A stand-in for the Cloud Function: the whole-list endpoint over `api.records`, and nothing else. */
function fakeFetch(api: FakeApi): (url: string) => Promise<Response> {
  return (url: string) => {
    if (url === SYSTEMS_URL) {
      const body = {
        data: api.records,
        total: api.records.length,
        generated_at: '2026-10-14T09:30:12.123456',
        config: CONFIG,
        ...api.envelope,
      };
      return Promise.resolve(textResponse(JSON.stringify(body)));
    }
    return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
  };
}

function systemRecord(name: string, extra: Record<string, unknown> = {}) {
  return { name, controlling_faction: null, x: 0, y: 0, z: 0, minor_faction_presences: [], ...extra };
}

interface FactionPresenceFixture {
  name: string;
  influence: number;
  active_states?: unknown[];
  pending_states?: unknown[];
  recovering_states?: unknown[];
  allegiance?: string | null;
  government?: string | null;
}

function systemWithPresences(name: string, presences: FactionPresenceFixture[], extra: Record<string, unknown> = {}) {
  return systemRecord(name, { minor_faction_presences: presences, ...extra });
}

describe('CanonnBgsService loading the whole list', () => {
  let service: CanonnBgsService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: FakeApi;

  beforeEach(() => {
    localStorage.clear();
    api = {
      records: Array.from({ length: 250 }, (_unused, i) => systemRecord(`System ${i}`)),
      envelope: {},
    };
    fetchMock = vi.fn(fakeFetch(api));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function listRequests(): string[] {
    return fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith(`${QUERY_BASE}/bgs/systems`));
  }

  it('gets every system in one request, asking for the whole list without the history fields', async () => {
    const snapshot = await service.getSystems();

    expect(snapshot.rows).toHaveLength(250);
    expect(snapshot.rows[0].systemName).toBe('System 0');
    expect(snapshot.generatedAt).toBe('2026-10-14T09:30:12.123456');
    expect(snapshot.config).toEqual(CONFIG);
    expect(listRequests()).toEqual([SYSTEMS_URL]);
  });

  it('needs nothing but that one request: the architects and watchlist come with the systems', async () => {
    await service.getSystems();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([SYSTEMS_URL]);
  });

  it('serves the list from memory once it has it', async () => {
    const first = await service.getSystems();
    const second = await service.getSystems();

    expect(second).toBe(first);
    expect(listRequests()).toHaveLength(1);
  });

  describe('how long a loaded list is kept', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is capped at ten minutes', () => {
      expect(SYSTEMS_MAX_AGE_MS).toBe(10 * 60 * 1000);
    });

    it('serves the loaded list until it is ten minutes old, then fetches a fresh one', async () => {
      const first = await service.getSystems();

      vi.advanceTimersByTime(SYSTEMS_MAX_AGE_MS - 1000);
      expect(await service.getSystems()).toBe(first);
      expect(listRequests()).toHaveLength(1);

      vi.advanceTimersByTime(2000);
      const second = await service.getSystems();
      expect(second).not.toBe(first);
      expect(listRequests()).toHaveLength(2);
    });

    it('shares one request between callers that ask while it is on its way', async () => {
      const [a, b] = await Promise.all([service.getSystems(), service.getSystems()]);

      expect(a).toBe(b);
      expect(listRequests()).toHaveLength(1);
    });

    it('does not keep a failed refresh: the next call asks again rather than serving the old list as fresh', async () => {
      await service.getSystems();
      vi.advanceTimersByTime(SYSTEMS_MAX_AGE_MS + 1000);
      fetchMock.mockImplementationOnce(() => Promise.resolve(textResponse('gone', 404)));

      await expect(service.getSystems()).rejects.toThrow();
      await expect(service.getSystems()).resolves.toBeTruthy();
      expect(listRequests()).toHaveLength(3); // the first load, the refresh that failed, the one after it
    });
  });

  it('refuses an API that did not send its configuration, and tries again on the next call', async () => {
    api.envelope = { config: undefined };

    await expect(service.getSystems()).rejects.toThrow(/configuration/);

    api.envelope = {};
    await expect(service.getSystems()).resolves.toBeTruthy();
    expect(listRequests()).toHaveLength(2);
  });

  it('refuses a response that holds only part of the list', async () => {
    api.envelope = { total: 4333 };

    await expect(service.getSystems()).rejects.toThrow(/250 of 4333/);
  });
});

describe('CanonnBgsService record mapping', () => {
  let service: CanonnBgsService;
  let api: FakeApi;

  async function rows() {
    return (await service.getSystems()).rows;
  }

  beforeEach(() => {
    localStorage.clear();
    api = { records: [], envelope: {} };
    vi.stubGlobal('fetch', vi.fn(fakeFetch(api)));
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an active retreat for a single faction, with no second corroborator required', async () => {
    api.records = [
      systemWithPresences('Varati Ring', [
        { name: 'Canonn Deep Space Research', influence: 0.021, active_states: ['Retreat'] },
        { name: 'Other Faction', influence: 0.5 },
      ]),
    ];

    const [row] = await rows();

    expect(row.retreatState).toBe('active');
    expect(row.retreatDetails).toBe('Retreat: Canonn Deep Space Research (2.1%)');
  });

  it("reads the API's {State} / {State, Trend} state entries as state names", async () => {
    api.records = [
      systemWithPresences('Varati Ring', [
        { name: 'Canonn', influence: 0.4, active_states: [{ State: 'War' }], pending_states: [{ State: 'Election', Trend: 0 }] },
        { name: 'Other Faction', influence: 0.4, active_states: [{ State: 'War' }], pending_states: [{ State: 'Election', Trend: 0 }] },
      ]),
    ];

    const [row] = await rows();

    expect(row.warState).toBe('active');
    expect(row.warDetails).toBe('War: Canonn vs Other Faction');
    expect(row.electionState).toBe('pending');
    expect(row.factionDetails[0].activeStates).toEqual(['War']);
  });

  it('does not log an anomaly for an unpaired pending retreat (R9 only applies to two-party states)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const logSpy = vi.spyOn(logger, 'log');
    api.records = [
      systemWithPresences('Varati Ring', [
        { name: 'Canonn Deep Space Research', influence: 0.05, pending_states: [{ State: 'Retreat', Trend: 0 }] },
      ]),
    ];

    const [row] = await rows();
    const anomalyCalls = (calls: unknown[][]) => calls.filter(([message]) => message === 'BGS conflict-state anomaly');

    expect(row.retreatState).toBe('pending');
    expect(anomalyCalls(warnSpy.mock.calls)).toEqual([]);
    expect(anomalyCalls(logSpy.mock.calls)).toEqual([]);
  });

  it('suppresses the retreat icon for a faction in its own home system', async () => {
    api.records = [systemWithPresences('Varati', [{ name: 'Canonn', influence: 0.02, active_states: ['Retreat'] }])];

    const [row] = await rows();

    expect(row.retreatState).toBeNull();
  });

  it('still surfaces a retreat for the same faction away from its home system', async () => {
    api.records = [systemWithPresences('Some Other System', [{ name: 'Canonn', influence: 0.02, active_states: ['Retreat'] }])];

    const [row] = await rows();

    expect(row.retreatState).toBe('active');
  });

  it('maps body_count and population through to the row, defaulting to null when the API omits them', async () => {
    api.records = [
      systemWithPresences('With Data', [], { body_count: 32, population: 26481079 }),
      systemWithPresences('Without Data', []),
    ];

    const [withData, withoutData] = await rows();

    expect(withData.bodyCount).toBe(32);
    expect(withData.population).toBe(26481079);
    expect(withoutData.bodyCount).toBeNull();
    expect(withoutData.population).toBeNull();
  });

  it('maps the controlling faction, coordinates, factions and last-seen time', async () => {
    api.records = [
      systemWithPresences(
        'Varati',
        [
          { name: 'Small Faction', influence: 0.1, allegiance: 'Empire', government: 'Corporate' },
          { name: 'Canonn', influence: 0.9, allegiance: 'Independent', government: 'Cooperative' },
        ],
        { controlling_faction: 'Canonn', x: -167.5, y: 44, z: -58, last_seen: '2026-10-09T00:55:00Z' },
      ),
    ];

    const [row] = await rows();

    expect(row.controllingFaction).toBe('Canonn');
    expect([row.x, row.y, row.z]).toEqual([-167.5, 44, -58]);
    expect(row.updatedAt).toBe('2026-10-09T00:55:00Z');
    expect(row.canonnInfluence).toBeCloseTo(90);
    expect(row.factions.map(f => f.name)).toEqual(['Canonn', 'Small Faction']);
    expect(row.factionDetails[0]).toMatchObject({ allegiance: 'Independent', government: 'Cooperative' });
  });

  it('copes with a system the tracker has no snapshot of (no faction presences)', async () => {
    api.records = [systemRecord('Blind System')];

    const [row] = await rows();

    expect(row.factions).toEqual([]);
    expect(row.canonnInfluence).toBeNull();
    expect(row.warState).toBeNull();
  });

  it('takes the architect and preferred faction from the system record', async () => {
    api.records = [
      systemWithPresences('Colony', [], {
        architect: { architect_name: 'Cmdr Example', canonn_architect: 'Not a Canonn Member', preferred_faction: 'Canonn' },
      }),
    ];

    const [row] = await rows();

    expect(row.architect).toBe('Cmdr Example');
    expect(row.preferredFaction).toBe('Canonn');
    expect(row.preferredFactionRecorded).toBe(true);
    expect(row.notAColony).toBe(false);
  });

  it('reads a "not a colony" answer from the system record', async () => {
    api.records = [
      systemWithPresences('Rock', [], {
        architect: { architect_name: null, canonn_architect: AFFILIATION_NOT_A_COLONY, preferred_faction: null },
      }),
    ];

    const [row] = await rows();

    expect(row.architect).toBeNull();
    expect(row.notAColony).toBe(true);
  });

  it('treats a placeholder architect name as no architect', async () => {
    api.records = [
      systemWithPresences('Colony', [], { architect: { architect_name: 'N/A', canonn_architect: null, preferred_faction: null } }),
    ];

    const [row] = await rows();

    expect(row.architect).toBeNull();
  });

  it('attaches the watchlist entry a system record carries', async () => {
    api.records = [
      systemWithPresences('Watched', [], { bgs_override: { faction: 'Canonn', position: 2, details: 'Keep an eye on it' } }),
      systemWithPresences('Unwatched', [], { bgs_override: null }),
    ];

    const [watched, unwatched] = await rows();

    expect(watched.watchlist).toEqual([
      { systemName: 'Watched', faction: 'Canonn', position: 2, details: 'Keep an eye on it' },
    ]);
    expect(unwatched.watchlist).toEqual([]);
  });
});

describe('CanonnBgsService priority', () => {
  let service: CanonnBgsService;
  let api: FakeApi;

  beforeEach(() => {
    localStorage.clear();
    api = { records: [], envelope: {} };
    vi.stubGlobal('fetch', vi.fn(fakeFetch(api)));
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const presences = [
    { name: 'Canonn', influence: 0.5 },
    { name: 'Rival A', influence: 0.2 },
    { name: 'Rival B', influence: 0.12 },
    { name: 'Rival C', influence: 0.1 },
    { name: 'Rival D', influence: 0.05 },
    { name: 'Rival E', influence: 0.03 },
  ];

  it('scores each system from its own inputs, with the constants the API sent', async () => {
    api.records = [
      systemWithPresences('At War', presences, {
        controlling_faction: 'Canonn',
        architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'Canonn' },
        states: [{ faction: 'Canonn', active: ['War'], pending: [] }],
      }),
      systemWithPresences('Hands Off', presences, {
        controlling_faction: 'Canonn',
        architect: { architect_name: 'Cmdr Example', canonn_architect: null, preferred_faction: 'Rival A' },
      }),
    ];

    const { rows } = await service.getSystems();

    expect(rows[0].priority).toMatchObject({ tier: 'P0', score: 95, mode: 'push', leadFaction: 'Canonn' });
    expect(rows[0].priority.reasons[0]).toEqual({ code: 'war-active', label: 'War active', score: 95 });
    expect(rows[1].priority).toMatchObject({ tier: 'out-of-scope', score: null, mode: 'hands-off' });
  });

  it('scores a system with no snapshot, rather than leaving it blank', async () => {
    api.records = [systemRecord('Blind System')];

    const { rows } = await service.getSystems();

    expect(rows[0].priority.mode).toBe('assumed');
    expect(rows[0].priority.score).toBe(5);
  });

  it('re-scores a system when an architect is assigned to it', async () => {
    api.records = [
      systemWithPresences('Colony', presences, {
        controlling_faction: 'Canonn',
        states: [{ faction: 'Canonn', active: ['War'], pending: [] }],
      }),
    ];
    const before = (await service.getSystems()).rows[0];
    expect(before.priority).toMatchObject({ mode: 'assumed', score: 101 });

    service.recordAssignment({
      systemName: 'Colony',
      architect: 'Cmdr Example',
      affiliation: 'The Architect is a Canonn Member',
      preferredFaction: 'Canonn',
    } as ArchitectSubmission);
    const after = (await service.getSystems()).rows[0];

    expect(after.architect).toBe('Cmdr Example');
    expect(after.priority).toMatchObject({ mode: 'push', score: 95, tier: 'P0' });
  });
});

describe('CanonnBgsService architect registry and recent assignments', () => {
  let service: CanonnBgsService;
  let api: FakeApi;

  const submission = {
    yourName: 'Cmdr Me',
    systemName: 'Colony',
    architect: 'Cmdr Example',
    affiliation: 'The Architect is a Canonn Member',
    preferredFaction: 'Canonn',
  } as ArchitectSubmission;

  /** A second visit: a fresh service over the same storage and the API as it now stands. */
  function reload(): CanonnBgsService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(CanonnBgsService);
  }

  beforeEach(() => {
    localStorage.clear();
    api = {
      records: [
        systemWithPresences('Colony', [], { architect: null }),
        systemWithPresences('Known', [], {
          architect: { architect_name: 'Cmdr Known', canonn_architect: 'Not a Canonn Member', preferred_faction: 'Canonn' },
        }),
        systemWithPresences('Blank', [], { architect: { architect_name: null, canonn_architect: null, preferred_faction: null } }),
      ],
      envelope: {},
    };
    vi.stubGlobal('fetch', vi.fn(fakeFetch(api)));
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanonnBgsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the registry from the systems that have an architect answer on record', async () => {
    const registry = await service.getArchitectRegistry();

    expect(registry).toEqual([
      { systemName: 'Known', architect: 'Cmdr Known', affiliation: 'Not a Canonn Member', preferredFaction: 'Canonn' },
    ]);
  });

  it('adds an assignment to the registry straight away', async () => {
    await service.getSystems();
    service.recordAssignment(submission);

    const registry = await service.getArchitectRegistry();

    expect(registry.map(r => r.systemName)).toEqual(['Known', 'Colony']);
  });

  it('keeps showing an assignment after a reload until the API list has caught up', async () => {
    await service.getSystems();
    service.recordAssignment(submission);

    const next = reload();
    const [colony] = (await next.getSystems()).rows;

    expect(colony.architect).toBe('Cmdr Example');
    expect(colony.priority.mode).toBe('push');
    expect((await next.getArchitectRegistry()).some(r => r.architect === 'Cmdr Example')).toBe(true);
  });

  it('forgets an assignment once the API list shows that architect', async () => {
    await service.getSystems();
    service.recordAssignment(submission);
    api.records[0] = systemWithPresences('Colony', [], {
      architect: { architect_name: 'cmdr example', canonn_architect: null, preferred_faction: 'Canonn' },
    });

    const next = reload();
    await next.getSystems();

    expect(JSON.parse(localStorage.getItem('canonn-bgs:recent-assignments:v1') ?? '[]')).toEqual([]);
  });

  it('forgets an assignment older than two hours', async () => {
    localStorage.setItem(
      'canonn-bgs:recent-assignments:v1',
      JSON.stringify([
        {
          systemName: 'Colony',
          architect: 'Cmdr Example',
          affiliation: '',
          preferredFaction: 'Canonn',
          at: Date.now() - 3 * 60 * 60 * 1000,
        },
      ]),
    );

    const [colony] = (await service.getSystems()).rows;

    expect(colony.architect).toBeNull();
  });

  it('ignores a corrupt entry in storage', async () => {
    localStorage.setItem('canonn-bgs:recent-assignments:v1', '{not json');

    await expect(service.getSystems()).resolves.toBeTruthy();
  });
});
