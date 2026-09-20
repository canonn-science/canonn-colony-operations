/**
 * Turns the table's rows into files the user can download — JSON and CSV for anyone who
 * wants to process the data themselves (issue #11), and a PDF report of the same columns
 * the table shows on screen. Pure data-shaping lives here; the PDF renderer itself is
 * loaded lazily from {@link exportRowsToPdf} so jsPDF never bloats the app's initial bundle.
 */
import { BgsRow } from '../canonn-bgs.service';
import { computeFreshness } from './freshness';
import { computePriorityAssessment } from './priority';

/** One row, flattened to plain JSON-friendly fields for the JSON export. */
export interface ExportRecord {
  systemName: string;
  controllingFaction: string | null;
  canonnInfluence: number | null;
  cdsrInfluence: number | null;
  architect: string | null;
  preferredFaction: string | null;
  factions: { name: string; influencePercent: number }[];
  warState: string | null;
  electionState: string | null;
  retreatState: string | null;
  priorityTier: string;
  priorityScore: number | null;
  needsRecon: boolean;
  bodyCount: number | null;
  population: number | null;
  x: number;
  y: number;
  z: number;
  updatedAt: string | null;
  freshnessLabel: string;
}

/** Flattens a row into an {@link ExportRecord}, folding in the same priority/freshness the table computes for display. */
export function toExportRecord(row: BgsRow, nowMs: number): ExportRecord {
  const priority = computePriorityAssessment(row, nowMs);
  return {
    systemName: row.systemName,
    controllingFaction: row.controllingFaction,
    canonnInfluence: row.canonnInfluence,
    cdsrInfluence: row.cdsrInfluence,
    architect: row.architect,
    preferredFaction: row.preferredFaction,
    factions: row.factions.map(f => ({ name: f.name, influencePercent: f.influencePercent })),
    warState: row.warState,
    electionState: row.electionState,
    retreatState: row.retreatState,
    priorityTier: priority.tier,
    priorityScore: priority.score,
    needsRecon: priority.needsRecon,
    bodyCount: row.bodyCount,
    population: row.population,
    x: row.x,
    y: row.y,
    z: row.z,
    updatedAt: row.updatedAt,
    freshnessLabel: computeFreshness(row.updatedAt, nowMs).label,
  };
}

/** Timestamped filename shared by every export format, e.g. `canonn-colony-operations-2026-09-20.json`. */
export function exportFilename(extension: 'json' | 'csv' | 'pdf', nowMs: number = Date.now()): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return `canonn-colony-operations-${date}.${extension}`;
}

/** Triggers a browser download of `content` under `filename`. */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Exports `rows` as a pretty-printed JSON file. */
export function exportRowsToJson(rows: readonly BgsRow[], nowMs: number = Date.now()): void {
  const records = rows.map(row => toExportRecord(row, nowMs));
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  downloadBlob(exportFilename('json', nowMs), blob);
}

const CSV_COLUMNS: readonly (keyof ExportRecord)[] = [
  'systemName',
  'controllingFaction',
  'canonnInfluence',
  'cdsrInfluence',
  'architect',
  'preferredFaction',
  'factions',
  'warState',
  'electionState',
  'retreatState',
  'priorityTier',
  'priorityScore',
  'needsRecon',
  'bodyCount',
  'population',
  'x',
  'y',
  'z',
  'updatedAt',
  'freshnessLabel',
];

/** Quotes a CSV field only when it needs it (contains a comma, quote, or newline), per RFC 4180. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Stringifies one {@link ExportRecord} field for CSV — the Factions column collapses to a single semicolon-separated cell. */
function csvValue(record: ExportRecord, column: keyof ExportRecord): string {
  if (column === 'factions') {
    return record.factions.map(f => `${f.name}: ${f.influencePercent.toFixed(1)}%`).join('; ');
  }
  const value = record[column];
  return value === null ? '' : String(value);
}

/** Builds the CSV text for `rows` — one column per {@link ExportRecord} field, Factions flattened to a single cell. Pure, so it's testable without a DOM. */
export function rowsToCsv(rows: readonly BgsRow[], nowMs: number = Date.now()): string {
  const records = rows.map(row => toExportRecord(row, nowMs));
  const lines = [
    CSV_COLUMNS.join(','),
    ...records.map(record => CSV_COLUMNS.map(column => csvField(csvValue(record, column))).join(',')),
  ];
  return lines.join('\r\n');
}

/** Exports `rows` as a CSV file. */
export function exportRowsToCsv(rows: readonly BgsRow[], nowMs: number = Date.now()): void {
  const blob = new Blob([rowsToCsv(rows, nowMs)], { type: 'text/csv' });
  downloadBlob(exportFilename('csv', nowMs), blob);
}

const PDF_COLUMNS = [
  'System',
  'Controlling Faction',
  'CANO %',
  'CDSR %',
  'Architect',
  'Preferred Faction',
  'Priority',
  'Updated',
] as const;

function pdfRow(record: ExportRecord): string[] {
  return [
    record.systemName,
    record.controllingFaction ?? '—',
    record.canonnInfluence !== null ? record.canonnInfluence.toFixed(1) : '—',
    record.cdsrInfluence !== null ? record.cdsrInfluence.toFixed(1) : '—',
    record.architect ?? '—',
    record.preferredFaction ?? '—',
    record.priorityTier,
    record.freshnessLabel,
  ];
}

/**
 * Exports `rows` as a PDF table report. jsPDF and its autotable plugin are dynamically
 * imported here rather than at module load, so the ~500KB PDF library only ever loads if
 * the user actually asks for a PDF.
 */
export async function exportRowsToPdf(rows: readonly BgsRow[], nowMs: number = Date.now()): Promise<void> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFontSize(14);
  doc.text('Canonn Colony Operations', 14, 16);
  doc.setFontSize(10);
  doc.text(`Exported ${new Date(nowMs).toLocaleString()} — ${rows.length} system${rows.length === 1 ? '' : 's'}`, 14, 22);

  autoTable(doc, {
    startY: 27,
    head: [[...PDF_COLUMNS]],
    body: rows.map(row => pdfRow(toExportRecord(row, nowMs))),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [40, 60, 90] },
  });

  doc.save(exportFilename('pdf', nowMs));
}
