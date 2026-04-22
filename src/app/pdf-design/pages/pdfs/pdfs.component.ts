import { Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PdfsApiService, type PdfRecord } from '../../services/pdfs-api.service';

@Component({
  selector: 'app-pdfs',
  standalone: true,
  styles: [`
    :host { display: block; }

    .page-root {
      min-height: 100vh;
      background: #f0f4f8;
      background-image:
        radial-gradient(ellipse 100% 60% at 50% -10%, rgba(13,148,136,0.10), transparent 55%),
        radial-gradient(ellipse 60% 40% at 100% 0%, rgba(99,102,241,0.07), transparent 50%);
    }

    /* Hero header */
    .hero {
      background: linear-gradient(135deg, #0f766e 0%, #0d9488 40%, #2aacb8 100%);
      padding: 48px 32px 36px;
      text-align: center;
      color: #fff;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: radial-gradient(circle at 70% 50%, rgba(255,255,255,0.07) 0%, transparent 60%),
        radial-gradient(circle at 20% 80%, rgba(0,0,0,0.06) 0%, transparent 40%);
    }
    .hero__inner { position: relative; z-index: 1; }
    .hero__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 64px; height: 64px;
      background: rgba(255,255,255,0.18);
      border-radius: 20px;
      margin-bottom: 16px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      backdrop-filter: blur(8px);
    }
    .hero__title {
      font-size: 2rem; font-weight: 800; letter-spacing: -0.03em;
      margin-bottom: 8px;
    }
    .hero__sub {
      font-size: 0.9375rem; opacity: 0.85; max-width: 420px; margin: 0 auto;
      line-height: 1.55;
    }
    .hero__actions {
      margin-top: 24px;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      flex-wrap: wrap;
    }
    .btn-upload {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 24px;
      background: rgba(255,255,255,0.98);
      color: #0f766e;
      border: none; border-radius: 12px;
      font-size: 14px; font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.14);
      transition: transform 0.15s, box-shadow 0.15s, background 0.15s;
    }
    .btn-upload:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
    .btn-upload:active { transform: none; }
    .btn-refresh {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 11px 18px;
      background: rgba(255,255,255,0.18);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.35); border-radius: 12px;
      font-size: 13px; font-weight: 600;
      cursor: pointer;
      backdrop-filter: blur(8px);
      transition: background 0.15s;
    }
    .btn-refresh:hover { background: rgba(255,255,255,0.26); }
    .btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Stats bar */
    .stats-bar {
      background: #fff;
      border-bottom: 1px solid rgba(15,23,42,0.07);
      padding: 12px 32px;
      display: flex; align-items: center; gap: 24px;
      flex-wrap: wrap;
    }
    .stat {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; color: #475569;
    }
    .stat__num { font-weight: 700; color: #0f172a; font-size: 15px; }

    /* Search & filter */
    .toolbar {
      max-width: 1200px; margin: 0 auto;
      padding: 24px 32px 0;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .search-wrap {
      flex: 1; min-width: 200px; max-width: 380px; position: relative;
    }
    .search-input {
      width: 100%; padding: 10px 12px 10px 40px;
      border: 1px solid rgba(15,23,42,0.12); border-radius: 10px;
      font-size: 13px; color: #0f172a;
      background: #fff;
      box-shadow: 0 1px 4px rgba(15,23,42,0.05);
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }
    .search-input:focus {
      border-color: #2aacb8;
      box-shadow: 0 0 0 3px rgba(42,172,184,0.12);
    }
    .search-icon {
      position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
      color: #94a3b8; pointer-events: none;
    }
    .view-toggle {
      display: flex; gap: 4px;
      background: rgba(15,23,42,0.05); border-radius: 10px; padding: 4px;
    }
    .view-btn {
      width: 36px; height: 36px; border: none; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #64748b;
      transition: background 0.15s, color 0.15s;
      background: transparent;
    }
    .view-btn.active { background: #fff; color: #0f766e; box-shadow: 0 1px 4px rgba(15,23,42,0.1); }

    /* Content */
    .content {
      max-width: 1200px; margin: 0 auto;
      padding: 20px 32px 48px;
    }

    /* Error */
    .error-bar {
      margin-bottom: 20px; padding: 14px 16px; border-radius: 12px;
      border: 1px solid rgba(185,28,28,0.22); background: #fef2f2;
      color: #991b1b; font-size: 13px;
      display: flex; align-items: center; gap: 10px;
    }

    /* Empty state */
    .empty-state {
      text-align: center; padding: 80px 24px;
    }
    .empty-state__icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 80px; height: 80px;
      background: rgba(42,172,184,0.1); border-radius: 24px;
      color: #2aacb8; margin-bottom: 20px;
    }
    .empty-state__title { font-size: 1.25rem; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    .empty-state__sub { font-size: 0.875rem; color: #64748b; max-width: 300px; margin: 0 auto; line-height: 1.6; }

    /* GRID layout */
    .pdf-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }

    /* LIST layout */
    .pdf-list {
      display: flex; flex-direction: column; gap: 10px;
    }

    /* Card shared */
    .pdf-card {
      background: #fff; border-radius: 16px;
      border: 1px solid rgba(15,23,42,0.08);
      box-shadow: 0 2px 12px rgba(15,23,42,0.05);
      overflow: hidden;
      transition: transform 0.18s, box-shadow 0.18s, border-color 0.18s;
      cursor: pointer;
    }
    .pdf-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 32px rgba(15,23,42,0.1);
      border-color: rgba(42,172,184,0.4);
    }
    .pdf-card:hover .card-edit-badge { opacity: 1; }

    /* Grid card specific */
    .pdf-card--grid .card-preview {
      height: 200px; overflow: hidden;
      background: #1e2a3a;
      position: relative;
    }
    .pdf-card--grid .card-preview iframe {
      width: 100%; height: 100%; border: 0;
      pointer-events: none;
    }
    .card-edit-badge {
      position: absolute; top: 10px; right: 10px;
      background: rgba(15,23,42,0.75); backdrop-filter: blur(6px);
      color: #fff; font-size: 11px; font-weight: 600;
      padding: 4px 10px; border-radius: 20px;
      display: flex; align-items: center; gap: 5px;
      opacity: 0; transition: opacity 0.18s;
    }
    .pdf-card--grid .card-body {
      padding: 14px 16px 12px;
    }
    .card-title {
      font-size: 14px; font-weight: 700; color: #0f172a;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      margin-bottom: 4px;
    }
    .card-meta {
      font-size: 11px; color: #94a3b8;
      display: flex; align-items: center; gap: 6px;
    }
    .card-meta-dot { width: 3px; height: 3px; background: #cbd5e1; border-radius: 50%; }
    .card-actions {
      display: flex; gap: 8px; padding: 10px 16px 14px;
    }
    .btn-sm {
      flex: 1; padding: 8px 10px; border-radius: 8px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      transition: background 0.12s, border-color 0.12s;
    }
    .btn-teal {
      background: rgba(42,172,184,0.1); color: #0f766e;
      border: 1px solid rgba(42,172,184,0.3);
    }
    .btn-teal:hover { background: rgba(42,172,184,0.18); }
    .btn-gray {
      background: #f1f5f9; color: #475569;
      border: 1px solid rgba(15,23,42,0.1);
    }
    .btn-gray:hover { background: #e8ecf0; }
    .btn-danger {
      background: #fef2f2; color: #b91c1c;
      border: 1px solid #fecaca;
    }
    .btn-danger:hover { background: #fee2e2; }

    /* List card specific */
    .pdf-card--list {
      display: flex; align-items: center; gap: 0;
      padding: 0; border-radius: 12px;
    }
    .pdf-card--list .card-list-preview {
      width: 72px; height: 72px; flex-shrink: 0;
      background: #1e2a3a; overflow: hidden;
      border-radius: 10px 0 0 10px;
      position: relative;
    }
    .pdf-card--list .card-list-preview iframe {
      width: 300%; height: 300%;
      transform: scale(0.333); transform-origin: top left;
      pointer-events: none;
    }
    .pdf-card--list .card-list-body {
      flex: 1; min-width: 0; padding: 12px 16px;
    }
    .pdf-card--list .card-list-actions {
      display: flex; gap: 8px; padding: 0 16px; flex-shrink: 0;
    }

    /* Upload progress overlay */
    .uploading-indicator {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 20px; border-radius: 12px;
      background: rgba(42,172,184,0.1); border: 1px dashed rgba(42,172,184,0.4);
      color: #0f766e; font-size: 13px; font-weight: 600;
      margin-bottom: 20px;
    }
    .spinner {
      width: 18px; height: 18px; border: 2px solid rgba(42,172,184,0.3);
      border-top-color: #2aacb8; border-radius: 50%;
      animation: spin 0.7s linear infinite; flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Skeleton loading */
    .skeleton-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }
    .skeleton-card {
      background: #fff; border-radius: 16px;
      border: 1px solid rgba(15,23,42,0.08);
      overflow: hidden;
    }
    .skeleton-preview {
      height: 200px; background: linear-gradient(90deg, #f1f5f9 25%, #e8ecf0 50%, #f1f5f9 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
    .skeleton-body { padding: 14px 16px; }
    .skeleton-line {
      border-radius: 6px; background: linear-gradient(90deg, #f1f5f9 25%, #e8ecf0 50%, #f1f5f9 75%);
      background-size: 200% 100%; animation: shimmer 1.5s infinite;
      margin-bottom: 8px;
    }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  `],
  template: `
    <div class="page-root">

      <!-- ── Hero ── -->
      <div class="hero">
        <div class="hero__inner">
          <div class="hero__icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>
            </svg>
          </div>
          <h1 class="hero__title">PDF Editor</h1>
          <p class="hero__sub">Upload, manage and edit your PDF documents. Click any document to open it in the editor.</p>
          <div class="hero__actions">
            <input #fileInput type="file" accept="application/pdf" style="display:none" (change)="onPick($event)" />
            <button class="btn-upload" (click)="fileInput.click()" [disabled]="uploading()">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Upload PDF
            </button>
            <button class="btn-refresh" (click)="refresh()" [disabled]="loading()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              {{ loading() ? 'Loading…' : 'Refresh' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── Stats bar ── -->
      @if (!loading() && pdfs().length > 0) {
        <div class="stats-bar">
          <div class="stat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2aacb8" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <path d="M14 2v6h6"/>
            </svg>
            <span class="stat__num">{{ pdfs().length }}</span>
            <span>{{ pdfs().length === 1 ? 'document' : 'documents' }}</span>
          </div>
          <div class="stat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span class="stat__num">{{ totalSizeKb() }} KB</span>
            <span>total size</span>
          </div>
        </div>
      }

      <!-- ── Toolbar ── -->
      @if (!loading() && pdfs().length > 0) {
        <div class="toolbar">
          <div class="search-wrap">
            <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              class="search-input"
              type="text"
              placeholder="Search PDFs…"
              [value]="searchQuery()"
              (input)="searchQuery.set(($any($event.target)).value)"
            />
          </div>
          <div style="flex:1"></div>
          <div class="view-toggle">
            <button class="view-btn" [class.active]="viewMode() === 'grid'" (click)="viewMode.set('grid')" title="Grid view">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </button>
            <button class="view-btn" [class.active]="viewMode() === 'list'" (click)="viewMode.set('list')" title="List view">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none"/>
                <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/>
                <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          </div>
        </div>
      }

      <!-- ── Content ── -->
      <div class="content">

        <!-- Error -->
        @if (err()) {
          <div class="error-bar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {{ err() }}
          </div>
        }

        <!-- Uploading indicator -->
        @if (uploading()) {
          <div class="uploading-indicator">
            <div class="spinner"></div>
            Uploading PDF…
          </div>
        }

        <!-- Loading skeletons -->
        @if (loading()) {
          <div class="skeleton-grid">
            @for (i of [1,2,3,4,5,6]; track i) {
              <div class="skeleton-card">
                <div class="skeleton-preview"></div>
                <div class="skeleton-body">
                  <div class="skeleton-line" style="height:14px; width:70%"></div>
                  <div class="skeleton-line" style="height:11px; width:45%"></div>
                </div>
              </div>
            }
          </div>
        }

        <!-- Empty state -->
        @if (!loading() && filteredPdfs().length === 0 && !err()) {
          <div class="empty-state">
            @if (searchQuery() && pdfs().length > 0) {
              <div class="empty-state__icon">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </div>
              <h3 class="empty-state__title">No results for "{{ searchQuery() }}"</h3>
              <p class="empty-state__sub">Try a different search term or clear the search to see all PDFs.</p>
            } @else {
              <div class="empty-state__icon">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>
                </svg>
              </div>
              <h3 class="empty-state__title">No PDFs yet</h3>
              <p class="empty-state__sub">Click "Upload PDF" above to add your first document. It'll appear here ready to edit.</p>
            }
          </div>
        }

        <!-- GRID VIEW -->
        @if (!loading() && filteredPdfs().length > 0 && viewMode() === 'grid') {
          <div class="pdf-grid">
            @for (p of filteredPdfs(); track p.id) {
              <div class="pdf-card pdf-card--grid" (click)="openInEditor(p.id)" title="Open {{ p.title }} in editor">
                <div class="card-preview">
                  <iframe [src]="pdfSrc(p.id)" title="PDF preview" loading="lazy"></iframe>
                  <div class="card-edit-badge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Edit
                  </div>
                </div>
                <div class="card-body">
                  <div class="card-title" [title]="p.title">{{ p.title }}</div>
                  <div class="card-meta">
                    <span>{{ kb(p.byteSize) }} KB</span>
                    <span class="card-meta-dot"></span>
                    <span>{{ formatDate(p.updatedAt) }}</span>
                  </div>
                </div>
                <div class="card-actions" (click)="$event.stopPropagation()">
                  <button class="btn-sm btn-teal" (click)="openInEditor(p.id)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Edit
                  </button>
                  <button class="btn-sm btn-gray" (click)="rename(p)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                    </svg>
                    Rename
                  </button>
                  <button class="btn-sm btn-danger" (click)="remove(p)" style="flex:0; padding: 8px 12px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            }
          </div>
        }

        <!-- LIST VIEW -->
        @if (!loading() && filteredPdfs().length > 0 && viewMode() === 'list') {
          <div class="pdf-list">
            @for (p of filteredPdfs(); track p.id) {
              <div class="pdf-card pdf-card--list" (click)="openInEditor(p.id)" title="Open in editor">
                <div class="card-list-preview">
                  <iframe [src]="pdfSrc(p.id)" title="PDF preview" loading="lazy"></iframe>
                </div>
                <div class="card-list-body">
                  <div class="card-title" [title]="p.title">{{ p.title }}</div>
                  <div class="card-meta">
                    <span>{{ p.filename }}</span>
                    <span class="card-meta-dot"></span>
                    <span>{{ kb(p.byteSize) }} KB</span>
                    <span class="card-meta-dot"></span>
                    <span>{{ formatDate(p.updatedAt) }}</span>
                  </div>
                </div>
                <div class="card-list-actions" (click)="$event.stopPropagation()">
                  <button class="btn-sm btn-teal" style="padding:8px 16px;" (click)="openInEditor(p.id)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Edit
                  </button>
                  <button class="btn-sm btn-gray" style="padding:8px 14px;" (click)="rename(p)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                    </svg>
                    Rename
                  </button>
                  <button class="btn-sm btn-danger" style="padding:8px 12px; flex:0;" (click)="remove(p)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            }
          </div>
        }

      </div>
    </div>
  `,
})
export class PdfsComponent {
  readonly api = inject(PdfsApiService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);

  readonly pdfs = signal<PdfRecord[]>([]);
  readonly loading = signal(false);
  readonly uploading = signal(false);
  readonly err = signal<string | null>(null);
  readonly searchQuery = signal('');
  readonly viewMode = signal<'grid' | 'list'>('grid');

  readonly filteredPdfs = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return this.pdfs();
    return this.pdfs().filter(
      (p) => p.title.toLowerCase().includes(q) || p.filename.toLowerCase().includes(q),
    );
  });

  readonly totalSizeKb = computed(() => {
    const total = this.pdfs().reduce((s, p) => s + (p.byteSize || 0), 0);
    return (Math.round((total / 1024) * 10) / 10).toFixed(1);
  });

  constructor() {
    void this.refresh();
  }

  pdfSrc(id: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.api.pdfFileUrl(id));
  }

  kb(bytes: number): string {
    const n = Math.max(0, bytes || 0) / 1024;
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  formatDate(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.err.set(null);
    try {
      const res = await firstValueFrom(this.api.listPdfs());
      this.pdfs.set(res.pdfs || []);
    } catch (e: unknown) {
      this.err.set(e instanceof Error ? e.message : String(e));
      this.pdfs.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  openInEditor(id: string): void {
    void this.router.navigate(['/edit', id]);
  }

  async onPick(e: Event): Promise<void> {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    const title = prompt('Title (optional)', f.name.replace(/\.pdf$/i, ''))?.trim() || undefined;
    this.uploading.set(true);
    try {
      await firstValueFrom(this.api.uploadPdf({ file: f, title }));
      await this.refresh();
    } catch (err: unknown) {
      this.err.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.uploading.set(false);
    }
  }

  async rename(p: PdfRecord): Promise<void> {
    const title = prompt('New title', p.title)?.trim() || '';
    if (!title || title === p.title) return;
    try {
      await firstValueFrom(this.api.renamePdf(p.id, title));
      await this.refresh();
    } catch (err: unknown) {
      this.err.set(err instanceof Error ? err.message : String(err));
    }
  }

  async remove(p: PdfRecord): Promise<void> {
    if (!confirm(`Delete "${p.title}"?\n\nThis action cannot be undone.`)) return;
    try {
      await firstValueFrom(this.api.deletePdf(p.id));
      await this.refresh();
    } catch (err: unknown) {
      this.err.set(err instanceof Error ? err.message : String(err));
    }
  }
}
