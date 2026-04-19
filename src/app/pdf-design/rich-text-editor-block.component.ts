import {
  Component,
  ElementRef,
  input,
  output,
  effect,
  viewChild,
} from '@angular/core';

import { RichTextToolbarComponent } from './rich-text-toolbar.component';
import { isProbablyHtml } from './rich-text.utils';

@Component({
  selector: 'app-rich-text-editor-block',
  standalone: true,
  imports: [RichTextToolbarComponent],
  templateUrl: './rich-text-editor-block.component.html',
})
export class RichTextEditorBlockComponent {
  readonly html = input<string>('');
  readonly disabled = input(false);
  readonly fontChoices = input<string[] | undefined>(undefined);
  readonly minHeight = input(96);

  readonly htmlChange = output<string>();

  private readonly editable = viewChild<ElementRef<HTMLDivElement>>('editable');

  constructor() {
    effect(() => {
      const htmlVal = this.html();
      const dis = this.disabled();
      const el = this.editable()?.nativeElement;
      if (!el || dis) return;
      if (document.activeElement === el) return;
      const next = htmlVal ?? '';
      if (isProbablyHtml(next)) {
        if (el.innerHTML !== next) el.innerHTML = next;
      } else if (el.textContent !== next) {
        el.textContent = next;
      }
    });
  }

  onInput(e: Event): void {
    this.htmlChange.emit((e.target as HTMLDivElement).innerHTML);
  }
}
