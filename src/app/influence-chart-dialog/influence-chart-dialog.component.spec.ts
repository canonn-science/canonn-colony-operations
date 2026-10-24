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
  let service: { getInfluenceHistory: ReturnType<typeof vi.fn>; getSystemConflicts: ReturnType<typeof vi.fn> };

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
    await new Promise(resolve => setTimeout(resolve)); // the history and the conflicts are two awaits
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
    service = { getInfluenceHistory: vi.fn(), getSystemConflicts: vi.fn().mockResolvedValue([]) };
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

  it('shades each war and election, and says what was on at the hovered snapshot', async () => {
    service.getSystemConflicts.mockResolvedValue([
      {
        war_type: 'war',
        status: 'active',
        faction_a: 'Canonn',
        faction_b: 'Local Faction',
        first_seen: '2026-10-08T00:00:00Z',
        ended_at: null,
        won_days_a: 3,
        won_days_b: 1,
      },
      {
        war_type: 'election',
        status: 'ended',
        faction_a: 'Canonn Deep Space Research',
        faction_b: 'Local Faction',
        first_seen: '2026-10-01T00:00:00Z',
        ended_at: '2026-10-04T00:00:00Z',
        outcome: 'Canonn Deep Space Research_won',
      },
    ]);
    const element = await open();

    expect(element.querySelectorAll('rect.band')).toHaveLength(2);
    expect(element.querySelectorAll('rect.band--election')).toHaveLength(1);

    pointerMove(element, 0.02); // 1 Oct: only the election is on
    expect(element.querySelector('.tooltip-conflict')?.textContent).toContain('Election: CDSR vs Local Faction — CDSR won');

    pointerMove(element, 0.98); // 10 Oct: the war is running
    expect(element.querySelector('.tooltip-conflict')?.textContent).toContain('War: Canonn vs Local Faction — latest 3–1 days');
  });

  it('still draws the chart when the conflicts cannot be had', async () => {
    service.getSystemConflicts.mockRejectedValue(new Error('HTTP 500'));
    const element = await open();

    expect(element.querySelectorAll('polyline.series')).toHaveLength(4);
    expect(element.querySelectorAll('rect.band')).toHaveLength(0);
  });

  it('zooms to a dragged selection and resets', async () => {
    const element = await open();
    const svg = element.querySelector('svg')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 780, height: 340, right: 780, bottom: 340, x: 0, y: 0, toJSON: () => ({}) });
    svg.setPointerCapture = () => undefined;
    const fire = (type: string, clientX: number): void => {
      svg.dispatchEvent(new PointerEvent(type, { clientX, button: 0, bubbles: true }));
      fixture.detectChanges();
    };

    fire('pointerdown', 100);
    fire('pointermove', 300);
    expect(element.querySelector('rect.selection')).not.toBeNull();
    fire('pointerup', 300);
    expect(element.querySelector('rect.selection')).toBeNull();
    expect(element.textContent).toContain('Reset zoom');

    element.querySelector<HTMLButtonElement>('.chart-hint button')!.click();
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Reset zoom');
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
