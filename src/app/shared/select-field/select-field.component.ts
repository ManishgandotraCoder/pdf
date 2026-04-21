import { CommonModule } from '@angular/common';
import { Component, EventEmitter, input, Output } from '@angular/core';

export type SelectFieldOption<T extends string | number = string> =
  | T
  | {
      value: T;
      label: string;
      disabled?: boolean;
    };

type NormalizedOption<T extends string | number> = { value: T; label: string; disabled: boolean };

@Component({
  selector: 'app-select-field',
  standalone: true,
  imports: [CommonModule],
  template: `
    <label class="sf">
      @if (label()) {
        <span class="sf__label">{{ label() }}</span>
      }

      <span class="sf__control" [class.sf__control--disabled]="disabled()">
        <select
          class="sf__select"
          [disabled]="disabled()"
          [attr.aria-label]="ariaLabel() || label() || null"
          [value]="value()"
          (change)="onNativeChange($event)"
        >
          @if (placeholder()) {
            <option value="" disabled>{{ placeholder() }}</option>
          }
          @for (opt of normalizedOptions(); track opt.value) {
            <option [value]="opt.value" [disabled]="opt.disabled">{{ opt.label }}</option>
          }
        </select>

        <svg class="sf__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>

      @if (error()) {
        <span class="sf__meta sf__meta--error">{{ error() }}</span>
      } @else if (hint()) {
        <span class="sf__meta">{{ hint() }}</span>
      }
    </label>
  `,
})
export class SelectFieldComponent<T extends string | number = string> {
  readonly label = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly placeholder = input<string | null>(null);

  readonly disabled = input(false);
  readonly options = input<SelectFieldOption<T>[]>([]);
  readonly value = input<T | ''>('');

  @Output() readonly valueChange = new EventEmitter<T | ''>();

  normalizedOptions(): NormalizedOption<T>[] {
    return (this.options() ?? []).map((o) => {
      if (typeof o === 'string' || typeof o === 'number') {
        return { value: o as any, label: String(o), disabled: false };
      }
      return { value: o.value, label: o.label, disabled: !!o.disabled };
    });
  }

  onNativeChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    // We intentionally emit strings since DOM values are strings; callers can map if needed.
    this.valueChange.emit(v as any);
  }
}

