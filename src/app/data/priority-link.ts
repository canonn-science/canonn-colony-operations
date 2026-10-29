/** Query param naming the system whose priority card a shared link opens. */
export const PRIORITY_PARAM = 'priority';

/**
 * A link that opens the site on the All Systems table (the system may not be a P0 one) sorted by distance from `systemName`
 * (the table's `near` param) with that system's priority card already open.
 */
export function priorityShareUrl(origin: string, pathname: string, systemName: string): string {
  const params = new URLSearchParams({ tab: 'all', near: systemName, [PRIORITY_PARAM]: systemName });
  return `${origin}${pathname}?${params.toString()}`;
}
