/**
 * The priority card: why a system matters, what helps right now, the path to full control,
 * Powerplay pressure and our history with the factions there — all derived by rule from a
 * {@link BgsRow} and the rest of the snapshot, so any row with a priority gets a card without
 * anyone writing it by hand. Pure functions, so every rule can be specced without rendering.
 *
 * The mechanics follow the Complete BGS Guide: wars count only combat, elections only economic
 * activity; a faction that owns no station only gains from missions and bounties; a conflict's
 * winner takes the loser's stake and about 1.5% influence; same-ethos factions hold elections,
 * other pairings (and any anarchy) go to war; 15–20 points is a healthy margin of control.
 */
import {
  BgsRow,
  CANONN_FACTION,
  CDSR_FACTION,
  ConflictDetail,
  StationDetail,
} from '../canonn-bgs.service';
import { AFFILIATION_CANONN_MEMBER } from './architect-form';

const US: readonly string[] = [CANONN_FACTION, CDSR_FACTION];
/** A Powerplay side this size or larger is worth calling out; smaller totals are background noise. */
export const POWERPLAY_NOTABLE = 1000;
/** A 7-day move this large (points) is worth explaining. */
const BIG_MOVE = 3;
const HEALTHY_MARGIN = 15;

export type Ethos = 'criminal' | 'autocrat' | 'corporate' | 'social' | 'unknown';

export interface StoryStation {
  name: string;
  type: string | null;
  controller: string | null;
  /** C = Canonn, D = CDSR, B = still being built, O = another faction. */
  owner: 'C' | 'D' | 'B' | 'O';
}

export interface StoryConflict {
  type: 'war' | 'election' | 'civil war';
  status: string;
  us: string;
  them: string;
  usDays: number;
  themDays: number;
  usStake: string;
  themStake: string;
}

export interface StoryRival {
  faction: string;
  influence: number;
  government: string | null;
  /** Systems where this faction and Canonn or CDSR are both present. */
  shared: { name: string; controller: string | null }[];
  theyRun: number;
  weRun: number;
  /** Architects have recorded it as preferred in colonies of its own, so it is a player group. */
  playerGroup: boolean;
  /** Its current conflicts with Canonn or CDSR anywhere. */
  conflictsWithUs: { system: string; type: string; status: string }[];
  /** Watchlist notes anywhere that name it. */
  notes: { system: string; details: string }[];
}

export interface StoryPowerplay {
  power: string;
  state: string | null;
  reinforcement: number;
  undermining: number;
  /** Whether either side reaches {@link POWERPLAY_NOTABLE}. */
  notable: boolean;
  reading: string;
}

export interface PriorityStory {
  /** The faction this system is worked for. */
  us: string;
  usInfluence: number | null;
  usControls: boolean;
  headline: string;
  why: string[];
  help: { label: string; text: string }[];
  control: string[];
  conflict: StoryConflict | null;
  /** Stations with "canonn" in the name. */
  canonnStations: StoryStation[];
  /** Stations our faction runs (construction sites excluded). */
  ourStations: StoryStation[];
  powerplay: StoryPowerplay | null;
  agreements: string[];
  history: string[];
  rivals: StoryRival[];
  /** The text for a Discord post. */
  discord: string;
}

export function ethosOf(government: string | null | undefined): Ethos {
  const g = (government ?? '').toLowerCase().replace(/\s+/g, '');
  if (g === 'anarchy') return 'criminal';
  if (['dictatorship', 'feudal', 'patronage', 'prisoncolony', 'theocracy'].includes(g))
    return 'autocrat';
  if (g === 'corporate' || g === 'corporation') return 'corporate';
  if (['communism', 'confederacy', 'cooperative', 'democracy'].includes(g)) return 'social';
  return 'unknown';
}

/** What a conflict between two governments would be; null when either ethos is unknown. */
export function conflictTypeBetween(
  a: string | null | undefined,
  b: string | null | undefined,
): 'war' | 'election' | null {
  const ea = ethosOf(a);
  const eb = ethosOf(b);
  if (ea === 'criminal' || eb === 'criminal') return 'war';
  if (ea === 'unknown' || eb === 'unknown') return null;
  return ea === eb ? 'election' : 'war';
}

const short = (f: string) => (f === CDSR_FACTION ? 'CDSR' : f);
const pts = (n: number) => `${n.toFixed(1)} point${Math.abs(n - 1) < 0.05 ? '' : 's'}`;
const list = (items: string[]) =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

function stationOwner(st: StationDetail): StoryStation['owner'] {
  if (
    /construction/i.test(`${st.name} ${st.type ?? ''}`) ||
    st.controllingFaction === 'Brewer Corporation'
  )
    return 'B';
  if (st.controllingFaction === CANONN_FACTION) return 'C';
  if (st.controllingFaction === CDSR_FACTION) return 'D';
  return 'O';
}

function toStoryStation(st: StationDetail): StoryStation {
  return {
    name: st.name.replace(/^(Orbital|Planetary) Construction Site:\s*/i, ''),
    type: st.type,
    controller: st.controllingFaction,
    owner: stationOwner(st),
  };
}

/** The faction the system is worked for: the priority's lead, else a recorded Canonn/CDSR preference, else Canonn. */
function leadFaction(row: BgsRow): string {
  const lead = row.priority?.leadFaction;
  if (lead && US.includes(lead)) return lead;
  if (row.preferredFaction && US.includes(row.preferredFaction)) return row.preferredFaction;
  if (row.cdsrInfluence !== null && row.canonnInfluence === null) return CDSR_FACTION;
  return CANONN_FACTION;
}

function ourConflict(row: BgsRow): StoryConflict | null {
  const c = (row.conflicts ?? []).find(
    (x: ConflictDetail) => US.includes(x.factionA) || US.includes(x.factionB),
  );
  if (!c) return null;
  const usIsA = US.includes(c.factionA);
  return {
    type: c.type === 'election' ? 'election' : c.type === 'civilwar' ? 'civil war' : 'war',
    status: c.status || 'active',
    us: usIsA ? c.factionA : c.factionB,
    them: usIsA ? c.factionB : c.factionA,
    usDays: (usIsA ? c.wonA : c.wonB) ?? 0,
    themDays: (usIsA ? c.wonB : c.wonA) ?? 0,
    usStake: usIsA ? c.stakeA : c.stakeB,
    themStake: usIsA ? c.stakeB : c.stakeA,
  };
}

function powerplayStory(row: BgsRow, us: string, usControls: boolean): StoryPowerplay | null {
  const pp = row.powerplay;
  const r = pp?.reinforcement ?? 0;
  const u = pp?.undermining ?? 0;
  if (!pp || (r <= 0 && u <= 0)) return null;
  const power = pp.controllingPower ?? pp.powers[0] ?? 'the power here';
  const notable = Math.max(r, u) >= POWERPLAY_NOTABLE;
  const controller = row.controllingFaction ?? 'the controlling faction';
  let reading: string;
  if (u > r) {
    reading = usControls
      ? `Undermining is ahead, which tends to pull the controlling faction down: it may explain some of ${short(us)}'s drops. That is pledged commanders doing their weekly assignments, not a move against us. Members pledged to ${power} can reinforce here, which also props ${short(us)} up.`
      : `Undermining is ahead, which tends to weaken ${controller}, the controller, and may help ${short(us)} close the gap.`;
  } else if (r > u) {
    reading = usControls
      ? `Reinforcement is ahead, which helps ${short(us)} hold its lead.`
      : `Reinforcement is ahead, which helps ${controller} hold firm: expect a slower climb for ${short(us)}.`;
  } else {
    reading =
      'Reinforcement and undermining cancel out, so Powerplay is not pushing the controller either way.';
  }
  return { power, state: pp.state, reinforcement: r, undermining: u, notable, reading };
}

/** Which faction counts as a player group: architects recorded it as preferred in at least one colony. */
function playerGroups(rows: readonly BgsRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.preferredFactionRecorded && r.preferredFaction && !US.includes(r.preferredFaction))
      set.add(r.preferredFaction);
  }
  return set;
}

function rivalStory(
  faction: string,
  row: BgsRow,
  rows: readonly BgsRow[],
  groups: Set<string>,
): StoryRival {
  const shared = rows.filter(
    (r) =>
      r.factions.some((f) => f.name === faction) &&
      (r.canonnInfluence !== null || r.cdsrInfluence !== null),
  );
  const self = row.factionDetails.find((f) => f.name === faction);
  const conflictsWithUs: StoryRival['conflictsWithUs'] = [];
  const notes: StoryRival['notes'] = [];
  for (const r of rows) {
    for (const c of r.conflicts ?? []) {
      if (
        (c.factionA === faction && US.includes(c.factionB)) ||
        (c.factionB === faction && US.includes(c.factionA))
      ) {
        conflictsWithUs.push({ system: r.systemName, type: c.type, status: c.status });
      }
    }
    for (const w of r.watchlist) {
      if (w.details.toLowerCase().includes(faction.toLowerCase()))
        notes.push({ system: r.systemName, details: w.details });
    }
  }
  return {
    faction,
    influence: row.factions.find((f) => f.name === faction)?.influencePercent ?? 0,
    government: self?.government ?? null,
    shared: shared
      .map((r) => ({ name: r.systemName, controller: r.controllingFaction }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    theyRun: shared.filter((r) => r.controllingFaction === faction).length,
    weRun: shared.filter((r) => r.controllingFaction !== null && US.includes(r.controllingFaction))
      .length,
    playerGroup: groups.has(faction),
    conflictsWithUs,
    notes,
  };
}

/** Builds the priority card for one row, using the whole snapshot for cross-system history. */
export function buildPriorityStory(row: BgsRow, rows: readonly BgsRow[]): PriorityStory {
  const us = leadFaction(row);
  const usInfluence = row.factions.find((f) => f.name === us)?.influencePercent ?? null;
  const controller = row.controllingFaction;
  const usControls = controller === us;
  const others = row.factions.filter((f) => f.name !== us);
  const top = others[0] ?? null;
  const controllerInf = row.factions.find((f) => f.name === controller)?.influencePercent ?? null;
  const rank = row.factions.findIndex((f) => f.name === us) + 1;
  const govOf = (f: string | null) =>
    row.factionDetails.find((d) => d.name === f)?.government ?? null;

  const stations = row.stations.map(toStoryStation);
  const ourStations = stations.filter((s) => s.owner === (us === CANONN_FACTION ? 'C' : 'D'));
  const canonnStations = stations.filter((s) => /canonn/i.test(s.name));
  const controllerStations = stations.filter((s) => s.controller === controller && s.owner === 'O');
  const conflict = ourConflict(row);
  const weekChange = (us === CANONN_FACTION ? row.canonnChange : row.cdsrChange)?.points ?? null;
  const groups = playerGroups(rows);
  const hasArchitect = !!row.architect && !row.notAColony;
  const memberArchitect = row.architectAffiliation === AFFILIATION_CANONN_MEMBER;
  const otherPreferred =
    row.preferredFactionRecorded && !!row.preferredFaction && !US.includes(row.preferredFaction);
  const margin =
    usControls && usInfluence !== null ? usInfluence - (top?.influencePercent ?? 0) : null;
  const gap =
    !usControls && usInfluence !== null && top ? top.influencePercent - usInfluence : null;
  const powerplay = powerplayStory(row, us, usControls);
  const age = row.priority?.reconAgeDays ?? null;

  // ---- headline ---------------------------------------------------------------------------
  let headline: string;
  if (otherPreferred) headline = `${possessive(row.preferredFaction ?? '')} colony: hands off`;
  else if (conflict && conflict.usDays === 3 && conflict.status === 'active')
    headline = `One more day wins ${conflict.themStake || `the ${conflict.type}`}`;
  else if (conflict)
    headline = `${cap(conflict.type)} ${conflict.status}: ${conflict.usDays}–${conflict.themDays} against ${conflict.them}`;
  else if (usControls && margin !== null && margin < 5)
    headline = `Holding control by just ${pts(margin)}`;
  else if (usControls && margin !== null && margin < HEALTHY_MARGIN)
    headline = 'In control, building the margin';
  else if (usControls) headline = `In control with a ${pts(margin ?? 0)} lead`;
  else if (usInfluence !== null && controllerInf !== null && usInfluence > controllerInf)
    headline = 'Ahead on influence, but not yet in control';
  else if (gap !== null && gap < 0.5) headline = 'Tied at the top';
  else if (gap !== null && rank === 2) headline = `${pts(gap)} from control`;
  else if (gap !== null) headline = `${pts(gap)} behind the leader`;
  else headline = `${short(us)} is not present here yet`;

  // ---- why --------------------------------------------------------------------------------
  const why: string[] = (row.priority?.reasons ?? []).map((r) => r.label);
  if (hasArchitect)
    why.push(
      `${memberArchitect ? 'Canonn architect' : 'Architect'} ${row.architect}${row.preferredFactionRecorded && row.preferredFaction ? ` asked for ${short(row.preferredFaction)}` : ''}`,
    );
  if (canonnStations.length) {
    why.push(
      `${canonnStations.length} station${canonnStations.length > 1 ? 's carry' : ' carries'} the Canonn name: ${list(canonnStations.map((s) => s.name))}`,
    );
    for (const s of canonnStations.filter((x) => x.owner === 'O')) {
      why.push(`${s.name} is run by ${s.controller}: we would really like Canonn to control it`);
    }
  }
  if (conflict) {
    if (conflict.themStake)
      why.push(`${short(conflict.us)} winning the ${conflict.type} gains ${conflict.themStake}`);
    const fighterStations = stations.filter(
      (s) => s.owner === (conflict.us === CANONN_FACTION ? 'C' : 'D'),
    );
    const onlyStation =
      fighterStations.length === 0 ||
      (fighterStations.length === 1 && fighterStations[0].name === conflict.usStake);
    if (conflict.usStake && onlyStation)
      why.push(
        `${short(conflict.us)}'s stake, ${conflict.usStake}, is its only station here: losing would leave it with none`,
      );
    if (!conflict.usStake && !fighterStations.length && conflict.themStake)
      why.push(`${short(conflict.us)} owns no station here, so it would be its first`);
  }
  if (weekChange !== null && Math.abs(weekChange) >= BIG_MOVE) {
    why.push(
      `${short(us)} ${weekChange > 0 ? 'gained' : 'lost'} ${pts(Math.abs(weekChange))} this week${powerplay?.notable ? `, with Powerplay ${powerplay.undermining > powerplay.reinforcement ? 'undermining' : 'reinforcement'} active here` : ''}`,
    );
  }
  if (age !== null && age >= 2)
    why.push(
      `The latest reading is ${age} day${age === 1 ? '' : 's'} old: a visit would refresh it`,
    );

  // ---- what helps -------------------------------------------------------------------------
  const help: { label: string; text: string }[] = [];
  // In a conflict the advice follows whichever of our factions is fighting, which may not be the lead faction.
  const fighter = conflict?.us ?? us;
  const leversFor = (faction: string) => {
    const owned = stations
      .filter((s) => s.owner === (faction === CANONN_FACTION ? 'C' : 'D'))
      .map((s) => s.name);
    // A conflict stake is a station the faction owns, even when the station list leaves it out.
    if (conflict?.us === faction && conflict.usStake && !owned.includes(conflict.usStake))
      owned.unshift(conflict.usStake);
    return owned.length
      ? `Trade and exploration data count at ${short(faction)}'s stations (${list(owned.slice(0, 3))}${owned.length > 3 ? ' and others' : ''}).`
      : `${short(faction)} owns no station here, so trade and exploration data will not help it.`;
  };
  const levers = leversFor(us);
  if (otherPreferred) {
    help.push({
      label: 'Hands off',
      text: `${row.preferredFaction} is the preferred faction here: it is another group's colony, so we do not work against it.`,
    });
  } else if (conflict && conflict.type === 'election') {
    help.push({
      label: 'Election',
      text: `Non-combat missions for ${short(fighter)}. ${leversFor(fighter)}`,
    });
    help.push({
      label: 'Avoid',
      text: 'Combat missions, bounties and bonds do not count during an election.',
    });
  } else if (conflict) {
    help.push({
      label: conflict.status === 'pending' ? 'War (pending)' : 'War',
      text: `Combat zones for ${short(fighter)}: low space CZs win days fastest, and ground CZs at a settlement decide who owns it. Only combat counts during a war.`,
    });
    if (conflict.status === 'pending')
      help.push({
        label: 'Before it starts',
        text: `Missions and bounties for ${short(fighter)} during the pending day.`,
      });
    help.push({ label: 'Rules', text: 'Do not engage other players outside a combat zone.' });
  } else {
    help.push({ label: short(us), text: `Missions and bounties for ${short(us)}. ${levers}` });
  }
  if (!otherPreferred && age !== null && age >= 2)
    help.push({ label: 'Recon', text: 'Fly in and dock to refresh the data for everyone.' });
  if (
    !otherPreferred &&
    powerplay?.notable &&
    usControls &&
    powerplay.undermining > powerplay.reinforcement
  ) {
    help.push({
      label: 'Powerplay',
      text: `Members pledged to ${powerplay.power} can reinforce here, which also props ${short(us)} up.`,
    });
  }

  // ---- path to full control ---------------------------------------------------------------
  const control: string[] = [];
  if (otherPreferred) {
    control.push(
      "Not ours to take: support Canonn's position without pressuring the preferred faction.",
    );
  } else {
    if (conflict) {
      control.push(
        `Win the ${conflict.type} against ${conflict.them}: ${short(conflict.us)} ${conflict.themStake ? `takes ${conflict.themStake} and ` : ''}gains about 1.5%${conflict.usStake ? `; losing would cost ${conflict.usStake}` : ''}`,
      );
    }
    const handover = row.watchlist.find(
      (w) => controller && w.details.toLowerCase().includes(controller.toLowerCase()),
    );
    const forControl = !!conflict && conflict.them === controller && !usControls;
    if (forControl) {
      control.push(
        `This ${conflict!.type} is against the controller, so winning it should hand ${short(conflict!.us)} the system`,
      );
      if (handover)
        control.push(`Keep ${controller} informed, as the watchlist agreement sets out`);
    } else if (!usControls && controller) {
      const kind = conflictTypeBetween(govOf(us), govOf(controller));
      const prize = controllerStations[0]?.name;
      if (usInfluence !== null && controllerInf !== null && usInfluence >= controllerInf) {
        control.push(
          `${short(us)} is ahead of ${controller}, so a conflict for control should follow: check for it${kind ? ` (it will be ${kind === 'war' ? 'a war' : 'an election'})` : ''}`,
        );
      } else if (controllerInf !== null && usInfluence !== null) {
        control.push(
          `Close the ${pts(controllerInf - usInfluence)} gap to ${controller}${kind ? `; the contest for control will be ${kind === 'war' ? 'a war' : 'an election'}` : ''}`,
        );
      }
      control.push(
        `Win it: ${short(us)} takes ${prize ? `${prize}, ` : ''}the controlling station, and with it the system`,
      );
      if (handover)
        control.push(
          `Agree the handover with ${controller} first, as the watchlist agreement sets out`,
        );
    }
    if (usControls && margin !== null && margin < HEALTHY_MARGIN) {
      control.push(
        `Build the lead over ${top?.name ?? 'the next faction'} from ${pts(margin)} to 15–20 so a control conflict becomes unlikely`,
      );
    } else if (usControls && margin !== null) {
      control.push(
        `Hold the lead: ${pts(margin)} over ${top?.name ?? 'the next faction'} is healthy`,
      );
    } else {
      control.push('Then build the lead to 15–20 points so control sticks');
    }
  }

  // ---- history and relationships ----------------------------------------------------------
  const agreements = row.watchlist.map((w) => w.details);
  const history: string[] = [];
  const last = row.lastConflict;
  if (last && (US.includes(last.factionA) || US.includes(last.factionB))) {
    const opp = US.includes(last.factionA) ? last.factionB : last.factionA;
    const ours = US.includes(last.factionA) ? last.factionA : last.factionB;
    history.push(
      last.winner
        ? `${short(ours)} ${last.winner === ours ? 'won' : 'lost'} the last conflict here, ${last.type === 'election' ? 'an election' : 'a war'} against ${opp}.`
        : `The last conflict here was between ${short(ours)} and ${opp}; the outcome is not recorded.`,
    );
  }
  const rivals = others
    .filter((f) => !US.includes(f.name))
    .map((f) => rivalStory(f.name, row, rows, groups));
  for (const r of rivals) {
    const elsewhere = r.conflictsWithUs.filter((c) => c.system !== row.systemName);
    if (elsewhere.length)
      history.push(
        `${r.faction} is also in conflict with us in ${list(elsewhere.map((c) => c.system))}.`,
      );
  }
  if (!history.length && !agreements.length)
    history.push('No recorded conflicts or watchlist notes with the factions here.');

  const story: PriorityStory = {
    us,
    usInfluence,
    usControls,
    headline,
    why,
    help,
    control,
    conflict,
    canonnStations,
    ourStations,
    powerplay,
    agreements,
    history,
    rivals,
    discord: '',
  };
  story.discord = discordText(row, story);
  return story;
}

/** "Rivals'" rather than "Rivals's". */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The card as a Discord post: system, architect, situation and actions. */
export function discordText(row: BgsRow, s: PriorityStory): string {
  const inara = `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(row.systemName)}`;
  const lines = [
    `## ${row.systemName} — ${row.priority?.tier ?? ''}${row.priority?.score != null ? ` (${row.priority.score})` : ''}`,
    `**${s.headline}**`,
    `Architect: ${row.architect ?? (row.notAColony ? 'not a colony' : 'none recorded')} · Run by: ${row.controllingFaction ?? '—'} · <${inara}>`,
    '',
    '**Why**',
    ...s.why.map((w) => `- ${w}`),
    '',
    '**What helps**',
    ...s.help.map((h) => `- **${h.label}:** ${h.text}`),
    '',
    '**Path to control**',
    ...s.control.map((c, i) => `${i + 1}. ${c}`),
  ];
  if (s.powerplay) lines.push('', `**Powerplay** (${s.powerplay.power}): ${s.powerplay.reading}`);
  if (s.agreements.length) lines.push('', ...s.agreements.map((a) => `> ${a}`));
  return lines.join('\n');
}
