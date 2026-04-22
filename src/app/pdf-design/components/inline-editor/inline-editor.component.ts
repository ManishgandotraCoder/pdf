import { AfterViewInit, Component, ElementRef, input, output, viewChild } from '@angular/core';

import type { TextElement } from '../../models/pdf-design.models';
import { RichTextToolbarComponent } from '../rich-text-toolbar/rich-text-toolbar.component';
import { isProbablyHtml } from '../../utils/rich-text.utils';

@Component({
  selector: 'app-inline-editor',
  standalone: true,
  imports: [RichTextToolbarComponent],
  templateUrl: './inline-editor.component.html',
})
export class InlineEditorComponent implements AfterViewInit {
  readonly el = input.required<TextElement>();
  readonly pageW = input<number | undefined>(undefined);
  readonly pageH = input<number | undefined>(undefined);
  readonly bgColor = input<string | undefined>(undefined);
  readonly initialValue = input<string | undefined>(undefined);
  readonly fontChoices = input<string[] | undefined>(undefined);

  readonly save = output<string>();
  readonly cancel = output<void>();
  /** Remove PDF text from the page (empty edit + cover overlay — same as canvas ×). */
  readonly resetEdits = output<void>();

  private readonly toolbarWrap = viewChild<ElementRef<HTMLElement>>('toolbarWrap');
  private readonly editable = viewChild<ElementRef<HTMLDivElement>>('editable');

  private measuredToolbarH = 112;

  private toolbarH(): number {
    const h = this.measuredToolbarH;
    return Number.isFinite(h) && h > 20 ? h : 112;
  }

  private toolbarW(): number {
    const e = this.el();
    const w = Math.min(Math.max(e.w + 120, 280), 440);
    const pw = this.pageW();
    if (typeof pw !== 'number' || !Number.isFinite(pw) || pw <= 0) return w;
    return Math.min(w, Math.max(220, pw - 8));
  }

  toolbarLeft(): number {
    const e = this.el();
    const pw = this.pageW();
    const rawLeft = e.x - 1;
    if (typeof pw !== 'number' || !Number.isFinite(pw) || pw <= 0) return rawLeft;
    const w = this.toolbarW();
    return Math.min(Math.max(4, rawLeft), Math.max(4, pw - w - 4));
  }

  toolbarTop(): number {
    const e = this.el();
    const TOOLBAR_H = this.toolbarH();
    const PAD = 4;
    const GAP = 10;
    const rawAbove = e.y - TOOLBAR_H - GAP;
    const rawBelow = e.y + e.h + GAP;
    const ph = this.pageH();
    // Prefer positions that don't overlap the edited text rect.
    let top = rawAbove >= PAD ? rawAbove : rawBelow;
    if (typeof ph !== 'number' || !Number.isFinite(ph) || ph <= 0) return Math.max(PAD, top);

    // Clamp to viewport, but try to avoid covering the text box.
    top = Math.min(Math.max(PAD, top), Math.max(PAD, ph - TOOLBAR_H - PAD));
    const overlapsText = top < e.y + e.h + GAP && top + TOOLBAR_H > e.y - GAP;
    if (overlapsText) {
      // If we're overlapping, pick the side with available room first.
      if (rawAbove >= PAD) top = rawAbove;
      else if (rawBelow + TOOLBAR_H <= ph - PAD) top = rawBelow;
      else {
        // Worst case: keep within bounds but bias away from text.
        top = Math.min(Math.max(PAD, e.y - TOOLBAR_H - GAP), Math.max(PAD, ph - TOOLBAR_H - PAD));
        if (top < e.y + e.h + GAP && top + TOOLBAR_H > e.y - GAP) {
          top = Math.min(Math.max(PAD, e.y + e.h + GAP), Math.max(PAD, ph - TOOLBAR_H - PAD));
        }
      }
    }
    return top;
  }

  minMaxW(): number {
    return this.toolbarW();
  }

  ngAfterViewInit(): void {
    // Measure the real rendered toolbar height so positioning never overlaps content.
    queueMicrotask(() => {
      const w = this.toolbarWrap()?.nativeElement;
      if (!w) return;
      const h = Math.ceil(w.getBoundingClientRect().height);
      if (Number.isFinite(h) && h > 20) this.measuredToolbarH = h;
    });

    const r = this.editable()?.nativeElement;
    if (!r) return;
    const raw = this.initialValue() ?? '';
    const el = this.el();
    if (isProbablyHtml(raw)) {
      r.innerHTML = raw;
    } else {
      const p = document.createElement('p');
      p.style.margin = '0';
      p.style.font = 'inherit';
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = raw;
      r.innerHTML = '';
      r.appendChild(p);
    }
    r.style.fontFamily = el.style.fontFamily || 'sans-serif';
    if (el.style.fontSizePx != null) {
      r.style.fontSize = `${el.style.fontSizePx}px`;
    }
    r.style.fontWeight = el.style.fontWeight || '';
    r.style.fontStyle = el.style.fontStyle || '';
    r.style.color = el.style.color || '';
    r.focus();
    // Select all content so the user can immediately replace or refine the selection
    // (paragraph / line selection is then one Shift+End / Shift+Home away)
    try {
      const sel = globalThis.getSelection?.();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(r);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      /* selection not critical — swallow */
    }
  }

  commit(): void {
    const r = this.editable()?.nativeElement;
    if (!r) return;
    this.save.emit(r.innerHTML);
  }

  onBlur(): void {
    setTimeout(() => {
      const a = document.activeElement;
      if (a?.closest?.('[data-rich-toolbar]')) return;
      this.commit();
    }, 0);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel.emit();
    }
  }

  onResetEditsClick(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    this.resetEdits.emit();
  }
}
