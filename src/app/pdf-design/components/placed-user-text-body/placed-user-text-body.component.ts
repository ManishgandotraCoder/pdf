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
      const html = this.normalizeEditableHtml(this.html());
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
    if (e.altKey) {
      this.altDragPointerDown.emit(e);
      return;
    }
    this.maybePlaceCaretOnClickedEmptyLine(e);
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

  private normalizeEditableHtml(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '<p><br></p>';
    if (typeof document === 'undefined') return raw;

    const probe = document.createElement('div');
    probe.innerHTML = raw;
    const text = (probe.textContent || '').replace(/\u00a0/g, '').trim();
    const hasAtomicContent = !!probe.querySelector('img, video, table, hr, iframe, svg, canvas');
    return text || hasAtomicContent ? raw : '<p><br></p>';
  }

  private maybePlaceCaretOnClickedEmptyLine(e: PointerEvent): void {
    const el = this.editable()?.nativeElement;
    if (!el) return;
    if (e.target !== el) return;
    if (!this.isEffectivelyEmpty(el)) return;

    const rect = el.getBoundingClientRect();
    const offsetY = Math.max(0, e.clientY - rect.top + el.scrollTop);
    queueMicrotask(() => {
      const root = this.editable()?.nativeElement;
      if (!root || this.readOnly()) return;
      const lineHeight = this.estimatedLineHeight(root);
      const lineIndex = Math.max(0, Math.floor(offsetY / Math.max(1, lineHeight)));
      const html = Array.from({ length: lineIndex + 1 }, () => '<p><br></p>').join('');
      if (root.innerHTML !== html) {
        root.innerHTML = html;
        this.htmlChange.emit(html);
      }
      root.focus();
      this.placeCaretAtParagraph(root, lineIndex);
    });
  }

  private isEffectivelyEmpty(el: HTMLElement): boolean {
    const text = (el.textContent || '').replace(/\u00a0/g, '').trim();
    if (text) return false;
    return !el.querySelector('img, video, table, hr, iframe, svg, canvas');
  }

  private estimatedLineHeight(el: HTMLElement): number {
    const cs = getComputedStyle(el);
    const parsed = parseFloat(cs.lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const fontSize = parseFloat(cs.fontSize);
    return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.4 : 18;
  }

  private placeCaretAtParagraph(root: HTMLElement, lineIndex: number): void {
    try {
      const sel = document.getSelection();
      if (!sel) return;
      const blocks = Array.from(root.children);
      const paragraph = (blocks[lineIndex] || blocks[blocks.length - 1] || root) as Node;
      const range = document.createRange();
      range.setStart(paragraph, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* leave focus in place if the browser rejects the range */
    }
  }
}
