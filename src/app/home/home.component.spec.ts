import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CanonnBgsService } from '../canonn-bgs.service';
import { HomeComponent } from './home.component';

describe('HomeComponent tabs', () => {
  let fixture: ComponentFixture<HomeComponent>;

  async function create(): Promise<void> {
    // The data never arrives: only the tab bar is under test.
    const service = { getSystems: () => new Promise(() => {}), loadLog: () => [], getArchitectRegistryRows: async () => [] };
    await TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [{ provide: CanonnBgsService, useValue: service }],
    }).compileComponents();
    fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const labels = (): string[] =>
    Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.mdc-tab')).map(t => t.textContent!.trim());
  const active = (): string =>
    (fixture.nativeElement.querySelector('.mdc-tab--active') as HTMLElement).textContent!.trim();

  async function click(label: string): Promise<void> {
    const tab = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.mdc-tab')).find(
      t => t.textContent!.trim() === label,
    )!;
    tab.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('starts on Priorities', async () => {
    await create();
    expect(labels()).toEqual(['Priorities', 'Architects', 'Factions']);
    expect(active()).toBe('Priorities');
  });

  it('keeps the tabs in a fixed order when clicking between them', async () => {
    await create();
    await click('Factions');
    expect(labels()).toEqual(['Priorities', 'Architects', 'Factions']);
    expect(active()).toBe('Factions');

    await click('Architects');
    expect(labels()).toEqual(['Priorities', 'Architects', 'Factions']);
    expect(active()).toBe('Architects');
  });
});
