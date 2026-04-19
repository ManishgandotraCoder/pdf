import { Component, input } from '@angular/core';

import {
  applyFontSizePx,
  execRich,
  FONT_SIZE_PX_LIST,
  mergeFontOptions,
  promptLinkUrl,
} from './rich-text.utils';

@Component({
  selector: 'app-rich-text-toolbar',
  standalone: true,
  templateUrl: './rich-text-toolbar.component.html',
})
export class RichTextToolbarComponent {
  readonly disabled = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);

  fonts(): string[] {
    return mergeFontOptions(this.fontChoices());
  }

  onFontMouseDown(e: Event): void {
    e.preventDefault();
  }

  onFontChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    const v = sel.value;
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
    execRich(cmd, val);
  }

  onForeColor(e: Event): void {
    if (this.disabled()) return;
    execRich('foreColor', (e.target as HTMLInputElement).value);
  }

  onBackColor(e: Event): void {
    if (this.disabled()) return;
    execRich('backColor', (e.target as HTMLInputElement).value);
  }

  onHilite(e: Event): void {
    if (this.disabled()) return;
    const v = (e.target as HTMLInputElement).value;
    if (!execRich('hiliteColor', v)) execRich('backColor', v);
  }

  link(): void {
    if (this.disabled()) return;
    promptLinkUrl();
  }

  readonly sizes = FONT_SIZE_PX_LIST;
}
