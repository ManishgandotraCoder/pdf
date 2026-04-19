import { AfterViewInit, Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit {
  protected readonly title = signal('PDF Design Extractor');

  ngAfterViewInit(): void {
    this.tryMountPdfExtractor(0);
  }

  private tryMountPdfExtractor(attempt: number): void {
    const w = globalThis as typeof globalThis & {
      __PDF_DESIGN_EXTRACTOR_MOUNTED__?: boolean;
      React?: unknown;
      ReactDOM?: unknown;
      pdfjsLib?: unknown;
    };

    if (w.__PDF_DESIGN_EXTRACTOR_MOUNTED__) {
      return;
    }

    const root = document.getElementById('root');
    if (!root) {
      return;
    }

    const ready =
      w.React !== undefined &&
      w.ReactDOM !== undefined &&
      w.pdfjsLib !== undefined;

    if (!ready) {
      if (attempt < 100) {
        setTimeout(() => this.tryMountPdfExtractor(attempt + 1), 50);
      }
      return;
    }

    w.__PDF_DESIGN_EXTRACTOR_MOUNTED__ = true;
    const script = document.createElement('script');
    script.type = 'text/babel';
    script.src = 'pdf-design-extractor-app.jsx';
    document.body.appendChild(script);
  }
}
