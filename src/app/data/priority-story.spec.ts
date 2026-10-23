import { CANONN_FACTION, CDSR_FACTION, BgsRow, ConflictDetail } from '../canonn-bgs.service';
import { AFFILIATION_CANONN_MEMBER } from './architect-form';
import { buildPriorityStory, conflictTypeBetween, ethosOf } from './priority-story';

/** A minimal, fully-populated {@link BgsRow}, with only the fields a test cares about overridden. */
function row(overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName: 'Test System',
    systemAddress: '1',
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    preferredFactionRecorded: false,
    hasCanonnStation: false,
    stationCount: 0,
    factions: [],
    canonnHistory: [],
    cdsrHistory: [],
    influenceAverages: {},
    canonnChange: null,
    cdsrChange: null,
    factionDetails: [],
    stations: [],
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
    priority: {
      tier: 'not-applicable',
      mode: null,
      leadFaction: null,
      score: null,
      reasons: [],
      needsRecon: false,
      reconAgeDays: null,
    },
    powerplay: null,
    ...overrides,
  };
}

const f = (name: string, influencePercent: number) => ({ name, influencePercent });
const d = (name: string, influencePercent: number, government: string) => ({
  name,
  influencePercent,
  government,
  allegiance: 'Independent',
  activeStates: [],
});
const P = (tier: string, leadFaction = CANONN_FACTION) =>
  ({
    tier,
    mode: 'push',
    leadFaction,
    score: 90,
    reasons: [{ code: 'x', label: 'A reason from the API', score: 90 }],
    needsRecon: false,
    reconAgeDays: 0,
  }) as BgsRow['priority'];
const war = (over: Partial<ConflictDetail> = {}): ConflictDetail => ({
  type: 'war',
  status: 'active',
  factionA: CANONN_FACTION,
  factionB: 'Rivals',
  wonA: 0,
  wonB: 0,
  stakeA: '',
  stakeB: 'Their Outpost',
  ...over,
});

describe('ethos and conflict type', () => {
  it("maps governments to the guide's ethos groups", () => {
    expect(ethosOf('Cooperative')).toBe('social');
    expect(ethosOf('Patronage')).toBe('autocrat');
    expect(ethosOf('Corporate')).toBe('corporate');
    expect(ethosOf('Anarchy')).toBe('criminal');
  });
  it('makes same-ethos contests elections, others wars, and anarchies always war', () => {
    expect(conflictTypeBetween('Cooperative', 'Democracy')).toBe('election');
    expect(conflictTypeBetween('Cooperative', 'Corporate')).toBe('war');
    expect(conflictTypeBetween('Anarchy', 'Anarchy')).toBe('war');
    expect(conflictTypeBetween('Cooperative', null)).toBeNull();
  });
});

describe('buildPriorityStory', () => {
  const base = row({
    systemName: 'Here',
    controllingFaction: 'Rivals',
    canonnInfluence: 30,
    architect: 'Builder',
    architectAffiliation: AFFILIATION_CANONN_MEMBER,
    preferredFaction: CANONN_FACTION,
    preferredFactionRecorded: true,
    factions: [f('Rivals', 40), f(CANONN_FACTION, 30), f('Others', 30)],
    factionDetails: [
      d('Rivals', 40, 'Corporate'),
      d(CANONN_FACTION, 30, 'Cooperative'),
      d('Others', 30, 'Cooperative'),
    ],
    stations: [{ name: 'Rival Port', type: 'Outpost', controllingFaction: 'Rivals' }],
    priority: P('P1'),
  });

  it('gives Canonn-named stations as a reason, asking for the ones another faction runs', () => {
    const story = buildPriorityStory(
      {
        ...base,
        stations: [
          ...base.stations,
          { name: 'Canonn Biscuit Centre', type: 'Outpost', controllingFaction: 'Rivals' },
        ],
      },
      [base],
    );
    expect(story.why).toContain('1 station carries the Canonn name: Canonn Biscuit Centre');
    expect(story.why).toContain(
      'Canonn Biscuit Centre is run by Rivals: we would really like Canonn to control it',
    );
    expect(story.canonnStations.map((s) => s.owner)).toEqual(['O']);
  });

  it('keeps the API reasons and names a Canonn architect', () => {
    const story = buildPriorityStory(base, [base]);
    expect(story.why[0]).toBe('A reason from the API');
    expect(story.why).toContain('Canonn architect Builder asked for Canonn');
  });

  it('only offers trade and exploration where Canonn owns a station', () => {
    const none = buildPriorityStory(base, [base]);
    expect(none.help[0].text).toContain(
      'owns no station here, so trade and exploration data will not help',
    );
    const owned = buildPriorityStory(
      {
        ...base,
        stations: [
          ...base.stations,
          { name: 'Our Dock', type: 'Outpost', controllingFaction: CANONN_FACTION },
        ],
      },
      [base],
    );
    expect(owned.help[0].text).toContain(
      "Trade and exploration data count at Canonn's stations (Our Dock)",
    );
  });

  it('turns a war into combat-zone orders, the player rule and a stake to win', () => {
    const story = buildPriorityStory({ ...base, conflicts: [war({ wonA: 3, wonB: 1 })] }, [base]);
    expect(story.headline).toBe('One more day wins Their Outpost');
    expect(story.help.map((h) => h.label)).toEqual(['War', 'Rules']);
    expect(story.control[0]).toBe(
      'Win the war against Rivals: Canonn takes Their Outpost and gains about 1.5%',
    );
    expect(story.conflict).toMatchObject({ usDays: 3, themDays: 1 });
  });

  it('aims conflict orders at whichever of our factions is fighting', () => {
    const story = buildPriorityStory({ ...base, conflicts: [war({ factionA: CDSR_FACTION })] }, [
      base,
    ]);
    expect(story.help[0].text).toContain('Combat zones for CDSR');
    expect(story.control[0]).toContain('CDSR takes Their Outpost');
  });

  it('treats a conflict against the controller as the fight for control, and its stake as owned', () => {
    const story = buildPriorityStory(
      { ...base, conflicts: [war({ type: 'election', stakeA: 'Our Gateway' })] },
      [base],
    );
    expect(story.control[1]).toBe(
      'This election is against the controller, so winning it should hand Canonn the system',
    );
    expect(story.help[0].text).toContain(
      "Trade and exploration data count at Canonn's stations (Our Gateway)",
    );
    expect(story.why).toContain(
      "Canonn's stake, Our Gateway, is its only station here: losing would leave it with none",
    );
  });

  it('turns an election into non-combat orders', () => {
    const story = buildPriorityStory(
      { ...base, conflicts: [war({ type: 'election', factionB: 'Others' })] },
      [base],
    );
    expect(story.help[0].label).toBe('Election');
    expect(story.help[1].text).toContain('do not count during an election');
  });

  it('predicts the control contest from ethos and honours a watchlist handover', () => {
    const withNote = {
      ...base,
      watchlist: [
        {
          systemName: 'Here',
          faction: CANONN_FACTION,
          position: 1,
          details: 'Agreement with Rivals that Canonn will have control.',
        },
      ],
    };
    const story = buildPriorityStory(withNote, [withNote]);
    expect(story.control[0]).toBe(
      'Close the 10.0 points gap to Rivals; the contest for control will be a war',
    );
    expect(story.control).toContain(
      'Agree the handover with Rivals first, as the watchlist agreement sets out',
    );
    expect(story.agreements).toEqual(['Agreement with Rivals that Canonn will have control.']);
  });

  it('shows Powerplay only when there is reinforcing or undermining', () => {
    const quiet = {
      ...base,
      powerplay: {
        powers: ['P'],
        controllingPower: 'P',
        state: 'Exploited',
        controlProgressPercent: null,
        reinforcement: 0,
        undermining: 0,
        conflictProgress: [],
      },
    };
    expect(buildPriorityStory(quiet, [quiet]).powerplay).toBeNull();
    const ours = {
      ...quiet,
      controllingFaction: CANONN_FACTION,
      factions: [f(CANONN_FACTION, 50), f('Rivals', 30)],
      powerplay: { ...quiet.powerplay, reinforcement: 200, undermining: 5000 },
    };
    const pp = buildPriorityStory(ours, [ours]).powerplay!;
    expect(pp.notable).toBe(true);
    expect(pp.reading).toContain('Members pledged to P can reinforce here');
  });

  it('builds rival history across the snapshot, tagging player groups', () => {
    const colony = row({
      systemName: 'Their Colony',
      preferredFaction: 'Rivals',
      preferredFactionRecorded: true,
      controllingFaction: 'Rivals',
      canonnInfluence: 10,
      factions: [f('Rivals', 60), f(CANONN_FACTION, 10)],
    });
    const ours = row({
      systemName: 'Ours',
      controllingFaction: CANONN_FACTION,
      cdsrInfluence: 50,
      factions: [f(CDSR_FACTION, 50), f('Rivals', 20)],
    });
    const story = buildPriorityStory(base, [base, colony, ours]);
    const rivals = story.rivals.find((r) => r.faction === 'Rivals')!;
    expect(rivals.playerGroup).toBe(true);
    expect(rivals.shared.map((s) => s.name)).toEqual(['Here', 'Our' + 's', 'Their Colony']);
    expect([rivals.theyRun, rivals.weRun]).toEqual([2, 1]);
  });

  it("keeps hands off another group's preferred colony", () => {
    const theirs = { ...base, preferredFaction: 'Rivals', priority: P('out-of-scope') };
    const story = buildPriorityStory(theirs, [theirs]);
    expect(story.headline).toBe("Rivals' colony: hands off");
    expect(story.help[0].label).toBe('Hands off');
  });

  it('produces a Discord post with the system, architect and steps', () => {
    const text = buildPriorityStory(base, [base]).discord;
    expect(text).toContain('## Here — P1 (90)');
    expect(text).toContain('Architect: Builder');
    expect(text).toContain('1. Close the');
  });
});
