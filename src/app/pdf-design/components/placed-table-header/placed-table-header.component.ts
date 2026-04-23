import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-placed-table-header',
  standalone: true,
  templateUrl: './placed-table-header.component.html',
})
export class PlacedTableHeaderComponent {
  readonly selected = input(false);
  readonly dragging = input(false);

  readonly dragPointerDown = output<PointerEvent>();
  readonly dragPointerMove = output<PointerEvent>();
  readonly dragPointerUp = output<PointerEvent>();
  readonly dragPointerCancel = output<PointerEvent>();

  readonly remove = output<void>();

  onDragPointerDown(e: PointerEvent): void {
    e.stopPropagation();
    this.dragPointerDown.emit(e);
  }

  onDragPointerMove(e: PointerEvent): void {
    this.dragPointerMove.emit(e);
  }

  onDragPointerUp(e: PointerEvent): void {
    this.dragPointerUp.emit(e);
  }

  onDragPointerCancel(e: PointerEvent): void {
    this.dragPointerCancel.emit(e);
  }

  onRemoveClick(e: MouseEvent): void {
    e.stopPropagation();
    this.remove.emit();
  }
}

