import {
  AFFILIATION_CANONN_MEMBER,
  AFFILIATION_NOT_MEMBER,
  ArchitectSubmission,
  buildArchitectFormBody,
} from './architect-form';

function submission(partial: Partial<ArchitectSubmission> = {}): ArchitectSubmission {
  return {
    yourName: 'LCU No Fool Like One',
    systemName: 'Varati',
    architect: 'Herix',
    affiliation: AFFILIATION_CANONN_MEMBER,
    preferredFaction: 'Canonn',
    ...partial,
  };
}

describe('buildArchitectFormBody', () => {
  it('maps each answer onto the form entry it belongs to', () => {
    const body = buildArchitectFormBody(submission());
    expect(body.get('entry.865244908')).toBe('LCU No Fool Like One');
    expect(body.get('entry.451477697')).toBe('Varati');
    expect(body.get('entry.1898979532')).toBe('Herix');
    expect(body.get('entry.1237715592')).toBe(AFFILIATION_CANONN_MEMBER);
    expect(body.get('entry.389110787')).toBe('Canonn');
    expect(body.get('entry.389110787.other_option_response')).toBeNull();
  });

  it('sends a faction the form does not list through the "other" option', () => {
    const body = buildArchitectFormBody(
      submission({ affiliation: AFFILIATION_NOT_MEMBER, preferredFaction: 'Flat Galaxy Society' }),
    );
    expect(body.get('entry.389110787')).toBe('__other_option__');
    expect(body.get('entry.389110787.other_option_response')).toBe('Flat Galaxy Society');
  });

  it('omits the optional faction question entirely for "Don\'t know"', () => {
    const body = buildArchitectFormBody(submission({ preferredFaction: '' }));
    expect(body.has('entry.389110787')).toBe(false);
    expect(body.has('entry.389110787.other_option_response')).toBe(false);
  });
});
