import { Component, input } from '@angular/core';

@Component({
  selector: 'app-loading-screen',
  standalone: true,
  templateUrl: './loading-screen.component.html',
})
export class LoadingScreenComponent {
  readonly progress = input.required<number>();
  readonly done = input.required<number>();
  readonly total = input.required<number>();
}
