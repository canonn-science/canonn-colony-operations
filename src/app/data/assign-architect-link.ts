/** Query param naming the system whose Assign Architect dialog a shared link opens. */
export const ASSIGN_PARAM = 'assign';

/** A link that opens the site with the Assign Architect dialog already open for `systemName`. */
export function assignArchitectShareUrl(origin: string, pathname: string, systemName: string): string {
  const params = new URLSearchParams({ tab: 'all', [ASSIGN_PARAM]: systemName });
  return `${origin}${pathname}?${params.toString()}`;
}
