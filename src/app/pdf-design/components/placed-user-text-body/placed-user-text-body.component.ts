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
  readonly selectionStateChange = output<boolean>();
  readonly focusStateChange = output<boolean>();

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

  onFocus(): void {
    this.focusStateChange.emit(true);
    this.emitSelectionState();
  }

  onMouseUp(): void {
    this.emitSelectionState();
  }

  onKeyUp(): void {
    this.emitSelectionState();
  }

  onBlur(): void {
    this.focusStateChange.emit(false);
    this.selectionStateChange.emit(false);
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
    this.emitSelectionState();
  }

  private emitSelectionState(): void {
    const root = this.editable()?.nativeElement;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      this.selectionStateChange.emit(false);
      return;
    }
    if (sel.isCollapsed) {
      this.selectionStateChange.emit(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const inRoot = root.contains(range.commonAncestorContainer);
    const txt = (sel.toString() || '').trim();
    this.selectionStateChange.emit(inRoot && txt.length > 0);
  }
}
