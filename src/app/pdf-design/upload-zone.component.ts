import { Component, output } from '@angular/core';

@Component({
  selector: 'app-upload-zone',
  standalone: true,
  templateUrl: './upload-zone.component.html',
})
export class UploadZoneComponent {
  readonly upload = output<File>();

  drag = false;

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.drag = true;
  }

  onDragLeave(): void {
    this.drag = false;
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.drag = false;
    const f = e.dataTransfer?.files?.[0];
    if (f?.type === 'application/pdf') this.upload.emit(f);
  }

  onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) this.upload.emit(f);
  }
}
