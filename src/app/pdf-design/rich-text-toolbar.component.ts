import { Component, ElementRef, inject, input } from '@angular/core';

import {
  applyFontSizePx,
  execRich,
  FONT_SIZE_PX_LIST,
  mergeFontOptions,
  promptLinkUrl,
  restoreRichTextSelection,
  saveRichTextSelection,
} from './rich-text.utils';

@Component({
  selector: 'app-rich-text-toolbar',
  standalone: true,
  templateUrl: './rich-text-toolbar.component.html',
})
export class RichTextToolbarComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly disabled = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);

  constructor() {
    this.host.nativeElement.addEventListener(
      'mousedown',
      () => {
        if (!this.disabled()) saveRichTextSelection();
      },
      { capture: true },
    );
  }

  fonts(): string[] {
    return mergeFontOptions(this.fontChoices());
  }

  onFontChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    restoreRichTextSelection();
    execRich('fontName', v);
    sel.selectedIndex = 0;
  }

  onSizeChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
    if (v) applyFontSizePx(v);
    sel.selectedIndex = 0;
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
    execRich(cmd, val);
  }

  onForeColor(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    execRich('foreColor', (e.target as HTMLInputElement).value);
  }

  onBackColor(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    execRich('backColor', (e.target as HTMLInputElement).value);
  }

  onHilite(e: Event): void {
    if (this.disabled()) return;
    restoreRichTextSelection();
    const v = (e.target as HTMLInputElement).value;
    if (!execRich('hiliteColor', v)) execRich('backColor', v);
  }

  link(): void {
    if (this.disabled()) return;
    promptLinkUrl();
  }

  readonly sizes = FONT_SIZE_PX_LIST;
}
