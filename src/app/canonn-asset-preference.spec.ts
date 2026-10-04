import { CDSR_FACTION, CANONN_FACTION, derivePreferredFaction, isCanonnAsset } from './canonn-bgs.service';

describe('isCanonnAsset', () => {
  it('matches "canonn" anywhere in the station name, in any case', () => {
    expect(isCanonnAsset({ name: 'Canonn Monitoring Array E-42', type: 'Outpost', controlling_minor_faction: null })).toBe(true);
    expect(isCanonnAsset({ name: 'Canonnia Hub', type: 'Outpost', controlling_minor_faction: null })).toBe(true);
    expect(isCanonnAsset({ name: 'Arcanonn Dock', type: 'Outpost', controlling_minor_faction: null })).toBe(true);
    expect(isCanonnAsset({ name: 'Kepler Landing', type: 'Outpost', controlling_minor_faction: null })).toBe(false);
  });
});

describe('derivePreferredFaction', () => {
  it('is null when no station is Canonn-named', () => {
    expect(derivePreferredFaction({ hasCanonnStation: false, canonnInfluence: 50, cdsrInfluence: 40 })).toBeNull();
  });

  it('picks Canonn when it has more influence than CDSR', () => {
    expect(derivePreferredFaction({ hasCanonnStation: true, canonnInfluence: 50, cdsrInfluence: 40 })).toBe(CANONN_FACTION);
  });

  it('picks CDSR when it has more influence than Canonn', () => {
    expect(derivePreferredFaction({ hasCanonnStation: true, canonnInfluence: 20, cdsrInfluence: 40 })).toBe(CDSR_FACTION);
  });

  it('picks CDSR when only CDSR is present', () => {
    expect(derivePreferredFaction({ hasCanonnStation: true, canonnInfluence: null, cdsrInfluence: 12 })).toBe(CDSR_FACTION);
  });

  it('defaults to Canonn on a tie or when neither is present', () => {
    expect(derivePreferredFaction({ hasCanonnStation: true, canonnInfluence: 30, cdsrInfluence: 30 })).toBe(CANONN_FACTION);
    expect(derivePreferredFaction({ hasCanonnStation: true, canonnInfluence: null, cdsrInfluence: null })).toBe(CANONN_FACTION);
  });
});
