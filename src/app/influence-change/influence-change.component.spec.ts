import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InfluenceChange } from '../data/influence-change';
import { InfluenceChangeComponent } from './influence-change.component';

describe('InfluenceChangeComponent', () => {
  let fixture: ComponentFixture<InfluenceChangeComponent>;

  function render(change: InfluenceChange | null): HTMLElement {
    fixture.componentRef.setInput('change', change);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  const gain: InfluenceChange = { points: 2.7, window: '7d', direction: 'up', perDay: 0.4, spanDays: 6.5 };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InfluenceChangeComponent] }).compileComponents();
    fixture = TestBed.createComponent(InfluenceChangeComponent);
  });

  it('shows a green up arrow with the signed points and the window', () => {
    const element = render(gain);
    const badge = element.querySelector('.change')!;

    expect(badge.textContent).toContain('▲ +2.7 7d');
    expect(badge.classList.contains('change--up')).toBe(true);
    expect(badge.classList.contains('change--down')).toBe(false);
  });

  it('shows a red down arrow for a loss', () => {
    const element = render({ points: -1.2, window: '24h', direction: 'down', perDay: -1.2, spanDays: 1 });
    const badge = element.querySelector('.change')!;

    expect(badge.textContent).toContain('▼ -1.2 24h');
    expect(badge.classList.contains('change--down')).toBe(true);
  });

  it('shows a neutral arrow for a steady faction', () => {
    const element = render({ points: 0, window: '7d', direction: 'flat', perDay: 0, spanDays: 7 });
    const badge = element.querySelector('.change')!;

    expect(badge.textContent).toContain('▶ 0.0 7d');
    expect(badge.classList.contains('change--up')).toBe(false);
    expect(badge.classList.contains('change--down')).toBe(false);
  });

  it('puts the rate and the history it rests on in the tooltip', () => {
    const badge = render(gain).querySelector('.change')!;

    expect(badge.getAttribute('title')).toBe('+2.7 points over 7d (+0.4 per day, from 6.5 days of history)');
  });

  it('gives assistive tech the meaning in words, not the arrow', () => {
    const element = render(gain);

    expect(element.querySelector('[aria-hidden="true"]')?.textContent).toContain('▲');
    expect(element.querySelector('.visually-hidden')?.textContent).toContain('+2.7 points over 7d');
  });

  it('shows a dash, with an explanation, when there is not enough history', () => {
    const badge = render(null).querySelector('.change')!;

    expect(badge.textContent?.trim()).toBe('–');
    expect(badge.getAttribute('title')).toBe('Not enough history yet');
  });
});
