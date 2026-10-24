/**
 * The Canonn/CDSR member roster, published from the in-game squadron membership sheet (see
 * {@link ../../../scripts/fetch-canonn-members.js}). Unlike the Architect Registry, this list
 * has no affiliation or faction history of its own — it only tells the Assign dialog "this
 * CMDR is a Canonn member," so a first-time architect from the roster still gets sensible
 * defaults instead of starting from "Unknown."
 */

/** One row of the published squadron roster. */
export interface CanonnMember {
  readonly name: string;
  readonly squadron: string;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** True if `name` matches a CMDR in the roster, case/whitespace-insensitively. */
export function isCanonnMember(members: readonly CanonnMember[], name: string): boolean {
  const key = nameKey(name);
  if (!key) {
    return false;
  }
  return members.some(member => nameKey(member.name) === key);
}

/**
 * `registryNames` plus any roster members not already present, case/whitespace-insensitively
 * deduped, A-Z. Registry names win on a collision since they carry the most recently recorded
 * spelling.
 */
export function mergeKnownNames(registryNames: readonly string[], members: readonly CanonnMember[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of registryNames) {
    byKey.set(nameKey(name), name);
  }
  for (const member of members) {
    const key = nameKey(member.name);
    if (!byKey.has(key)) {
      byKey.set(key, member.name);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
