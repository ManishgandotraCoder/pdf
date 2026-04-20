import { Routes } from '@angular/router';
import { PdfDesignExtractorComponent } from './pdf-design/pdf-design-extractor.component';
import { PdfsComponent } from './pdf-design/pdfs.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: PdfsComponent },
  { path: 'edit', component: PdfDesignExtractorComponent },
  { path: 'edit/:pdfId', component: PdfDesignExtractorComponent },
  { path: '**', redirectTo: '' },
];
