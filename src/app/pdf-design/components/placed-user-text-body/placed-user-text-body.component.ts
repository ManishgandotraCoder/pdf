import {
  Component,
  ElementRef,
  input,
  output,
  effect,
  viewChild,
} from '@angular/core';

import { SafeHtmlPipe } from '../../pipes/safe-html.pipe';

@Component({
  selector: 'app-placed-user-text-body',
  standalone: true,
  imports: [SafeHtmlPipe],
  templateUrl: './placed-user-text-body.component.html',
})
export class PlacedUserTextBodyComponent {
  readonly html = input<string>('');
  readonly readOnly = input(false);

  readonly htmlChange = output<string>();
  readonly focusFirstEdit = output<void>();
  readonly pointerMove = output<PointerEvent>();
  readonly pointerUp = output<PointerEvent>();
  readonly pointerCancel = output<PointerEvent>();
  readonly altDragPointerDown = output<PointerEvent>();

  private readonly editable = viewChild<ElementRef<HTMLDivElement>>('editable');

  constructor() {
    effect(() => {
      const htmlVal = this.html();
      const ro = this.readOnly();
      if (ro) return;
      const el = this.editable()?.nativeElement;
      if (!el || document.activeElement === el) return;
      const next = htmlVal || '<p><br></p>';
      if (el.innerHTML !== next) el.innerHTML = next;
    });
  }

  onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (e.altKey) {
      e.preventDefault();
      this.altDragPointerDown.emit(e);
    }
  }

  onInput(e: Event): void {
    this.htmlChange.emit((e.target as HTMLDivElement).innerHTML);
  }
}
