import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { CanonnBgsService } from '../canonn-bgs.service';
import { HistoryRow } from '../data/influence-history';
import { InfluenceChartDialogComponent, InfluenceChartDialogData } from './influence-chart-dialog.component';

function row(faction: string, influence: number, firstSeen: string): HistoryRow {
  return { faction_name: faction, influence, first_seen: firstSeen };
}

const HISTORY: HistoryRow[] = [
  row('Canonn', 0.4, '2026-10-01T00:00:00Z'),
  row('Canonn', 0.5, '2026-10-05T00:00:00Z'),
  row('Canonn', 0.6, '2026-10-10T00:00:00Z'),
  row('Canonn Deep Space Research', 0.1, '2026-10-01T00:00:00Z'),
  row('Canonn Deep Space Research', 0.12, '2026-10-10T00:00:00Z'),
  row('Local Faction', 0.3, '2026-10-01T00:00:00Z'),
  row('Local Faction', 0.2, '2026-10-10T00:00:00Z'),
];

describe('InfluenceChartDialogComponent', () => {
  let fixture: ComponentFixture<InfluenceChartDialogComponent>;
  let service: { getInfluenceHistory: ReturnType<typeof vi.fn> };

  async function open(
    data: Partial<InfluenceChartDialogData> = {},
    history: unknown = HISTORY,
  ): Promise<HTMLElement> {
    if (history instanceof Error) {
      service.getInfluenceHistory.mockRejectedValue(history);
    } else {
      service.getInfluenceHistory.mockResolvedValue(history);
    }
    TestBed.overrideProvider(MAT_DIALOG_DATA, {
      useValue: {
        systemName: 'Varati',
        systemAddress: '358462034634',
        averages: { Canonn: 0.45 },
        highlight: 'Canonn',
        ...data,
      },
    });
    fixture = TestBed.createComponent(InfluenceChartDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  function legendLabels(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('.legend-item .legend-label')).map(e => e.textContent?.trim() ?? '');
  }

  function pointerMove(element: HTMLElement, fraction: number): void {
    const svg = element.querySelector('svg')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 780, height: 340, right: 780, bottom: 340, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: fraction * 780, clientY: 100, bubbles: true }));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    service = { getInfluenceHistory: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [InfluenceChartDialogComponent],
      providers: [
        { provide: CanonnBgsService, useValue: service },
        { provide: MAT_DIALOG_DATA, useValue: {} },
      ],
    }).compileComponents();
  });

  it('asks for the history of the system it was opened for', async () => {
    await open();

    expect(service.getInfluenceHistory).toHaveBeenCalledWith('358462034634');
  });

  it('titles the chart with the system', async () => {
    const element = await open();

    expect(element.querySelector('.chart-title')?.textContent).toContain('Varati');
  });

  it('lists every faction in the legend, ours first, with a dashed average for the tracked ones', async () => {
    const element = await open();

    expect(legendLabels(element)).toEqual(['Canonn', 'CDSR', 'Local Faction', 'Canonn avg']);
    expect(element.querySelectorAll('.legend-swatch--dashed')).toHaveLength(1);
  });

  it('shows each faction\'s latest value in the legend', async () => {
    const element = await open();

    const values = Array.from(element.querySelectorAll('.legend-item .legend-value')).map(e => e.textContent?.trim());
    expect(values).toEqual(['60.0%', '12.0%', '20.0%', '45.0%']);
  });

  it('draws a line for each faction and a dashed one for the average', async () => {
    const element = await open();

    expect(element.querySelectorAll('polyline.series')).toHaveLength(4);
    expect(element.querySelectorAll('polyline.series--dashed')).toHaveLength(1);
  });

  it('draws the faction whose sparkline was clicked heavier', async () => {
    const element = await open({ highlight: 'Canonn' });

    expect(element.querySelectorAll('polyline.series--heavy')).toHaveLength(1);
  });

  it('hides and shows a line from the legend', async () => {
    const element = await open();
    const local = Array.from(element.querySelectorAll<HTMLButtonElement>('.legend-item')).find(b =>
      b.textContent?.includes('Local Faction'),
    )!;

    local.click();
    fixture.detectChanges();
    expect(element.querySelectorAll('polyline.series')).toHaveLength(3);
    expect(local.getAttribute('aria-pressed')).toBe('false');

    local.click();
    fixture.detectChanges();
    expect(element.querySelectorAll('polyline.series')).toHaveLength(4);
  });

  it('reads every visible faction off the snapshot under the pointer, highest first', async () => {
    const element = await open();

    pointerMove(element, 0.02); // the left-hand edge: the first snapshot

    const tooltip = element.querySelector('.chart-tooltip')!;
    expect(tooltip.textContent).toContain('Canonn');
    const values = Array.from(tooltip.querySelectorAll('.tooltip-value')).map(e => e.textContent?.trim());
    expect(values).toEqual(['40.0%', '30.0%', '10.0%']);
    expect(element.querySelectorAll('circle.reading')).toHaveLength(3);
  });

  it('uses the latest reading for a faction between its snapshots', async () => {
    const element = await open();

    pointerMove(element, 0.98); // the last snapshot, where the Canonn line has moved on

    const values = Array.from(element.querySelectorAll('.tooltip-value')).map(e => e.textContent?.trim());
    expect(values).toEqual(['60.0%', '20.0%', '12.0%']);
  });

  it('steps between snapshots with the arrow keys', async () => {
    const element = await open();
    const svg = element.querySelector('svg')!;

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(element.querySelector('.chart-tooltip')).not.toBeNull();

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(element.querySelector('.chart-tooltip')).toBeNull();
  });

  it('says so when the tracker has no history', async () => {
    const element = await open({}, []);

    expect(element.textContent).toContain('no history for this system yet');
    expect(element.querySelector('svg')).toBeNull();
  });

  it('shows the error, with a retry, when the history cannot be loaded', async () => {
    const element = await open({}, new Error('HTTP 500'));

    expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');

    service.getInfluenceHistory.mockResolvedValue(HISTORY);
    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('svg')).not.toBeNull();
  });

  it('does not call the API without an address', async () => {
    const element = await open({ systemAddress: '' });

    expect(service.getInfluenceHistory).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('no address');
  });
});
