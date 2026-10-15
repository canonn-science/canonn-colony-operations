import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { BgsRow, StationDetail } from '../canonn-bgs.service';
import { describePowerplayInfluence } from '../data/powerplay';

/** Stations with "canonn" in their name first (stable otherwise), matching {@link BgsRow.hasCanonnStation}. */
function sortStationsCanonnFirst(stations: readonly StationDetail[]): StationDetail[] {
  return [...stations].sort((a, b) => Number(/canonn/i.test(b.name)) - Number(/canonn/i.test(a.name)));
}

/** The system whose info the dialog shows. */
export interface PriorityWatchlistDialogData {
  row: BgsRow;
}

/**
 * Read-only info for a system — opened from the info button next to the System Name column,
 * on every row. Systems on the Priority Watchlist (the "System Info" list) show their watchlist
 * entries under Information; every system shows its controlling faction, population, station
 * and body counts, and a table of its factions (see `priority-watchlist.ts`).
 */
@Component({
  selector: 'app-priority-watchlist-dialog',
  imports: [DecimalPipe, MatButtonModule, MatDialogModule],
  templateUrl: './priority-watchlist-dialog.component.html',
  styleUrl: './priority-watchlist-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PriorityWatchlistDialogComponent {
  private readonly data = inject<PriorityWatchlistDialogData>(MAT_DIALOG_DATA);

  protected readonly row = this.data.row;
  protected readonly stations = sortStationsCanonnFirst(this.data.row.stations);
  protected readonly entries = this.data.row.watchlist;
  protected readonly powerplay = this.data.row.powerplay;
  /** The powerplay section's explanation paragraphs; empty when no power is pledged here. */
  protected readonly powerNotes = this.powerplay ? describePowerplayInfluence(this.powerplay, this.row) : [];
  /** The note shown under Information when the system has Canonn-named assets but no System Info text. */
  protected readonly canonnAssetsNote =
    'This system contains stations named after Canonn that we want to be under Canonn control.';
}
