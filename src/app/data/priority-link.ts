/** Query param naming the system whose priority card a shared link opens. */
export const PRIORITY_PARAM = 'priority';

/**
 * A link that opens the site on the Priorities table sorted by distance from `systemName`
 * (the table's `near` param) with that system's priority card already open.
 */
export function priorityShareUrl(origin: string, pathname: string, systemName: string): string {
  const params = new URLSearchParams({ near: systemName, [PRIORITY_PARAM]: systemName });
  return `${origin}${pathname}?${params.toString()}`;
}
