import { Component } from '@angular/core';

import { PdfDesignExtractorComponent } from './pdf-design/pdf-design-extractor.component';

@Component({
  selector: 'app-root',
  imports: [PdfDesignExtractorComponent],
  template: '<app-pdf-design-extractor />',
})
export class App {}
