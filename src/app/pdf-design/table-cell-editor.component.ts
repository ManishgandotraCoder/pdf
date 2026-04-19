import {
  Component,
  ElementRef,
  inject,
  input,
  output,
  effect,
  HostBinding,
  HostListener,
} from '@angular/core';

import { SafeHtmlPipe } from './safe-html.pipe';
import { DEFAULT_TABLE_CELL_HTML } from './rich-text.utils';

@Component({
  selector: 'td[appTableCell]',
  standalone: true,
  imports: [SafeHtmlPipe],
  templateUrl: './table-cell-editor.component.html',
})
export class TableCellEditorComponent {
  /** Exposed for template when read-only. */
  readonly defaultCellHtml = DEFAULT_TABLE_CELL_HTML;

  readonly row = input(0);
  readonly col = input(0);
  readonly html = input<string>('');
  readonly readOnly = input(false);

  readonly htmlInput = output<string>();
  readonly cellFocus = output<void>();

  private readonly host = inject(ElementRef<HTMLTableCellElement>);

  @HostBinding('attr.tabindex')
  get tabIndex(): number | null {
    return this.readOnly() ? null : 0;
  }

  @HostBinding('attr.contenteditable')
  get contentEditable(): 'true' | null {
    return this.readOnly() ? null : 'true';
  }

  @HostBinding('style')
  get hostStyle(): Record<string, string> {
    return {
      border: '1px solid #cbd5e1',
      padding: '6px',
      'font-size': '12px',
      color: this.readOnly() ? '#334155' : '#0f172a',
      background: '#ffffff',
      'vertical-align': 'top',
      'text-align': 'left',
      outline: 'none',
      'word-break': 'break-word',
      'min-height': '22px',
    };
  }

  constructor() {
    effect(() => {
      const h = this.html();
      if (this.readOnly()) return;
      const el = this.host.nativeElement;
      if (document.activeElement === el) return;
      const next = h && h.trim() !== '' ? h : DEFAULT_TABLE_CELL_HTML;
      if (el.innerHTML !== next) el.innerHTML = next;
    });
  }

  @HostListener('input')
  onHostInput(): void {
    if (this.readOnly()) return;
    this.htmlInput.emit(this.host.nativeElement.innerHTML);
  }

  @HostListener('focus')
  onHostFocus(): void {
    this.cellFocus.emit();
  }
}
