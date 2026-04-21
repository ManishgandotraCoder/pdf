import { Component, ElementRef, inject, input, NgZone, signal } from '@angular/core';

import {
  applyFontSizePx,
  execRich,
  expandToAllIfCollapsed,
  FONT_SIZE_PX_LIST,
  mergeFontOptions,
  promptLinkUrl,
  restoreRichTextSelection,
  saveRichTextSelection,
} from './rich-text.utils';

function readCaretFontInfo(): { fontFamily: string; fontSizePx: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (!el) return null;
  const root = el.closest('[contenteditable="true"]');
  if (!root || !root.contains(el)) return null;
  const cs = getComputedStyle(el);
  const fontFamily = (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
  const fontSizePx = Math.round(parseFloat(cs.fontSize) || 12);
  return { fontFamily, fontSizePx };
}

@Component({
  selector: 'app-rich-text-toolbar',
  standalone: true,
  templateUrl: './rich-text-toolbar.component.html',
})
export class RichTextToolbarComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  readonly disabled = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);

  /** Reflects the active selection so font/size are visible after applying styles. */
  readonly selectionFontLabel = signal('');
  readonly selectionSizePx = signal<number | null>(null);

  constructor() {
    this.host.nativeElement.addEventListener(
      'mousedown',
      () => {
        if (!this.disabled()) saveRichTextSelection();
      },
      { capture: true },
    );
    if (typeof document !== 'undefined') {
      document.addEventListener('selectionchange', () => {
        this.zone.run(() => this.scheduleSyncFromSelection());
      });
    }
  }

  private scheduleSyncFromSelection(): void {
    if (this.disabled()) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncFromSelection();
    }, 60);
  }

  private syncFromSelection(): void {
    if (this.disabled()) return;
    const info = readCaretFontInfo();
    if (!info) return;
    this.selectionFontLabel.set(info.fontFamily);
    this.selectionSizePx.set(info.fontSizePx);
  }

  fonts(): string[] {
    return mergeFontOptions(this.fontChoices());
  }

  onFontChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    execRich('fontName', v);
    sel.selectedIndex = 0;
    this.syncFromSelection();
  }

  onSizeChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    if (v) {
      restoreRichTextSelection();
      expandToAllIfCollapsed();
      applyFontSizePx(v);
    }
    sel.selectedIndex = 0;
    this.syncFromSelection();
  }

  onSizeInputCommit(e: Event): void {
    if (this.disabled()) return;
    const raw = (e.target as HTMLInputElement).value;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 999) return;
    restoreRichTextSelection();
    expandToAllIfCollapsed();
    applyFontSizePx(n);
    this.syncFromSelection();
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

  readonly sizes = FONT_SIZE_PX_LIST;
}
