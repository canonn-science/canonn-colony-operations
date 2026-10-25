import { PRIORITY_PARAM, priorityShareUrl } from './priority-link';

describe('priorityShareUrl', () => {
  it('sorts by distance from the system and asks for its card', () => {
    const url = new URL(priorityShareUrl('https://example.org', '/colony/', 'Varati'));

    expect(url.origin + url.pathname).toBe('https://example.org/colony/');
    expect(url.searchParams.get('near')).toBe('Varati');
    expect(url.searchParams.get(PRIORITY_PARAM)).toBe('Varati');
  });

  it('encodes names with spaces and symbols so they read back unchanged', () => {
    const url = new URL(priorityShareUrl('https://example.org', '/', 'HIP 1234 & Co'));

    expect(url.searchParams.get('near')).toBe('HIP 1234 & Co');
    expect(url.searchParams.get(PRIORITY_PARAM)).toBe('HIP 1234 & Co');
  });
});
