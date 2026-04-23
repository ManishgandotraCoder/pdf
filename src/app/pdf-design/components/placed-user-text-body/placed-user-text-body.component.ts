import {
  Component,
  input,
  output,
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
}
