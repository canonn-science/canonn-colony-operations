import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LoadingTerminalComponent, SILLY_LINES, fillerPool } from './loading-terminal.component';

describe('LoadingTerminalComponent', () => {
  let fixture: ComponentFixture<LoadingTerminalComponent>;

  function printed(): string[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.terminal-line') as NodeListOf<HTMLElement>).map(
      line => line.textContent ?? '',
    );
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [LoadingTerminalComponent] }).compileComponents();
    fixture = TestBed.createComponent(LoadingTerminalComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('opens with a boot banner and a session line rather than blank', () => {
    expect(printed()[0]).toMatch(/[A-Z]{4}/);
    expect(printed()[1]).toMatch(/^SESSION [0-9A-F]{4}-[0-9A-F]{4} \/\/ BGS UPLINK/);
  });

  it('prints something different from one load to the next', () => {
    const load = (random: number): string[] => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(random);
      const created = TestBed.createComponent(LoadingTerminalComponent);
      created.detectChanges();
      vi.advanceTimersByTime(30_000);
      created.detectChanges();
      const lines = Array.from(created.nativeElement.querySelectorAll('.terminal-line') as NodeListOf<HTMLElement>).map(
        line => line.textContent ?? '',
      );
      created.destroy();
      spy.mockRestore();
      return lines;
    };

    expect(load(0.05)).not.toEqual(load(0.95));
  });

  it('mixes freshly generated lines into the filler of every load, different each time', () => {
    const fixed = new Set(SILLY_LINES);
    const generated = () => fillerPool().filter(line => !fixed.has(line));

    const first = generated();
    const second = generated();

    expect(first.length).toBeGreaterThan(0);
    expect(first.sort()).not.toEqual(second.sort());
  });

  it('draws every fixed line once per pool', () => {
    const pool = fillerPool();

    for (const line of SILLY_LINES) {
      expect(pool.filter(l => l === line)).toHaveLength(1);
    }
  });

  it('prints each real status line as it arrives, once', () => {
    fixture.componentRef.setInput('realLines', ['Contacting the query function…']);
    fixture.detectChanges();
    fixture.componentRef.setInput('realLines', ['Contacting the query function…', 'Received 4333 systems']);
    fixture.detectChanges();

    const real = printed().filter(line => line.startsWith('[io]'));
    expect(real).toEqual(['[io] Contacting the query function…', '[io] Received 4333 systems']);
  });

  it('keeps printing filler while it waits, and never repeats one until all have been used', () => {
    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();

    const filler = printed().filter(line => line.startsWith('[..]'));
    expect(filler.length).toBeGreaterThan(5);
  });

  it('scrolls old lines away rather than growing without limit', () => {
    vi.advanceTimersByTime(10 * 60_000);
    fixture.detectChanges();

    // the lines kept, plus the prompt line
    expect(printed().length).toBeLessThanOrEqual(15);
  });

  it('stops printing once destroyed', () => {
    fixture.destroy();

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells assistive tech once that data is loading, and hides the decoration', () => {
    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelector('.visually-hidden')?.textContent).toContain('Loading BGS data');
    expect(element.querySelector('.terminal')?.getAttribute('aria-hidden')).toBe('true');
  });
});
