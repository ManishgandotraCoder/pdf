import {
  Component,
  ElementRef,
  input,
  output,
  effect,
  viewChild,
} from '@angular/core';

import { RichTextToolbarComponent } from '../rich-text-toolbar/rich-text-toolbar.component';
import { isProbablyHtml } from '../../utils/rich-text.utils';

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

  /**
   * Track whether the editable area is currently focused.
   * While focused we do NOT overwrite content from the parent (the user is
   * typing). We also do NOT emit on every keystroke — only when focus leaves
   * so that changes don't automatically reflect on the canvas while typing.
   */
  private focused = false;

  constructor() {
    effect(() => {
      const htmlVal = this.html();
      const dis = this.disabled();
      const el = this.editable()?.nativeElement;
      if (!el) return;
      // Only push incoming HTML into the DOM when the user is NOT actively
      // editing (i.e. the div is not focused). This prevents overwriting
      // in-progress edits.
      if (this.focused) return;
      const next = htmlVal ?? '';
      if (isProbablyHtml(next)) {
        if (el.innerHTML !== next) el.innerHTML = next;
      } else {
        if (el.textContent !== next) el.textContent = next;
      }
      if (dis) el.setAttribute('contenteditable', 'false');
    });
  }

  /** Called on every keystroke — just track focus; do NOT emit to parent. */
  onInput(_e: Event): void {
    // Intentionally empty: we defer emitting until blur so that the canvas
    // The canvas does NOT update on every character the user types.
    // (Toolbar commands — bold, italic etc. — already restore the selection
    //  and modify the DOM directly; blur will capture their result too.)
  }

  /** Emit the final HTML when the user moves focus away from the editor. */
  onBlur(e: Event): void {
    this.focused = false;
    const el = e.target as HTMLDivElement;
    this.htmlChange.emit(el.innerHTML);
  }

  /** Track focus so the effect() above won't clobber in-progress edits. */
  onFocus(): void {
    this.focused = true;
  }
}
