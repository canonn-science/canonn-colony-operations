import { BgsRow } from '../canonn-bgs.service';
import { exportFilename, toExportRecord } from './export';

/** A minimal, fully-populated row — tests override only the fields they care about. */
function row(overrides: Partial<BgsRow> = {}): BgsRow {
  return {
    systemName: 'Test System',
    controllingFaction: null,
    canonnInfluence: null,
    cdsrInfluence: null,
    architect: null,
    notAColony: false,
    preferredFaction: null,
    factions: [],
    warState: null,
    warDetails: null,
    warIsCanonnVsCanonn: false,
    electionState: null,
    electionDetails: null,
    electionIsCanonnVsCanonn: false,
    retreatState: null,
    retreatDetails: null,
    expansionState: null,
    bodyCount: null,
    population: null,
    x: 0,
    y: 0,
    z: 0,
    updatedAt: null,
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-07T12:00:00Z');

describe('toExportRecord', () => {
  it('carries over the raw row fields as-is', () => {
    const record = toExportRecord(
      row({
        systemName: 'Varati',
        controllingFaction: 'Canonn',
        canonnInfluence: 42.5,
        cdsrInfluence: 10,
        architect: 'Some Architect',
        preferredFaction: 'Canonn',
        factions: [{ name: 'Canonn', influencePercent: 42.5 }],
        warState: 'active',
        electionState: null,
        retreatState: null,
        bodyCount: 12,
        population: 1000,
        x: 1,
        y: 2,
        z: 3,
      }),
      NOW,
    );

    expect(record.systemName).toBe('Varati');
    expect(record.controllingFaction).toBe('Canonn');
    expect(record.canonnInfluence).toBe(42.5);
    expect(record.cdsrInfluence).toBe(10);
    expect(record.architect).toBe('Some Architect');
    expect(record.preferredFaction).toBe('Canonn');
    expect(record.factions).toEqual([{ name: 'Canonn', influencePercent: 42.5 }]);
    expect(record.warState).toBe('active');
    expect(record.bodyCount).toBe(12);
    expect(record.population).toBe(1000);
    expect(record.x).toBe(1);
    expect(record.y).toBe(2);
    expect(record.z).toBe(3);
  });

  it('folds in the same priority tier and freshness label the table displays', () => {
    const record = toExportRecord(row({ updatedAt: '2026-08-07 12:00:00+00' }), NOW);
    expect(record.priorityTier).toBeTruthy();
    expect(record.freshnessLabel).toBe('now');
  });
});

describe('exportFilename', () => {
  it('embeds the date and requested extension', () => {
    expect(exportFilename('json', NOW)).toBe('canonn-colony-operations-2026-08-07.json');
    expect(exportFilename('pdf', NOW)).toBe('canonn-colony-operations-2026-08-07.pdf');
  });
});
