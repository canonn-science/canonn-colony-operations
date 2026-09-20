import { BgsRow } from '../canonn-bgs.service';
import { exportFilename, rowsToCsv, toExportRecord } from './export';

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
    expect(exportFilename('csv', NOW)).toBe('canonn-colony-operations-2026-08-07.csv');
  });
});

describe('rowsToCsv', () => {
  it('emits a header row plus one row per system, with a semicolon-joined Factions cell', () => {
    const csv = rowsToCsv(
      [
        row({
          systemName: 'Varati',
          controllingFaction: 'Canonn',
          canonnInfluence: 42.5,
          factions: [
            { name: 'Canonn', influencePercent: 42.5 },
            { name: 'Some Other Faction', influencePercent: 12.3 },
          ],
        }),
      ],
      NOW,
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'systemName,controllingFaction,canonnInfluence,cdsrInfluence,architect,preferredFaction,factions,warState,electionState,retreatState,priorityTier,priorityScore,needsRecon,bodyCount,population,x,y,z,updatedAt,freshnessLabel',
    );
    expect(lines[1]).toContain('Varati,Canonn,42.5,,,,Canonn: 42.5%; Some Other Faction: 12.3%,');
  });

  it('quotes fields containing a comma and escapes embedded quotes', () => {
    const csv = rowsToCsv([row({ systemName: 'A, "Tricky" System' })], NOW);
    expect(csv.split('\r\n')[1]).toContain('"A, ""Tricky"" System"');
  });

  it('prefixes formula-like string fields to prevent spreadsheet formula injection', () => {
    const csv = rowsToCsv([row({ systemName: '=HYPERLINK("https://evil.example")' })], NOW);
    expect(csv.split('\r\n')[1]).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
  });

  it('prefixes formula-like strings even when prefixed with whitespace', () => {
    const csv = rowsToCsv([row({ systemName: '\t=SUM(1,1)' })], NOW);
    expect(csv.split('\r\n')[1]).toContain(`"'\t=SUM(1,1)"`);
  });

  it('prefixes formula-like strings when prefixed with control characters', () => {
    const csv = rowsToCsv([row({ systemName: '\r=SUM(1,1)' })], NOW);
    expect(csv.split('\r\n')[1]).toContain(`"'\r=SUM(1,1)"`);
  });

  it('does not alter numeric fields that start with minus when stringified', () => {
    const csv = rowsToCsv([row({ x: -12.5 })], NOW);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[15]).toBe('-12.5');
  });

  it('renders null fields as empty cells', () => {
    const csv = rowsToCsv([row()], NOW);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[1]).toBe(''); // controllingFaction
    expect(cells[2]).toBe(''); // canonnInfluence
  });
});
