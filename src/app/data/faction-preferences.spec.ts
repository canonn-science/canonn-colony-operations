import { FactionPreference, findPreferredFactions, pickPreferredFaction } from './faction-preferences';

const PREFS: FactionPreference[] = [{ cmdr: 'Exil', factions: ['The Mercs Of Mikunn', 'The Dukes of Mikunn'] }];

describe('findPreferredFactions', () => {
  it('matches the commander ignoring case and whitespace', () => {
    expect(findPreferredFactions(PREFS, '  EXIL ')).toEqual(['The Mercs Of Mikunn', 'The Dukes of Mikunn']);
  });
  it('returns nothing for an unknown or blank name', () => {
    expect(findPreferredFactions(PREFS, 'Someone Else')).toEqual([]);
    expect(findPreferredFactions(PREFS, '')).toEqual([]);
  });
});

describe('pickPreferredFaction', () => {
  const factions = [
    { name: 'Local Lads', influencePercent: 50 },
    { name: 'The Dukes of Mikunn', influencePercent: 30 },
    { name: 'The Mercs Of Mikunn', influencePercent: 10 },
  ];
  it('picks the present preferred faction with the most influence', () => {
    expect(pickPreferredFaction(['The Mercs Of Mikunn', 'The Dukes of Mikunn'], factions)).toBe('The Dukes of Mikunn');
  });
  it('picks the only one present', () => {
    expect(pickPreferredFaction(['the mercs of mikunn', 'Absent'], factions)).toBe('The Mercs Of Mikunn');
  });
  it('returns null when none is present', () => {
    expect(pickPreferredFaction(['Absent'], factions)).toBeNull();
    expect(pickPreferredFaction([], factions)).toBeNull();
  });
});
