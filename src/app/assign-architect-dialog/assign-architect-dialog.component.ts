import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { BgsRow, CANONN_FACTION, CDSR_FACTION, CanonnBgsService } from '../canonn-bgs.service';
import {
  AFFILIATION_CANONN_MEMBER,
  AFFILIATION_NOT_A_COLONY,
  AFFILIATION_OPTIONS,
  AFFILIATION_UNKNOWN,
  ArchitectSubmission,
} from '../data/architect-form';
import { ArchitectRegistryRow, architectNames, findArchitectProfile, suggestArchitects } from '../data/architect-registry';

/** The system the dialog is assigning an architect to. */
export interface AssignArchitectDialogData {
  row: BgsRow;
}

/** The `preferredFaction` value meaning "Don't know" — sent to the form as no answer at all. */
const DONT_KNOW_FACTION = '';

/** localStorage key the reporting commander's own name is remembered under. */
const YOUR_NAME_KEY = 'canonn-bgs:your-name:v1';

const CANONN_FACTION_NAMES: ReadonlySet<string> = new Set([CANONN_FACTION, CDSR_FACTION]);

const KNOWN_AFFILIATIONS: ReadonlySet<string> = new Set(AFFILIATION_OPTIONS.map(option => option.value));

/** Where a defaulted preferred faction came from, shown beneath the control. */
interface FactionDefault {
  value: string;
  note: string | null;
}

/**
 * Registers an architect for a system without leaving the table.
 *
 * This replaces opening the Architect Registry Google Form in a new window: the user no longer
 * has to copy details between the two, and because the submitted values are folded back into
 * the loaded table (see {@link CanonnBgsService.recordAssignment}) the new architect appears
 * immediately instead of whenever Google next republishes the response sheet.
 *
 * Closes with the {@link ArchitectSubmission} that was accepted, or `undefined` on cancel.
 */
@Component({
  selector: 'app-assign-architect-dialog',
  imports: [
    ReactiveFormsModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  templateUrl: './assign-architect-dialog.component.html',
  styleUrl: './assign-architect-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssignArchitectDialogComponent {
  private readonly bgsService = inject(CanonnBgsService);
  private readonly dialogRef = inject(MatDialogRef<AssignArchitectDialogComponent, ArchitectSubmission>);
  private readonly data = inject<AssignArchitectDialogData>(MAT_DIALOG_DATA);

  protected readonly systemName = this.data.row.systemName;
  protected readonly affiliationOptions = AFFILIATION_OPTIONS;
  protected readonly dontKnowFaction = DONT_KNOW_FACTION;
  protected readonly notAColony = AFFILIATION_NOT_A_COLONY;

  protected readonly form = new FormGroup({
    yourName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(120)],
    }),
    affiliation: new FormControl(AFFILIATION_UNKNOWN, { nonNullable: true, validators: [Validators.required] }),
    architect: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(120)] }),
    preferredFaction: new FormControl(DONT_KNOW_FACTION, { nonNullable: true }),
  });

  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);
  /** True once a send has failed, so the button offers a retry rather than a fresh submit. */
  protected readonly canRetry = signal(false);
  protected readonly registryLoading = signal(true);

  private readonly registry = signal<readonly ArchitectRegistryRow[]>([]);
  private readonly knownArchitects = computed(() => architectNames(this.registry()));

  /**
   * The form's values as signals, so the defaulting below can be expressed as computeds. They
   * mirror the controls (which stay the source of truth) via their `valueChanges`.
   */
  private readonly architectValue = signal('');
  private readonly affiliationValue = signal(AFFILIATION_UNKNOWN);
  private readonly factionValue = signal(DONT_KNOW_FACTION);

  /**
   * Set once the user changes a dropdown themselves, which stops the defaulting effects below
   * from overwriting their choice as they carry on editing the architect name.
   */
  private affiliationChosenByUser = false;
  private factionChosenByUser = false;

  protected readonly architectSuggestions = computed(() =>
    suggestArchitects(this.knownArchitects(), this.architectValue()),
  );

  /** What the registry already knows about the typed architect from *other* systems. */
  protected readonly profile = computed(() =>
    findArchitectProfile(this.registry(), this.architectValue(), this.systemName),
  );

  /** Canonn/CDSR, whichever has more influence in this system — the default for a Canonn architect. */
  private readonly dominantCanonnFaction = computed(
    () => this.data.row.factions.find(faction => CANONN_FACTION_NAMES.has(faction.name))?.name ?? null,
  );

  private readonly factionDefault = computed<FactionDefault>(() => {
    if (this.affiliationValue() === AFFILIATION_CANONN_MEMBER) {
      const canonn = this.dominantCanonnFaction();
      if (canonn) {
        return { value: canonn, note: `The Canonn faction with the highest influence in ${this.systemName}.` };
      }
      return { value: DONT_KNOW_FACTION, note: null };
    }

    const profile = this.profile();
    if (profile?.preferredFaction) {
      const times = profile.preferredFactionCount === 1 ? 'once' : `${profile.preferredFactionCount} times`;
      return {
        value: profile.preferredFaction,
        note: `${profile.name} has chosen ${profile.preferredFaction} ${times} in other systems.`,
      };
    }
    return { value: DONT_KNOW_FACTION, note: null };
  });

  /** The factions present in this system, plus a defaulted faction from elsewhere if there is one. */
  protected readonly factionOptions = computed<string[]>(() => {
    const names = this.data.row.factions.map(faction => faction.name);
    const defaulted = this.factionDefault().value;
    if (defaulted && !names.includes(defaulted)) {
      names.push(defaulted);
    }
    return names;
  });

  /** The explanation for a defaulted faction — hidden once the selection no longer matches it. */
  protected readonly factionNote = computed(() => {
    const fallback = this.factionDefault();
    return fallback.value === this.factionValue() ? fallback.note : null;
  });

  /** The form requires an architect name, except when the answer is "nobody" (see {@link submission}). */
  protected readonly architectRequired = computed(() => this.affiliationValue() !== AFFILIATION_NOT_A_COLONY);

  constructor() {
    this.form.controls.yourName.setValue(this.readYourName());

    const controls = this.form.controls;
    controls.architect.valueChanges.pipe(takeUntilDestroyed()).subscribe(value => this.architectValue.set(value));
    controls.affiliation.valueChanges.pipe(takeUntilDestroyed()).subscribe(value => this.affiliationValue.set(value));
    controls.preferredFaction.valueChanges.pipe(takeUntilDestroyed()).subscribe(value => this.factionValue.set(value));

    void this.loadRegistry();

    // Pre-select a known architect's most recent affiliation, until the user picks one themselves.
    effect(() => {
      const recorded = this.profile()?.affiliation;
      if (this.affiliationChosenByUser) {
        return;
      }
      const value = recorded && KNOWN_AFFILIATIONS.has(recorded) ? recorded : AFFILIATION_UNKNOWN;
      this.setAffiliation(value);
    });

    // Keep the preferred faction on its default as the architect and affiliation change.
    effect(() => {
      const value = this.factionDefault().value;
      if (!this.factionChosenByUser) {
        this.setFaction(value);
      }
    });

    // Requiring the architect name depends on the affiliation, so it's re-applied on change.
    effect(() => {
      const control = this.form.controls.architect;
      const validators = this.architectRequired()
        ? [Validators.required, Validators.maxLength(120)]
        : [Validators.maxLength(120)];
      control.setValidators(validators);
      control.updateValueAndValidity({ emitEvent: false });
    });

    // A system that isn't a colony has no architect to name — enforce that by clearing and
    // locking the field rather than just relying on the submission to blank it out.
    effect(() => {
      const control = this.form.controls.architect;
      const notAColony = this.affiliationValue() === AFFILIATION_NOT_A_COLONY;
      if (notAColony) {
        if (control.value !== '') {
          control.setValue('', { emitEvent: false });
          this.architectValue.set('');
        }
        if (control.enabled) {
          control.disable({ emitEvent: false });
        }
      } else if (control.disabled) {
        control.enable({ emitEvent: false });
      }
    });
  }

  protected onAffiliationChosen(): void {
    this.affiliationChosenByUser = true;
  }

  protected onFactionChosen(): void {
    this.factionChosenByUser = true;
  }

  protected cancel(): void {
    if (!this.sending()) {
      this.dialogRef.close();
    }
  }

  /**
   * Submits the form. On failure the dialog stays open with everything the user typed intact,
   * so the Retry button can send exactly the same submission again.
   */
  protected async send(): Promise<void> {
    if (this.sending()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const submission = this.submission();
    this.sending.set(true);
    this.sendError.set(null);
    // Don't let an Escape/backdrop click discard a submission that's already on the wire.
    this.dialogRef.disableClose = true;
    try {
      await this.bgsService.submitAssignment(submission);
      this.bgsService.recordAssignment(submission);
      this.writeYourName(submission.yourName);
      this.dialogRef.close(submission);
    } catch (error) {
      this.sendError.set(
        error instanceof Error && error.name === 'AbortError'
          ? 'The submission timed out before Google accepted it. Nothing has been recorded — you can retry.'
          : "Couldn't submit to the Architect Registry. Check your connection and retry.",
      );
      this.canRetry.set(true);
    } finally {
      this.sending.set(false);
      this.dialogRef.disableClose = false;
    }
  }

  private submission(): ArchitectSubmission {
    const value = this.form.getRawValue();
    return {
      yourName: value.yourName.trim(),
      systemName: this.systemName,
      // The architect control is cleared and locked whenever "not a colony" is chosen (see
      // the effect above), so there's nothing to trim here — it's already blank.
      architect: value.affiliation === AFFILIATION_NOT_A_COLONY ? '' : value.architect.trim(),
      affiliation: value.affiliation,
      preferredFaction: value.preferredFaction,
    };
  }

  private async loadRegistry(): Promise<void> {
    try {
      // Already loaded for the table in practice, so this normally resolves without a request.
      this.registry.set(await this.bgsService.getArchitectRegistry());
    } catch {
      // Suggestions and defaults are conveniences; the form is still perfectly usable without them.
    } finally {
      this.registryLoading.set(false);
    }
  }

  private setAffiliation(value: string): void {
    if (this.form.controls.affiliation.value !== value) {
      this.form.controls.affiliation.setValue(value);
    }
  }

  private setFaction(value: string): void {
    if (this.form.controls.preferredFaction.value !== value) {
      this.form.controls.preferredFaction.setValue(value);
    }
  }

  private readYourName(): string {
    try {
      return localStorage.getItem(YOUR_NAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private writeYourName(name: string): void {
    try {
      localStorage.setItem(YOUR_NAME_KEY, name);
    } catch {
      // Storage unavailable (e.g. private browsing) — the name just won't be remembered.
    }
  }
}
