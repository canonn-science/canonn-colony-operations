/**
 * The Canonn Architect Registry Google Form: its field ids, its accepted answers, and the
 * request body a submission turns into.
 *
 * The ids and option strings below are the form's own (read out of the live form's
 * `FB_PUBLIC_LOAD_DATA_`), so they have to match exactly — Google silently records a blank
 * answer for an entry id it doesn't recognise, and rejects an unlisted value for a
 * multiple-choice question that has no "other" option.
 */

/** Where the form is submitted; the `viewform` URL with the last segment swapped. */
export const ARCHITECT_FORM_ACTION =
  'https://docs.google.com/forms/d/e/1FAIpQLSfXin9fy62qiVurl1HRypwELW-nh6GATmxODgqMOPhb-S2sCA/formResponse';

const ENTRY_YOUR_NAME = 'entry.865244908';
const ENTRY_SYSTEM_NAME = 'entry.451477697';
const ENTRY_ARCHITECT_NAME = 'entry.1898979532';
const ENTRY_AFFILIATION = 'entry.1237715592';
const ENTRY_PREFERRED_FACTION = 'entry.389110787';

/** The "Canonn Architect" question's four answers, exactly as the form spells them. */
export const AFFILIATION_CANONN_MEMBER = 'The Architect is a Canonn Member';
export const AFFILIATION_NOT_MEMBER = 'Not a Canonn Member';
export const AFFILIATION_NOT_A_COLONY = 'Nobody The System Is Not a Colony';
export const AFFILIATION_UNKNOWN = "Don't know";

/** The affiliation dropdown's contents: the form's value, plus a friendlier label to show. */
export const AFFILIATION_OPTIONS: readonly { value: string; label: string }[] = [
  { value: AFFILIATION_CANONN_MEMBER, label: 'The Architect is a Canonn Member' },
  { value: AFFILIATION_NOT_MEMBER, label: 'Not a Canonn Member' },
  { value: AFFILIATION_NOT_A_COLONY, label: 'Nobody — the system is not a colony' },
  { value: AFFILIATION_UNKNOWN, label: "Don't know" },
];

/**
 * The only two "Preferred Faction" answers the form lists; anything else (a local faction
 * the colony prefers) has to be sent through the question's "other" option instead.
 */
const LISTED_PREFERRED_FACTIONS: ReadonlySet<string> = new Set(['Canonn', 'Canonn Deep Space Research']);

/** Google's sentinel value for "the answer is in the `.other_option_response` field". */
const OTHER_OPTION = '__other_option__';

/** Architect name recorded when the user answers that the system isn't a colony at all. */
export const NOBODY_ARCHITECT = 'Nobody';

/** One filled-in Architect Registry form, ready to submit. */
export interface ArchitectSubmission {
  /** The commander doing the reporting ("Your Name"). */
  yourName: string;
  systemName: string;
  architect: string;
  /** One of the `AFFILIATION_*` values. */
  affiliation: string;
  /** The faction name, or '' for "Don't know" — the question is optional, so '' is sent as no answer. */
  preferredFaction: string;
}

/**
 * Encodes a submission as the form's POST body. "Don't know" for the preferred faction is
 * sent as no answer at all (the question is optional) rather than as an empty string, which
 * would land in the sheet as a blank the registry can't distinguish from a skipped answer.
 */
export function buildArchitectFormBody(submission: ArchitectSubmission): URLSearchParams {
  const body = new URLSearchParams();
  body.set(ENTRY_YOUR_NAME, submission.yourName);
  body.set(ENTRY_SYSTEM_NAME, submission.systemName);
  body.set(ENTRY_ARCHITECT_NAME, submission.architect);
  body.set(ENTRY_AFFILIATION, submission.affiliation);

  const faction = submission.preferredFaction;
  if (faction) {
    if (LISTED_PREFERRED_FACTIONS.has(faction)) {
      body.set(ENTRY_PREFERRED_FACTION, faction);
    } else {
      body.set(ENTRY_PREFERRED_FACTION, OTHER_OPTION);
      body.set(`${ENTRY_PREFERRED_FACTION}.other_option_response`, faction);
    }
  }

  // Single-page form: tell Google this is the whole response so it's recorded rather than
  // treated as a partially-completed page.
  body.set('fvv', '1');
  body.set('pageHistory', '0');
  return body;
}
