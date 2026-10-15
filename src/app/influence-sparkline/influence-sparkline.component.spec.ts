import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InfluenceSparklineComponent } from './influence-sparkline.component';

describe('InfluenceSparklineComponent', () => {
  let fixture: ComponentFixture<InfluenceSparklineComponent>;

  function render(values: number[]): HTMLElement {
    fixture.componentRef.setInput('values', values);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  function points(element: HTMLElement): [number, number][] {
    const attribute = element.querySelector('polyline')?.getAttribute('points') ?? '';
    return attribute
      .split(' ')
      .filter(Boolean)
      .map(pair => pair.split(',').map(Number) as [number, number]);
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InfluenceSparklineComponent] }).compileComponents();
    fixture = TestBed.createComponent(InfluenceSparklineComponent);
  });

  it('draws nothing for an empty series', () => {
    expect(render([]).querySelector('svg')).toBeNull();
  });

  it('draws a line through every value with a dot on the latest', () => {
    const element = render([10, 20, 15, 30]);

    expect(points(element)).toHaveLength(4);
    const dot = element.querySelector('circle')!;
    const last = points(element)[3];
    expect(Number(dot.getAttribute('cx'))).toBeCloseTo(last[0], 0);
    expect(Number(dot.getAttribute('cy'))).toBeCloseTo(last[1], 0);
  });

  it('runs left to right, oldest to newest', () => {
    const xs = points(render([10, 20, 30])).map(p => p[0]);

    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBeLessThan(xs[2]);
  });

  it('draws a rising series rising: a larger value is higher up (smaller y)', () => {
    const ys = points(render([10, 30])).map(p => p[1]);

    expect(ys[1]).toBeLessThan(ys[0]);
  });

  it('keeps a flat series flat', () => {
    const ys = points(render([40, 40, 40])).map(p => p[1]);

    expect(new Set(ys).size).toBe(1);
  });

  it('puts a lone value as a dot at the right-hand end, with no line', () => {
    const element = render([55]);

    expect(element.querySelector('polyline')).toBeNull();
    expect(Number(element.querySelector('circle')!.getAttribute('cx'))).toBeGreaterThan(40);
  });

  it('is hidden from assistive tech — the percentage beside it says the same thing in words', () => {
    expect(render([1, 2]).querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
