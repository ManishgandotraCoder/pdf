import { Component, DestroyRef, ElementRef, inject, input, NgZone, signal } from '@angular/core';
import { SelectFieldComponent } from '../../../shared/select-field/select-field.component';

import {
  applyFontSizePx,
  execRich,
  execRichList,
  expandToAllIfCollapsed,
  getRichTextSelectionFontInfo,
  inferExplicitRichFontStyle,
  inferExplicitRichFontWeight,
  mergeFontOptions,
  promptLinkUrl,
  restoreRichTextSelection,
  saveRichTextSelection,
  setRichCommandState,
} from '../../utils/rich-text.utils';

@Component({
  selector: 'app-rich-text-toolbar',
  standalone: true,
  imports: [SelectFieldComponent],
  templateUrl: './rich-text-toolbar.component.html',
})
export class RichTextToolbarComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  readonly disabled = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);

  /** Reflects the active selection so font/size are visible after applying styles. */
  readonly selectionFontLabel = signal('');
  readonly selectionSizePx = signal<number | null>(null);
  readonly isEditingSize = signal(false);
  readonly sizeDraft = signal('');

  constructor() {
    const hostEl = this.host.nativeElement;
    const onHostMouseDown = () => {
      if (!this.disabled()) saveRichTextSelection();
    };
    this.zone.runOutsideAngular(() => {
      hostEl.addEventListener('mousedown', onHostMouseDown, { capture: true });
    });
    this.destroyRef.onDestroy(() => hostEl.removeEventListener('mousedown', onHostMouseDown, { capture: true } as any));

    if (typeof document !== 'undefined') {
      const onSel = () => this.zone.run(() => this.scheduleSyncFromSelection());
      this.zone.runOutsideAngular(() => {
        document.addEventListener('selectionchange', onSel, { passive: true } as any);
      });
      this.destroyRef.onDestroy(() => document.removeEventListener('selectionchange', onSel as any));
    }
  }

  private scheduleSyncFromSelection(): void {
    if (this.disabled()) return;
    if (this.isEditingSize()) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncFromSelection();
    }, 60);
  }

  private syncFromSelection(): void {
    if (this.disabled()) return;
    if (this.isEditingSize()) return;
    const info = getRichTextSelectionFontInfo();
    if (!info) return;
    this.selectionFontLabel.set(info.fontFamily);
    this.selectionSizePx.set(info.fontSizePx);
  }

  /** Re-read after execCommand so wrapped font nodes are in the DOM. */
  private syncFromSelectionSoon(): void {
    this.syncFromSelection();
    requestAnimationFrame(() => {
      this.zone.run(() => this.syncFromSelection());
    });
  }

  fonts(): string[] {
    return mergeFontOptions(this.fontChoices());
  }

  /**
   * Options for the font dropdown, including the current face when it is not in the merged list
   * (e.g. pasted content), so [value] can match and show the real name.
   */
  fontsForSelect(): string[] {
    const base = this.fonts();
    const cur = this.selectionFontLabel().trim();
    if (!cur) return base;
    if (!base.some((f) => f.toLowerCase() === cur.toLowerCase())) {
      return [cur, ...base];
    }
    return base;
  }

  /** Value bound to the font dropdown (must match an option value). */
  fontSelectModel(): string {
    const raw = this.selectionFontLabel().trim();
    if (!raw) return '';
    const opts = this.fontsForSelect();
    const hit = opts.find((f) => f.toLowerCase() === raw.toLowerCase());
    return hit ?? raw;
  }

  sizeInputModel(): string {
    if (this.isEditingSize()) return this.sizeDraft();
    const px = this.selectionSizePx();
    return px == null ? '' : String(px);
  }

  onSizeInputFocus(): void {
    if (this.disabled()) return;
    this.isEditingSize.set(true);
    // Seed the draft so typing starts from current value, but do not force it if already set.
    if (!this.sizeDraft()) this.sizeDraft.set(this.sizeInputModel());
  }

  onSizeInput(e: Event): void {
    if (this.disabled()) return;
    this.sizeDraft.set((e.target as HTMLInputElement).value);
  }

  onSizeInputKeydown(e: KeyboardEvent): void {
    if (this.disabled()) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.onSizeInputCommit(e);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.sizeDraft.set('');
      this.isEditingSize.set(false);
      (e.target as HTMLInputElement).blur();
      this.syncFromSelectionSoon();
    }
  }

  onSizeInputBlur(): void {
    if (this.disabled()) return;
    // `change` will also fire on blur, but blur should always end editing mode.
    this.isEditingSize.set(false);
    this.sizeDraft.set('');
    this.syncFromSelectionSoon();
  }

  onFontChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    if (!v) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('fontName', v);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  onFontValueChange(v: string): void {
    if (!v) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('fontName', v);
    const explicitWeight = inferExplicitRichFontWeight(v);
    if (explicitWeight) setRichCommandState('bold', explicitWeight === 'bold');
    const explicitStyle = inferExplicitRichFontStyle(v);
    if (explicitStyle) setRichCommandState('italic', explicitStyle === 'italic');
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  onSizeInputCommit(e: Event): void {
    if (this.disabled()) return;
    const raw = (e.target as HTMLInputElement).value.trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    applyFontSizePx(n);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  btn(
    label: string,
    title: string,
    onClick: () => void,
    extra: { bold?: boolean; italic?: boolean; underline?: boolean } = {},
  ): void {
    if (this.disabled()) return;
    onClick();
  }

  exec(cmd: string, val?: string): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich(cmd, val);
  }

  /** Lists: do not use expandToAllIfCollapsed (breaks list insertion); execRichList handles collapse. */
  execList(ordered: boolean): void {
    if (this.disabled()) return;
    execRichList(ordered);
  }

  onForeColor(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('foreColor', (e.target as HTMLInputElement).value);
  }

  onBackColor(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('backColor', (e.target as HTMLInputElement).value);
  }

  onHilite(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    const v = (e.target as HTMLInputElement).value;
    if (!execRich('hiliteColor', v)) execRich('backColor', v);
  }

  link(): void {
    if (this.disabled()) return;
    promptLinkUrl();
  }
}
