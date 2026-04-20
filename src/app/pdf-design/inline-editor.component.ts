import { AfterViewInit, Component, ElementRef, input, output, viewChild } from '@angular/core';

import type { TextElement } from './pdf-design.models';
import { RichTextToolbarComponent } from './rich-text-toolbar.component';
import { isProbablyHtml } from './rich-text.utils';

@Component({
  selector: 'app-inline-editor',
  standalone: true,
  imports: [RichTextToolbarComponent],
  templateUrl: './inline-editor.component.html',
})
export class InlineEditorComponent implements AfterViewInit {
  readonly el = input.required<TextElement>();
  readonly bgColor = input<string | undefined>(undefined);
  readonly initialValue = input<string | undefined>(undefined);
  readonly fontChoices = input<string[] | undefined>(undefined);

  readonly save = output<string>();
  readonly cancel = output<void>();

  private readonly editable = viewChild<ElementRef<HTMLDivElement>>('editable');

  toolbarTop(): number {
    const e = this.el();
    return Math.max(4, e.y - 112);
  }

  minMaxW(): number {
    const e = this.el();
    return Math.min(Math.max(e.w + 120, 280), 440);
  }

  ngAfterViewInit(): void {
    const r = this.editable()?.nativeElement;
    if (!r) return;
    const raw = this.initialValue() ?? '';
    if (isProbablyHtml(raw)) r.innerHTML = raw;
    else r.textContent = raw;
    r.focus();
    // Select all content so the user can immediately replace or refine the selection
    // (paragraph / line selection is then one Shift+End / Shift+Home away)
    try {
      const sel = window.getSelection();
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
}
