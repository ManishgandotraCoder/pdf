import {
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'app-placed-user-text-body',
  standalone: true,
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

  private readonly destroyRef = inject(DestroyRef);
  private readonly editable = viewChild<ElementRef<HTMLDivElement>>('editable');
  private focused = false;

  constructor() {
    effect(() => {
      const el = this.editable()?.nativeElement;
      if (!el) return;
      const html = this.html() || '<p><br></p>';
      if (!this.focused && el.innerHTML !== html) el.innerHTML = html;
      el.setAttribute('contenteditable', this.readOnly() ? 'false' : 'true');
    });

    if (typeof document !== 'undefined') {
      const onSelection = () => this.emitSelectionState();
      document.addEventListener('selectionchange', onSelection, { passive: true } as AddEventListenerOptions);
      this.destroyRef.onDestroy(() => document.removeEventListener('selectionchange', onSelection));
    }
  }

  onInput(e: Event): void {
    if (this.readOnly()) return;
    this.htmlChange.emit((e.target as HTMLDivElement).innerHTML);
    this.emitSelectionState();
  }

  onFocus(): void {
    if (this.readOnly()) return;
    this.focused = true;
    this.focusFirstEdit.emit();
    this.focusStateChange.emit(true);
    this.emitSelectionState();
  }

  onBlur(e: Event): void {
    this.focused = false;
    if (!this.readOnly()) this.htmlChange.emit((e.target as HTMLDivElement).innerHTML);
    queueMicrotask(() => {
      this.focusStateChange.emit(this.isSelectionInsideEditable());
      this.emitSelectionState();
    });
  }

  onPointerDown(e: PointerEvent): void {
    if (this.readOnly()) return;
    if (!e.altKey) return;
    this.altDragPointerDown.emit(e);
  }

  onPointerMove(e: PointerEvent): void {
    this.pointerMove.emit(e);
  }

  onPointerUp(e: PointerEvent): void {
    this.pointerUp.emit(e);
  }

  onPointerCancel(e: PointerEvent): void {
    this.pointerCancel.emit(e);
  }

  private emitSelectionState(): void {
    this.selectionStateChange.emit(this.hasSelectionInsideEditable());
  }

  private hasSelectionInsideEditable(): boolean {
    const el = this.editable()?.nativeElement;
    const sel = document.getSelection();
    if (!el || !sel?.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    return el.contains(range.commonAncestorContainer);
  }

  private isSelectionInsideEditable(): boolean {
    const el = this.editable()?.nativeElement;
    const sel = document.getSelection();
    if (!el || !sel?.rangeCount) return false;
    return el.contains(sel.getRangeAt(0).commonAncestorContainer);
  }
}
