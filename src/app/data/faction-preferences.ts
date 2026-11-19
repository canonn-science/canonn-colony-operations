/**
 * Commanders who told the colony form which faction(s) they prefer — published from the
 * "Faction Name" / "Alt Faction" tab of the squadron sheet (see
 * {@link ../../../scripts/fetch-canonn-members.js}). A commander listed here prefers a
 * non-Canonn faction, so the Assign dialog treats them as "Not a Canonn Member".
 */

import { InjectionToken } from '@angular/core';
import { FACTION_PREFERENCES } from './faction-preferences-generated';

/** One commander and their preferred faction names (primary first). */
export interface FactionPreference {
  readonly cmdr: string;
  readonly factions: readonly string[];
}

/** The commander sheet's rows; defaults to the build-time snapshot, and is overridable in tests. */
export const FACTION_PREFERENCES_TOKEN = new InjectionToken<readonly FactionPreference[]>('FACTION_PREFERENCES', {
  providedIn: 'root',
  factory: () => FACTION_PREFERENCES,
});

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The preferred factions listed for `cmdr`, matched case/whitespace-insensitively; [] if none. */
export function findPreferredFactions(preferences: readonly FactionPreference[], cmdr: string): readonly string[] {
  const key = nameKey(cmdr);
  if (!key) {
    return [];
  }
  return preferences.filter(entry => nameKey(entry.cmdr) === key).flatMap(entry => entry.factions);
}

/**
 * Of the `preferred` factions, the one present in the system with the most influence, or null if
 * none is present there.
 */
export function pickPreferredFaction(
  preferred: readonly string[],
  systemFactions: readonly { name: string; influencePercent: number }[],
): string | null {
  const wanted = new Set(preferred.map(nameKey));
  let best: { name: string; influencePercent: number } | null = null;
  for (const faction of systemFactions) {
    if (wanted.has(nameKey(faction.name)) && (!best || faction.influencePercent > best.influencePercent)) {
      best = faction;
    }
  }
  return best?.name ?? null;
}
