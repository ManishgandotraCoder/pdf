import { Component, input, output, signal, effect } from '@angular/core';

import { cropDataUrl } from './pdf-design.helpers';

@Component({
  selector: 'app-image-crop-modal',
  standalone: true,
  templateUrl: './image-crop-modal.component.html',
})
export class ImageCropModalComponent {
  readonly sourceUrl = input.required<string>();

  readonly apply = output<string>();
  readonly cancel = output<void>();

  readonly natural = signal({ w: 0, h: 0 });
  readonly crop = signal({ x: 0, y: 0, w: 0, h: 0 });

  constructor() {
    effect(() => {
      const url = this.sourceUrl();
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        this.natural.set({ w, h });
        this.crop.set({ x: 0, y: 0, w, h });
      };
      img.src = url;
    });
  }

  pct(v: number, max: number): number {
    return max ? Math.round((v / max) * 100) : 0;
  }

  setCropKey(k: 'x' | 'y' | 'w' | 'h', val: number): void {
    this.crop.update((prev) => ({ ...prev, [k]: Math.max(0, val) }));
  }

  onCropInput(k: 'x' | 'y' | 'w' | 'h', e: Event): void {
    const v = Math.max(0, +(e.target as HTMLInputElement).value || 0);
    this.setCropKey(k, v);
  }

  async onApply(): Promise<void> {
    const out = await cropDataUrl(this.sourceUrl(), this.crop());
    this.apply.emit(out);
  }

  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.cancel.emit();
  }

  readonly cropKeys = ['x', 'y', 'w', 'h'] as const;

  cropVal(k: 'x' | 'y' | 'w' | 'h'): number {
    return Math.round(this.crop()[k]);
  }

  setCropFromInput(k: 'x' | 'y' | 'w' | 'h', e: Event): void {
    this.onCropInput(k, e);
  }
}
