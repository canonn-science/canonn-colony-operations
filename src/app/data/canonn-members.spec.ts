import { CanonnMember, isCanonnMember, mergeKnownNames } from './canonn-members';

function member(name: string, squadron = 'CANO'): CanonnMember {
  return { name, squadron };
}

describe('isCanonnMember', () => {
  const members = [member('Herix'), member('Alexa Chaney', 'CDSR')];

  it('matches case/whitespace-insensitively', () => {
    expect(isCanonnMember(members, '  herix  ')).toBe(true);
    expect(isCanonnMember(members, 'ALEXA CHANEY')).toBe(true);
  });

  it('is false for an unknown or blank name', () => {
    expect(isCanonnMember(members, 'Someone Else')).toBe(false);
    expect(isCanonnMember(members, '')).toBe(false);
  });
});

describe('mergeKnownNames', () => {
  it('adds roster members not already in the registry names, sorted A-Z', () => {
    const merged = mergeKnownNames(['Herix'], [member('Alexa Chaney'), member('Herix')]);
    expect(merged).toEqual(['Alexa Chaney', 'Herix']);
  });

  it('keeps the registry spelling on a case-insensitive collision', () => {
    const merged = mergeKnownNames(['HERIX'], [member('herix')]);
    expect(merged).toEqual(['HERIX']);
  });
});
