import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { BgsRow } from '../canonn-bgs.service';

/** The system whose Priority Watchlist entries the dialog explains. */
export interface PriorityWatchlistDialogData {
  row: BgsRow;
}

/**
 * Read-only explanation for why a system is on the Priority Watchlist — opened from the info
 * button next to the System Name column for any row carrying watchlist entries (see
 * `priority-watchlist.ts`).
 */
@Component({
  selector: 'app-priority-watchlist-dialog',
  imports: [MatButtonModule, MatDialogModule],
  templateUrl: './priority-watchlist-dialog.component.html',
  styleUrl: './priority-watchlist-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PriorityWatchlistDialogComponent {
  private readonly data = inject<PriorityWatchlistDialogData>(MAT_DIALOG_DATA);

  protected readonly systemName = this.data.row.systemName;
  protected readonly entries = this.data.row.watchlist;
}
