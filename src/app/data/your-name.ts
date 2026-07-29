/**
 * The reporting commander's own name, remembered across visits — pre-filled in the Assign
 * dialog's "Your Name" field, and used to default the table's Architect quick filter to "me".
 */

/** localStorage key the name is stored under. */
const YOUR_NAME_KEY = 'canonn-bgs:your-name:v1';

export function readYourName(): string {
  try {
    return localStorage.getItem(YOUR_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeYourName(name: string): void {
  try {
    localStorage.setItem(YOUR_NAME_KEY, name);
  } catch {
    // Storage unavailable (e.g. private browsing) — the name just won't be remembered.
  }
}
