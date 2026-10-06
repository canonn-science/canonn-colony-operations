import { BgsRow, PowerplayDetail } from '../canonn-bgs.service';
import { describePowerplayInfluence } from './powerplay';

function powerplay(overrides: Partial<PowerplayDetail> = {}): PowerplayDetail {
  return {
    powers: ['Nakato Kaine'],
    controllingPower: 'Nakato Kaine',
    state: 'Exploited',
    controlProgressPercent: 6.57,
    reinforcement: 426,
    undermining: 822,
    conflictProgress: [],
    ...overrides,
  };
}

/** Only the fields the notes read: the controlling BGS faction and the faction list. */
function row(overrides: Partial<Pick<BgsRow, 'controllingFaction' | 'factions'>> = {}): BgsRow {
  return {
    controllingFaction: 'Workers of HIP 67882 Democrats',
    factions: [
      { name: 'Workers of HIP 67882 Democrats', influencePercent: 46.95 },
      { name: 'Chakpa Purple Travel Exchange', influencePercent: 29.8 },
    ],
    ...overrides,
  } as BgsRow;
}

describe('describePowerplayInfluence', () => {
  it('says undermining may cost the controlling BGS faction influence when it outweighs reinforcement', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 426, undermining: 822 }), row());
    expect(notes[0]).toBe(
      'Undermining is ahead of reinforcement here, so rival powers are working against the power in control. Workers of HIP 67882 Democrats (47.0%) may lose influence in the BGS to rival factions while that continues.',
    );
  });

  it('says reinforcement should help the controlling BGS faction hold its place', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 900, undermining: 100 }), row());
    expect(notes[0]).toContain('should help Workers of HIP 67882 Democrats (47.0%) hold its place');
  });

  it('says powerplay is not pushing the factions when reinforcement and undermining both sit at 0', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 0, undermining: 0 }), row());
    expect(notes[0]).toContain('not being pushed either way by powerplay');
    expect(notes.some(n => n.includes('balanced'))).toBe(false);
  });

  it('says powerplay is not pushing the controlling faction when the two cancel out', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 300, undermining: 300 }), row());
    expect(notes[0]).toContain('cancel each other out');
  });

  it('falls back to a generic label when the controlling faction is not in the faction list', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 100, undermining: 200 }), row({ controllingFaction: null }));
    expect(notes[0]).toContain('the controlling faction may lose influence');
  });

  it('does not restate the controlling power or the state', () => {
    const notes = describePowerplayInfluence(powerplay(), row());
    expect(notes.some(n => n.includes('controls this system'))).toBe(false);
    expect(notes.some(n => n.includes('Nakato Kaine'))).toBe(false);
    expect(notes.some(n => n.includes('basic income'))).toBe(false);
  });

  it('says powerplay is not affecting the factions when no power is steering an unoccupied system', () => {
    const notes = describePowerplayInfluence(
      powerplay({ controllingPower: null, state: 'Unoccupied', powers: ['Pranav Antal', 'Yuri Grom'] }),
      row(),
    );
    expect(notes[0]).toBe('No power is steering this system, so powerplay is not affecting the BGS factions here.');
  });

  it('asks to watch the influence and state columns while undermining is ahead', () => {
    const notes = describePowerplayInfluence(powerplay({ reinforcement: 426, undermining: 822 }), row());
    expect(notes.some(n => n.includes('Watch the influence and state columns'))).toBe(true);
  });

  it('does not list contesting powers in the notes', () => {
    const notes = describePowerplayInfluence(
      powerplay({ conflictProgress: [{ power: 'Li Yong-Rui', progressPercent: 0.0183 }] }),
      row(),
    );
    expect(notes.some(n => n.includes('Contesting powers'))).toBe(false);
  });
});
