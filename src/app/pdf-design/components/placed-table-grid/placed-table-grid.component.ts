import { Component, input, output } from '@angular/core';

import { TableCellEditorComponent } from '../table-cell-editor/table-cell-editor.component';
import { ensureTableCells } from '../../utils/rich-text.utils';

@Component({
  selector: 'app-placed-table-grid',
  standalone: true,
  imports: [TableCellEditorComponent],
  templateUrl: './placed-table-grid.component.html',
})
export class PlacedTableGridComponent {
  readonly rows = input(1);
  readonly cols = input(1);
  readonly cells = input<string[][] | undefined>(undefined);
  readonly readOnly = input(false);

  readonly cellHtmlInput = output<{ row: number; col: number; html: string }>();
  readonly cellFocus = output<void>();

  matrix(): string[][] {
    return ensureTableCells(this.rows(), this.cols(), this.cells());
  }

  onCell(i: number, j: number, h: string): void {
    this.cellHtmlInput.emit({ row: i, col: j, html: h });
  }
}
