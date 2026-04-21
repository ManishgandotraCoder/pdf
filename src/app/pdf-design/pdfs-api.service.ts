import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export type PdfRecord = {
  id: string;
  title: string;
  filename: string;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
};

@Injectable({ providedIn: 'root' })
export class PdfsApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'https://pdf-be.vercel.app';

  listPdfs() {
    return this.http.get<{ pdfs: PdfRecord[] }>(`${this.baseUrl}/pdfs`);
  }

  getPdfMeta(id: string) {
    return this.http.get<{ pdf: PdfRecord }>(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}`);
  }

  uploadPdf(input: { file: File; title?: string }) {
    const fd = new FormData();
    fd.append('file', input.file, input.file.name);
    if (input.title) fd.append('title', input.title);
    return this.http.post<{ pdf: PdfRecord }>(`${this.baseUrl}/pdfs`, fd);
  }

  renamePdf(id: string, title: string) {
    return this.http.put<{ pdf: PdfRecord }>(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}`, { title });
  }

  deletePdf(id: string) {
    return this.http.delete<void>(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}`);
  }

  touchPdf(id: string) {
    return this.http.put<{ pdf: PdfRecord }>(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}`, {});
  }

  getPdfFile(id: string) {
    return this.http.get(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}/file`, { responseType: 'arraybuffer' });
  }

  getPdfState(id: string) {
    return this.http.get<{ state: { v: number; savedAt: number; state: unknown } | null }>(
      `${this.baseUrl}/pdfs/${encodeURIComponent(id)}/state`,
    );
  }

  putPdfState(id: string, state: unknown) {
    return this.http.put<{ savedAt: number }>(`${this.baseUrl}/pdfs/${encodeURIComponent(id)}/state`, { state });
  }

  pdfFileUrl(id: string): string {
    return `${this.baseUrl}/pdfs/${encodeURIComponent(id)}/file`;
  }
}

