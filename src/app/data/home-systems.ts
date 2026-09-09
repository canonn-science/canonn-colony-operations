/**
 * Canonn's and CDSR's own home systems. Retreat only removes a *non-native* faction, so a
 * faction can never retreat from its own home system — every retreat trigger and the
 * retreat icon must be suppressed there. Literal faction-name strings (rather than importing
 * `CANONN_FACTION`/`CDSR_FACTION` from `canonn-bgs.service.ts`) to avoid a circular import,
 * since that service imports {@link isHomeSystem} from here.
 *
 * Every colony, including a founding faction's own colony, is treated as non-native — the
 * community still disputes whether colonisation should count, and assuming non-native is the
 * safe direction to be wrong in (it over-warns rather than losing a system).
 */
const HOME_SYSTEMS: ReadonlyMap<string, string> = new Map([
  ['Canonn', 'Varati'],
  ['Canonn Deep Space Research', 'Canonnia'],
]);

export function isHomeSystem(factionName: string, systemName: string): boolean {
  return HOME_SYSTEMS.get(factionName) === systemName;
}
