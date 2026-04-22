import { Routes } from '@angular/router';
import { PdfDesignExtractorComponent } from './pdf-design/pages/pdf-design-extractor/pdf-design-extractor.component';
import { PdfsComponent } from './pdf-design/pages/pdfs/pdfs.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: PdfsComponent },
  { path: 'edit', component: PdfDesignExtractorComponent },
  { path: 'edit/:pdfId', component: PdfDesignExtractorComponent },
  { path: '**', redirectTo: '' },
];
