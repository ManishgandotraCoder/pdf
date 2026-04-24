import { Component, DestroyRef, ElementRef, inject, input, NgZone, output, signal } from '@angular/core';
import { SelectFieldComponent, SelectFieldOption } from '../../../shared/select-field/select-field.component';

import {
  applyBlockLineHeight,
  applyFontSizePx,
  execRich,
  execRichList,
  expandToAllIfCollapsed,
  getBlockTextAlignValue,
  getParagraphFormatValue,
  getRichTextSelectionFontInfo,
  inferExplicitRichFontStyle,
  inferExplicitRichFontWeight,
  mergeFontOptions,
  promptImageUrlAndInsert,
  promptLinkUrl,
  restoreRichTextSelection,
  saveRichTextSelection,
  setRichCommandState,
} from '../../utils/rich-text.utils';

type AlignValue = 'left' | 'center' | 'right' | 'justify';
type LineSpaceKey = '1' | '1.15' | '1.5' | '2';
type PStyle = 'p' | 'h1' | 'h2' | 'h3' | 'h4';

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
  /** When true, show the Edit control (Claude page analysis + edit mode). */
  readonly showEditClaude = input(false);
  /** Disables the Edit control while a Claude request is in flight. */
  readonly claudePending = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);
  readonly editWithClaude = output<void>();
  /** When set, shows a page zoom control (0.25–1.5 typical) and emits on change. */
  readonly pageZoom = input<number | undefined>(undefined);
  readonly pageZoomChange = output<number>();

  /** Reflects the active selection for font, size, and command state. */
  readonly selectionFontLabel = signal('');
  readonly selectionSizePx = signal<number | null>(null);
  readonly isEditingSize = signal(false);
  readonly sizeDraft = signal('');
  readonly activeBold = signal(false);
  readonly activeItalic = signal(false);
  readonly activeUnderline = signal(false);
  readonly paragraphFormat = signal<PStyle>('p');
  readonly alignValue = signal<AlignValue>('left');
  readonly lineSpaceKey = signal<LineSpaceKey>('1.15');
  readonly toolbarCollapsed = signal(false);

  readonly paragraphOptions = (): SelectFieldOption<PStyle>[] => [
    { value: 'p', label: 'Normal text' },
    { value: 'h1', label: 'Heading 1' },
    { value: 'h2', label: 'Heading 2' },
    { value: 'h3', label: 'Heading 3' },
    { value: 'h4', label: 'Heading 4' },
  ];

  readonly alignOptions = (): SelectFieldOption<AlignValue>[] => [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right', label: 'Right' },
    { value: 'justify', label: 'Justify' },
  ];

  readonly lineSpaceOptions = (): SelectFieldOption<LineSpaceKey>[] => [
    { value: '1', label: 'Single' },
    { value: '1.15', label: '1.15' },
    { value: '1.5', label: '1.5' },
    { value: '2', label: 'Double' },
  ];

  readonly zoomStrOptions = (): SelectFieldOption<string>[] => {
    return ['0.5', '0.75', '1', '1.25', '1.5'].map((v) => ({
      value: v,
      label: `${Math.round(Number.parseFloat(v) * 100)}%`,
    }));
  }

  /** Model string for the zoom &lt;select&gt; (binds to pageZoom). */
  zoomSelectModel(): string {
    const z = this.pageZoom();
    if (z == null) return '1';
    const keys = ['0.5', '0.75', '1', '1.25', '1.5'] as const;
    const best = keys.reduce((a, b) =>
      Math.abs(Number.parseFloat(b) - z) < Math.abs(Number.parseFloat(a) - z) ? b : a,
    );
    return best;
  }

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
    if (info) {
      this.selectionFontLabel.set(info.fontFamily);
      this.selectionSizePx.set(info.fontSizePx);
    }
    this.paragraphFormat.set(this.safePStyle(getParagraphFormatValue()));
    this.alignValue.set(getBlockTextAlignValue());
    try {
      this.activeBold.set(document.queryCommandState('bold'));
      this.activeItalic.set(document.queryCommandState('italic'));
      this.activeUnderline.set(document.queryCommandState('underline'));
    } catch {
      this.activeBold.set(false);
      this.activeItalic.set(false);
      this.activeUnderline.set(false);
    }
  }

  private safePStyle(v: string): PStyle {
    if (v === 'h1' || v === 'h2' || v === 'h3' || v === 'h4' || v === 'p') return v;
    return 'p';
  }

  /** Re-read after execCommand. */
  private syncFromSelectionSoon(): void {
    this.syncFromSelection();
    requestAnimationFrame(() => {
      this.zone.run(() => this.syncFromSelection());
    });
  }

  fonts(): string[] {
    return mergeFontOptions(this.fontChoices());
  }

  fontsForSelect(): string[] {
    const base = this.fonts();
    const cur = this.selectionFontLabel().trim();
    if (!cur) return base;
    if (!base.some((f) => f.toLowerCase() === cur.toLowerCase())) {
      return [cur, ...base];
    }
    return base;
  }

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
    if (px == null) return '';
    const r = Math.round(px * 10) / 10;
    if (r % 1 === 0) return String(Math.round(r));
    return r.toFixed(1);
  }

  onSizeInputFocus(): void {
    if (this.disabled()) return;
    this.isEditingSize.set(true);
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
    this.isEditingSize.set(false);
    this.sizeDraft.set('');
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
    const raw = (e.target as HTMLInputElement).value.trim().replace(/,/g, '.');
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 1 || n > 200) return;
    const rounded = Math.round(n * 10) / 10;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    applyFontSizePx(rounded);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  bumpSize(delta: number): void {
    if (this.disabled()) return;
    const base = this.selectionSizePx() ?? 12;
    const next = Math.max(1, Math.min(200, Math.round((base + delta) * 10) / 10));
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    applyFontSizePx(next);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  onPageZoomStringChange(s: string | number): void {
    const n = parseFloat(String(s));
    if (Number.isFinite(n)) this.pageZoomChange.emit(n);
  }

  onParagraphFormatChange(v: PStyle | ''): void {
    if (!v || this.disabled()) return;
    this.paragraphFormat.set(this.safePStyle(v));
    restoreRichTextSelection();
    const tag = v.toUpperCase();
    execRich('formatBlock', tag);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  onAlignChange(v: AlignValue | ''): void {
    if (!v || this.disabled()) return;
    this.alignValue.set(v);
    const map: Record<AlignValue, string> = {
      left: 'justifyLeft',
      center: 'justifyCenter',
      right: 'justifyRight',
      justify: 'justifyFull',
    };
    const cmd = map[v];
    restoreRichTextSelection();
    execRich(cmd);
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  onLineSpaceChange(v: LineSpaceKey | ''): void {
    if (!v || this.disabled()) return;
    this.lineSpaceKey.set(v);
    restoreRichTextSelection();
    applyBlockLineHeight(v);
    saveRichTextSelection();
  }

  exec(cmd: string, val?: string): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich(cmd, val);
  }

  execList(ordered: boolean): void {
    if (this.disabled()) return;
    execRichList(ordered);
  }

  undo(): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    execRich('undo');
  }

  redo(): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    execRich('redo');
  }

  clearFormat(): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('removeFormat');
    saveRichTextSelection();
    this.syncFromSelectionSoon();
  }

  printPage(): void {
    window.print();
  }

  onForeColor(e: Event): void {
    if (this.disabled()) return;
    const c = (e.target as HTMLInputElement).value;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('foreColor', c);
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

  image(): void {
    if (this.disabled()) return;
    promptImageUrlAndInsert();
  }

  toggleToolbarCollapsed(): void {
    this.toolbarCollapsed.update((c) => !c);
  }

  onEditWithClaude(): void {
    if (this.disabled() || this.claudePending()) return;
    this.editWithClaude.emit();
  }
}
