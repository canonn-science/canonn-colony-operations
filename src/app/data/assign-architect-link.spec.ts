import { ASSIGN_PARAM, assignArchitectShareUrl } from './assign-architect-link';

describe('assignArchitectShareUrl', () => {
  it('asks for the Assign Architect dialog to open for the system', () => {
    const url = new URL(assignArchitectShareUrl('https://example.org', '/colony/', 'Varati'));

    expect(url.origin + url.pathname).toBe('https://example.org/colony/');
    expect(url.searchParams.get(ASSIGN_PARAM)).toBe('Varati');
  });

  it('encodes names with spaces and symbols so they read back unchanged', () => {
    const url = new URL(assignArchitectShareUrl('https://example.org', '/', 'HIP 1234 & Co'));

    expect(url.searchParams.get(ASSIGN_PARAM)).toBe('HIP 1234 & Co');
  });
});
