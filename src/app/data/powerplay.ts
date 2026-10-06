/**
 * Plain-language notes on how a system's powerplay state may be shaping its BGS factions, for the
 * system info dialog. Pure functions, so the wording can be specced without rendering the dialog.
 */
import { BgsRow, PowerplayDetail } from '../canonn-bgs.service';

/**
 * The notes for the dialog, one paragraph each: rival powers contesting the system, and what the
 * reinforcement/undermining balance may mean for the BGS factions here, chiefly the one in control.
 * The controlling power and state are already shown in the dialog, so they aren't repeated.
 */
export function describePowerplayInfluence(powerplay: PowerplayDetail, row: BgsRow): string[] {
  const notes: string[] = [];
  const { controllingPower, reinforcement, undermining } = powerplay;
  const underPressure = reinforcement !== null && undermining !== null && undermining > reinforcement;

  if (controllingPower === null) {
    notes.push('No power is steering this system, so powerplay is not affecting the BGS factions here.');
  } else if (reinforcement !== null && undermining !== null) {
    notes.push(assessBgsFactions(row, reinforcement, undermining));
  }

  if (underPressure) {
    notes.push('Watch the influence and state columns here, since rival powers working against the controlling one may move the local factions.');
  }

  return notes;
}

/** How the reinforcement/undermining balance may be shaping the BGS factions, led by the one in control. */
function assessBgsFactions(row: BgsRow, reinforcement: number, undermining: number): string {
  const controller = row.controllingFaction;
  const influence = row.factions.find(f => f.name === controller)?.influencePercent;
  const lead = controller && influence !== undefined ? `${controller} (${influence.toFixed(1)}%)` : 'the controlling faction';

  if (reinforcement === 0 && undermining === 0) {
    return `No powerplay pressure is being applied, so the BGS factions here are not being pushed either way by powerplay; ${lead} keeps its place unless the factions' own activity changes it.`;
  }
  if (undermining > reinforcement) {
    return `Undermining is ahead of reinforcement here, so rival powers are working against the power in control. ${lead} may lose influence in the BGS to rival factions while that continues.`;
  }
  if (reinforcement > undermining) {
    return `Reinforcement is ahead of undermining here, which should help ${lead} hold its place in the BGS and make a shift in control less likely.`;
  }
  return `Reinforcement and undermining cancel each other out, so powerplay is not pushing ${lead} either way in the BGS.`;
}
