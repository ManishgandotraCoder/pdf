import * as pdfjsLib from 'pdfjs-dist';
import {
  Component,
  computed,
  effect,
  HostListener,
  signal,
  viewChild,
  ElementRef,
  DestroyRef,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { ImageCropModalComponent } from '../../components/image-crop-modal/image-crop-modal.component';
import { RichTextToolbarComponent } from '../../components/rich-text-toolbar/rich-text-toolbar.component';
import { LoadingScreenComponent } from '../../components/loading-screen/loading-screen.component';
import { PlacedTableGridComponent } from '../../components/placed-table-grid/placed-table-grid.component';
import { PlacedUserTextBodyComponent } from '../../components/placed-user-text-body/placed-user-text-body.component';
import { UploadZoneComponent } from '../../components/upload-zone/upload-zone.component';
import {
  AddedImagesMap,
  AddedRichTextsMap,
  AddedTablesMap,
  AddedVideosMap,
  CropModalState,
  DesignTokens,
  HistorySnapshot,
  ImageDragState,
  ImageEditsMap,
  ImageElement,
  LayoutEditsMap,
  PageData,
  ProposalSection,
  ResizeHandleId,
  SelElement,
  TableElement,
  TemplateCluster,
  TextEditsMap,
  TextElement,
  TextStyle,
  UserTextElement,
  VideoElement,
} from '../../models/pdf-design.models';
import {
  clusterTemplates,
  createBlankPageData,
  drawImageFit,
  findImageAtPagePoint,
  findVideoAtPagePoint,
  getImageOverlayBounds,
  imageFileFromDataTransfer,
  isLikelyImageFile,
  isLikelyVideoFile,
  readFileAsDataURL,
  rectFromResizeHandle,
  regionFromPdfDataUrl,
  resolvePlacementRectAgainstObstacles,
  remapPageKeyedState,
  remapPageKeyedStateInsert,
} from '../../utils/pdf-design.helpers';
import { extractPage } from '../../utils/pdf-extract-page';
import { PROPOSAL_SECTION_CATALOG } from '../../utils/proposal-sections.catalog';
import { ensureTableCells, isProbablyHtml } from '../../utils/rich-text.utils';
import { PdfsApiService } from '../../services/pdfs-api.service';
import { PlacedTableHeaderComponent } from '../../components/placed-table-header/placed-table-header.component';

@Component({
  selector: 'app-pdf-design-extractor',
  standalone: true,
  imports: [
    UploadZoneComponent,
    LoadingScreenComponent,
    ImageCropModalComponent,
    PlacedTableGridComponent,
    PlacedTableHeaderComponent,
    PlacedUserTextBodyComponent,
    RichTextToolbarComponent,
  ],
  templateUrl: './pdf-design-extractor.component.html',
})
export class PdfDesignExtractorComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly pdfsApi = inject(PdfsApiService);
  private openedPdfId: string | null = null;
  private loadedPdfBuf: ArrayBuffer | null = null;
  private readonly w = globalThis;

  private readonly mandatoryCatalogIds = new Set<string>(['cover', 'acceptance']);

  /** Read-only preview tab: hides editor chrome (see `?preview=1`). */
  readonly previewMode = toSignal(
    this.route.queryParamMap.pipe(map((m) => m.get('preview') === '1')),
    { initialValue: this.route.snapshot.queryParamMap.get('preview') === '1' },
  );

  /** Ordered sections shown in the left sidebar (proposal outline). */
  readonly proposalSections = signal<ProposalSection[]>([]);
  readonly addSectionModalOpen = signal(false);
  readonly sectionModalDraft = signal<ProposalSection[]>([]);
  /** Which section is considered active for the UI (based on selected page). */
  readonly activeSectionId = signal<string>('sec_mandatory_cover');
  readonly exportMenuOpen = signal(false);
  readonly sectionsMenuOpen = signal(false);
  private sectionDragKey: string | null = null;

  readonly sectionCatalog = PROPOSAL_SECTION_CATALOG;
  /** Headings detected from the PDF content for section picking. */
  readonly detectedHeadings = computed(() => this.detectHeadingsFromPages(this.pages()));

  readonly pages = signal<PageData[]>([]);
  readonly loading = signal(false);
  readonly progress = signal(0);
  readonly doneCount = signal(0);
  readonly totalPgs = signal(0);
  readonly selPage = signal(0);
  readonly selEl = signal<SelElement | null>(null);
  readonly imageEdits = signal<ImageEditsMap>({});
  readonly layoutEdits = signal<LayoutEditsMap>({});
  readonly textEdits = signal<TextEditsMap>({});
  /** Right panel: structural tools vs saved assets (placeholder for asset pipeline). */
  readonly inspectorTab = signal<'elements' | 'assets'>('elements');
  /** Proposal workflow (local UI state until backend wiring exists). */
  readonly approvalStatus = signal<'draft' | 'in_review'>('draft');
  readonly addedImages = signal<AddedImagesMap>({});
  readonly addedVideos = signal<AddedVideosMap>({});
  readonly addedTables = signal<AddedTablesMap>({});
  readonly addedRichTexts = signal<AddedRichTextsMap>({});
  readonly userTextHasSelection = signal<Record<string, boolean>>({});
  readonly userTextHasFocus = signal<Record<string, boolean>>({});
  readonly cropModal = signal<CropModalState | null>(null);
  readonly templates = signal<TemplateCluster[]>([]);
  readonly tokens = signal<DesignTokens>({ colors: [], fonts: [], sizes: [] });
  readonly editorMode = signal<'edit' | 'view'>('view');
  readonly activeAddTool = signal<'image' | 'video' | 'table' | 'userText' | null>(null);
  readonly zoom = signal(0.9);
  readonly viewerImageDropActive = signal(false);
  readonly draggingImageId = signal<string | null>(null);
  readonly historyUi = signal(0);
  /** Tracks whether each placed video is currently playing (for play/stop toggle UI). */
  readonly addedVideoPlaying = signal<Record<string, boolean>>({});

  readonly pdfTitle = signal<string>('');

  readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly pageStageRef = viewChild<ElementRef<HTMLDivElement>>('pageStage');
  readonly addImageInputRef = viewChild<ElementRef<HTMLInputElement>>('addImageInput');
  readonly addVideoInputRef = viewChild<ElementRef<HTMLInputElement>>('addVideoInput');

  private historyStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private isRestoring = false;
  private imageDrag: ImageDragState | null = null;
  private suppressImageClick = false;
  private tableUndoGate: { tableId: string | null; armed: boolean } = { tableId: null, armed: false };
  private placedTextUndoGate: string | null = null;

  private sectionForPageNum(pageNum: number): ProposalSection | null {
    this.ensureMandatorySections();
    const secs = this.proposalSections();
    if (!secs.length) return null;
    const starts = secs
      .map((s) => ({ s, start: this.sectionStartPageNum(s) }))
      .sort((a, b) => a.start - b.start);
    let best: ProposalSection | null = null;
    for (const row of starts) {
      if (row.start <= pageNum) best = row.s;
      else break;
    }
    return best ?? starts[0]!.s;
  }

  private pageContentBounds(pn: number): { minX: number; minY: number; maxX: number; maxY: number } {
    const pg = this.pages().find((p) => p.pageNum === pn) ?? null;
    if (!pg) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const sec = this.sectionForPageNum(pn);
    const m = sec?.margins ?? this.defaultMargins();
    const minX = Math.max(0, m.left ?? 0);
    const minY = Math.max(0, m.top ?? 0);
    const maxX = Math.max(minX, pg.width - Math.max(0, m.right ?? 0));
    const maxY = Math.max(minY, pg.height - Math.max(0, m.bottom ?? 0));
    return { minX, minY, maxX, maxY };
  }

  private resolvePlacementInContentBounds(
    pn: number,
    r: { x: number; y: number; w: number; h: number },
    obstacles: readonly { x: number; y: number; w: number; h: number }[],
    pw: number,
    ph: number,
    options: Parameters<typeof resolvePlacementRectAgainstObstacles>[4] = {},
  ): { x: number; y: number; w: number; h: number } {
    const b = this.pageContentBounds(pn);
    const innerW = Math.max(0, b.maxX - b.minX);
    const innerH = Math.max(0, b.maxY - b.minY);
    if (innerW <= 0 || innerH <= 0) return resolvePlacementRectAgainstObstacles(r, obstacles, pw, ph, options);

    const shift = (rr: { x: number; y: number; w: number; h: number }) => ({
      x: rr.x - b.minX,
      y: rr.y - b.minY,
      w: rr.w,
      h: rr.h,
    });
    const unshift = (rr: { x: number; y: number; w: number; h: number }) => ({
      x: rr.x + b.minX,
      y: rr.y + b.minY,
      w: rr.w,
      h: rr.h,
    });

    const shiftedObstacles = obstacles.map(shift);
    const shifted = shift(r);
    const shiftedOptions = {
      ...options,
      preferX: (options.preferX ?? r.x) - b.minX,
      preferY: (options.preferY ?? r.y) - b.minY,
    };
    const resolved = resolvePlacementRectAgainstObstacles(shifted, shiftedObstacles, innerW, innerH, shiftedOptions);
    const out = unshift(resolved);

    // Final clamp inside content bounds (guards float drift and oversized rects).
    const minX = b.minX;
    const minY = b.minY;
    const maxX = b.maxX;
    const maxY = b.maxY;
    const w = Math.min(out.w, Math.max(1, maxX - minX));
    const h = Math.min(out.h, Math.max(1, maxY - minY));
    const x = Math.min(Math.max(minX, out.x), Math.max(minX, maxX - w));
    const y = Math.min(Math.max(minY, out.y), Math.max(minY, maxY - h));
    return { x, y, w, h };
  }

  readonly pg = computed(() => {
    const p = this.pages();
    const i = this.selPage();
    return p[i] ?? null;
  });

  private readonly previewEffect = effect(() => {
    if (this.previewMode()) {
      this.editorMode.set('view');
      this.selEl.set(null);
    }
  });

  constructor() {
    // If we were routed from the PDFs list, auto-load that PDF.
    const pdfId = this.route.snapshot.paramMap.get('pdfId');
    if (pdfId) void this.openPdfById(pdfId);

    this.destroyRef.onDestroy(() => {
      this.revokeVideoBlobs(this.addedVideos());
    });

    effect((onCleanup) => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      void this.selPage();
      void this.pages();
      void this.imageEdits();
      void this.addedImages();
      void this.textEdits();
      void this.layoutEdits();

      const pg = this.pg();
      const canvas = this.canvasRef()?.nativeElement;
      if (!pg || !canvas) return;

      const img = new Image();
      img.onload = async () => {
        if (cancelled) return;
        const c = this.canvasRef()?.nativeElement;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        c.width = img.width;
        c.height = img.height;
        ctx.drawImage(img, 0, 0);
        const pn = pg.pageNum;
        const iEd = this.imageEdits()[pn] || {};
        const tEd = this.textEdits()[pn] || {};
        const lEd = this.layoutEdits()[pn] || {};
        const bg = pg.bgColor || '#ffffff';
        for (const el of pg.textElements) {
          if (!tEd[el.id]?.maskOriginal) continue;
          const le = lEd[el.id] || {};
          const x = le.x ?? el.x;
          const y = le.y ?? el.y;
          const w = le.w ?? el.w;
          const h = le.h ?? el.h;
          ctx.fillStyle = bg;
          ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        }
        for (const el of pg.images) {
          const ed = iEd[el.id];
          if (ed?.removed) {
            ctx.fillStyle = bg;
            ctx.fillRect(el.x, el.y, el.w, el.h);
          }
        }
        for (const el of pg.images) {
          const ed = iEd[el.id];
          if (!ed?.src || ed?.removed) continue;
          const ox = ed?.x ?? el.x;
          const oy = ed?.y ?? el.y;
          const ow = ed?.w ?? el.w;
          const oh = ed?.h ?? el.h;
          if (ox !== el.x || oy !== el.y || ow !== el.w || oh !== el.h) {
            ctx.fillStyle = bg;
            ctx.fillRect(el.x, el.y, el.w, el.h);
          }
          await drawImageFit(ctx, ed.src, ox, oy, ow, oh);
          if (cancelled) return;
        }
        for (const el of this.addedImages()[pn] || []) {
          await drawImageFit(ctx, el.src!, el.x, el.y, el.w, el.h);
          if (cancelled) return;
        }
      };
      img.src = pg.fullUrl;
    });
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'file')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (k === 'z' && e.shiftKey) {
        e.preventDefault();
        this.redo();
      } else if (k === 'y') {
        e.preventDefault();
        this.redo();
      }
    };
    this.w.addEventListener('keydown', onKey);
    this.destroyRef.onDestroy(() => this.w.removeEventListener('keydown', onKey));
  }

  private revokeVideoBlobs(map: AddedVideosMap): void {
    (Object.values(map) as VideoElement[][]).forEach((arr: VideoElement[]) => {
      arr.forEach((v: VideoElement) => {
        if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
      });
    });
  }

  private defaultMargins(): NonNullable<ProposalSection['margins']> {
    return { top: 48, right: 48, bottom: 48, left: 48 };
  }

  private headingForPage(pageNum: number): string | null {
    const hit = this.detectedHeadings().find((h) => h.pageNum === pageNum) || null;
    return hit?.title ?? null;
  }

  private detectHeadingsFromPages(pages: PageData[]): { key: string; title: string; pageNum: number }[] {
    // Heuristic: pick the largest text element in the top 25% of each page.
    const out: { key: string; title: string; pageNum: number }[] = [];
    const seen = new Set<string>();
    for (const pg of pages) {
      const topCutoff = pg.height * 0.25;
      const candidates = (pg.textElements || [])
        .filter((t) => (t?.content || '').trim().length >= 3)
        .filter((t) => t.y <= topCutoff)
        .filter((t) => (t.style?.fontSize ?? 0) >= 10)
        .sort((a, b) => (b.style?.fontSize ?? 0) - (a.style?.fontSize ?? 0));
      const best = candidates[0];
      if (!best) continue;
      const title = best.content.trim().replace(/\s+/g, ' ').slice(0, 80);
      const norm = title.toLowerCase();
      if (!title) continue;
      // Keep duplicates if they occur on different pages but same heading is common (e.g. footer),
      // so only dedupe when it repeats on adjacent pages.
      const adjKey = `${norm}::${pg.pageNum}`;
      if (seen.has(adjKey)) continue;
      seen.add(adjKey);
      out.push({ key: `h_${pg.pageNum}_${best.id}`, title, pageNum: pg.pageNum });
    }
    return out;
  }

  private buildMandatorySections(): ProposalSection[] {
    const n = this.pages().length;
    const coverTitle = this.headingForPage(1) ?? 'Cover Page';
    const acceptanceTitle = this.headingForPage(Math.max(1, n)) ?? 'Acceptance Page';
    return [
      {
        id: 'sec_mandatory_cover',
        catalogId: 'cover',
        title: coverTitle,
        mandatory: true,
        margins: this.defaultMargins(),
        startPageNum: 1,
      },
      {
        id: 'sec_mandatory_acceptance',
        catalogId: 'acceptance',
        title: acceptanceTitle,
        mandatory: true,
        margins: this.defaultMargins(),
        startPageNum: Math.max(1, n),
      },
    ];
  }

  private normalizeSections(input: ProposalSection[]): ProposalSection[] {
    const base = Array.isArray(input) ? input : [];
    const [cover, acceptance] = this.buildMandatorySections();
    const middle = base
      .filter((s) => !this.mandatoryCatalogIds.has(s.catalogId))
      .map((s) => ({
        ...s,
        mandatory: false,
        margins: s.margins ?? this.defaultMargins(),
        startPageNum: s.startPageNum,
      }));
    return [cover!, ...middle, acceptance!];
  }

  /** Ensures `proposalSections` always contains Cover first, Acceptance last. */
  private ensureMandatorySections(): void {
    const normalized = this.normalizeSections(this.proposalSections());
    const cur = this.proposalSections();
    const same =
      cur.length === normalized.length &&
      cur.every((c, i) => c.catalogId === normalized[i]!.catalogId && c.title === normalized[i]!.title);
    if (!same) this.proposalSections.set(normalized);
  }

  private hasOnlyMandatorySections(list: ProposalSection[]): boolean {
    const secs = Array.isArray(list) ? list : [];
    if (secs.length <= 2) return true;
    return secs.every((s) => this.isMandatorySection(s) || this.mandatoryCatalogIds.has(s.catalogId));
  }

  /**
   * Default behavior: select all sections from detected headings.
   * Only applies when there is no existing (saved) section structure beyond mandatory.
   */
  private seedAllSectionsFromDetectedHeadingsIfEmpty(): void {
    const cur = this.proposalSections();
    if (!this.hasOnlyMandatorySections(cur)) return;
    const pages = this.pages();
    if (pages.length < 1) return;

    const n = pages.length;
    const headings = this.detectedHeadings()
      .filter((h) => h.pageNum !== 1 && h.pageNum !== n)
      .sort((a, b) => a.pageNum - b.pageNum);

    const middle: ProposalSection[] = headings.map((h) => ({
      id: `sec_auto_${h.pageNum}_${Math.random().toString(36).slice(2, 8)}`,
      catalogId: `detected:${h.pageNum}`,
      title: h.title,
      mandatory: false,
      margins: this.defaultMargins(),
      startPageNum: h.pageNum,
    }));

    this.proposalSections.set(this.normalizeSections(middle));
    this.activeSectionId.set('sec_mandatory_cover');
  }

  isMandatorySection(sec: ProposalSection): boolean {
    return !!sec.mandatory || this.mandatoryCatalogIds.has(sec.catalogId);
  }

  sectionLabel(sec: ProposalSection): string {
    return this.isMandatorySection(sec) ? `${sec.title} *` : sec.title;
  }

  /** Map a section click to a reasonable page jump (single-page canvas UI). */
  goToSection(sec: ProposalSection): void {
    const pages = this.pages();
    if (!pages.length) return;
    this.ensureMandatorySections();
    const last = pages.length - 1;
    if (sec.catalogId === 'cover') {
      this.selPage.set(0);
      this.activeSectionId.set(sec.id);
      this.selEl.set(null);
      return;
    }
    if (sec.catalogId === 'acceptance') {
      this.selPage.set(last);
      this.activeSectionId.set(sec.id);
      this.selEl.set(null);
      return;
    }
    const pn = this.sectionStartPageNum(sec);
    const pageIdx = Math.min(last - 1, Math.max(1, pn - 1));
    this.selPage.set(pageIdx);
    this.activeSectionId.set(sec.id);
    this.selEl.set(null);
  }

  sectionStartPageNum(sec: ProposalSection): number {
    const n = this.pages().length;
    if (sec.catalogId === 'cover') return 1;
    if (sec.catalogId === 'acceptance') return Math.max(1, n);
    const v = sec.startPageNum;
    if (typeof v === 'number' && Number.isFinite(v)) {
      // clamp to inner pages when possible
      if (n >= 3) return Math.min(Math.max(2, v), n - 1);
      return Math.min(Math.max(1, v), n);
    }
    // default to page 2 when we have enough pages
    return n >= 2 ? 2 : 1;
  }

  sectionRange(sec: ProposalSection): { start: number; end: number } {
    const n = this.pages().length;
    if (!n) return { start: 1, end: 1 };
    const secs = this.proposalSections();
    const start = this.sectionStartPageNum(sec);
    const nextStart = secs
      .filter((s) => s.id !== sec.id)
      .map((s) => this.sectionStartPageNum(s))
      .filter((pn) => pn > start)
      .sort((a, b) => a - b)[0];
    const end = Math.min(n, Math.max(start, (nextStart ?? n + 1) - 1));
    return { start, end };
  }

  sectionRangeLabel(sec: ProposalSection): string {
    const r = this.sectionRange(sec);
    return r.start === r.end ? `p${r.start}` : `p${r.start}–p${r.end}`;
  }

  deletePagesForSection(sec: ProposalSection): void {
    const pages = this.pages();
    const n = pages.length;
    if (!n) return;
    if (this.isMandatorySection(sec)) {
      alert('Cannot delete pages for mandatory sections.');
      return;
    }
    const r = this.sectionRange(sec);
    // Never delete cover (p1) or acceptance (plast).
    const start = Math.max(2, r.start);
    const end = Math.min(n - 1, r.end);
    if (start > end) {
      alert('This section has no deletable pages (cover and acceptance pages are protected).');
      return;
    }
    const count = end - start + 1;
    if (
      !confirm(
        `Delete ${count} page${count === 1 ? '' : 's'} in “${sec.title}” (${start === end ? `p${start}` : `p${start}–p${end}`})? Undo is available.`,
      )
    ) {
      return;
    }
    this.deletePagesByPageNumRange(start, end);
  }

  private deletePagesByPageNumRange(startPn: number, endPn: number): void {
    const pages = this.pages();
    if (!pages.length) return;
    const n = pages.length;
    const start = Math.min(Math.max(1, startPn), n);
    const end = Math.min(Math.max(1, endPn), n);
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    const removed: number[] = [];
    for (let pn = a; pn <= b; pn++) removed.push(pn);
    if (removed.length >= n) {
      alert('A PDF must keep at least one page.');
      return;
    }

    this.captureBeforeChange();

    // Revoke video blobs on removed pages.
    for (const pn of removed) {
      ((this.addedVideos()[pn] || []) as VideoElement[]).forEach((v: VideoElement) => {
        if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
      });
    }

    const removedSet = new Set<number>(removed);
    const newPages = pages
      .filter((p) => !removedSet.has(p.pageNum))
      .map((p, i) => ({ ...p, pageNum: i + 1 }));

    // Remap page-keyed state by applying single-page remaps in ascending order.
    const applyMany = <T extends Record<number, any>>(m: T): T => {
      let out = m;
      for (const pn of removed) out = remapPageKeyedState(out, pn) as T;
      return out;
    };

    this.pages.set(newPages);
    this.templates.set(clusterTemplates(newPages));
    this.imageEdits.update((prev) => applyMany(prev));
    this.layoutEdits.update((prev) => applyMany(prev));
    this.addedImages.update((prev) => applyMany(prev));
    this.addedVideos.update((prev) => applyMany(prev));
    this.addedTables.update((prev) => applyMany(prev));
    this.addedRichTexts.update((prev) => applyMany(prev));

    // Shift section startPageNum values that occur after deleted pages.
    const removedBefore = (pn: number) => removed.filter((x) => x < pn).length;
    this.proposalSections.update((list) =>
      this.normalizeSections(
        list.map((s) => {
          if (this.isMandatorySection(s)) return s;
          const sp = s.startPageNum;
          if (typeof sp !== 'number' || !Number.isFinite(sp)) return s;
          const next = sp - removedBefore(sp);
          return { ...s, startPageNum: Math.max(2, Math.min(next, Math.max(2, newPages.length - 1))) };
        }),
      ),
    );
    this.ensureMandatorySections();

    this.selEl.set(null);
    const nextIdx = Math.min(Math.max(0, this.selPage()), Math.max(0, newPages.length - 1));
    this.selPage.set(nextIdx);
    this.setActiveSectionFromPage();
  }

  onSectionStartPageChange(sectionId: string, e: Event): void {
    const raw = (e.target as HTMLSelectElement).value;
    const pn = Number.parseInt(raw, 10);
    if (!Number.isFinite(pn)) return;
    this.sectionModalDraft.update((list) =>
      list.map((s) => (s.id === sectionId ? { ...s, startPageNum: pn } : s)),
    );
  }

  /** Keeps the section highlight in sync when user clicks a page thumbnail. */
  setActiveSectionFromPage(): void {
    this.ensureMandatorySections();
    const secs = this.proposalSections();
    const pages = this.pages();
    if (!secs.length || !pages.length) return;
    const pageIdx = this.selPage();
    if (pageIdx <= 0) {
      this.activeSectionId.set(secs[0]!.id);
      return;
    }
    if (pageIdx >= pages.length - 1) {
      this.activeSectionId.set(secs[secs.length - 1]!.id);
      return;
    }
    // Pick the latest section whose startPageNum is <= current pageNum
    const curPn = pageIdx + 1;
    const mids = secs.filter((s) => !this.isMandatorySection(s));
    let best: ProposalSection | null = null;
    for (const s of mids) {
      const sp = this.sectionStartPageNum(s);
      if (sp <= curPn && (!best || sp >= this.sectionStartPageNum(best))) best = s;
    }
    this.activeSectionId.set(best?.id ?? secs[0]!.id);
  }

  private resetEditorStateForNewLoad(): void {
    this.loading.set(true);
    this.progress.set(0);
    this.doneCount.set(0);
    this.pages.set([]);
    this.selPage.set(0);
    this.selEl.set(null);
    this.imageEdits.set({});
    this.layoutEdits.set({});
    this.textEdits.set({});
    this.addedImages.set({});
    this.addedVideos.set({});
    this.addedTables.set({});
    this.addedRichTexts.set({});
    this.historyStack = [];
    this.redoStack = [];
    this.historyUi.update((u) => u + 1);
    this.activeSectionId.set('sec_mandatory_cover');
    this.proposalSections.set(this.normalizeSections([]));
  }

  private computeCenteredPlacementRect(
    pg: PageData,
    w: number,
    h: number,
    centerX?: number,
    centerY?: number,
  ): { x: number; y: number } {
    const b = this.pageContentBounds(pg.pageNum);
    if (typeof centerX === 'number' && typeof centerY === 'number' && !Number.isNaN(centerX) && !Number.isNaN(centerY)) {
      const x = Math.min(Math.max(centerX - w / 2, b.minX), Math.max(b.minX, b.maxX - w));
      const y = Math.min(Math.max(centerY - h / 2, b.minY), Math.max(b.minY, b.maxY - h));
      return { x, y };
    }
    const x = b.minX + Math.max(0, (Math.max(0, b.maxX - b.minX) - w) / 2);
    const y = b.minY + Math.max(0, (Math.max(0, b.maxY - b.minY) - h) / 2);
    return { x, y };
  }

  canUndo(): boolean {
    void this.historyUi();
    return this.historyStack.length > 0;
  }

  canRedo(): boolean {
    void this.historyUi();
    return this.redoStack.length > 0;
  }

  captureBeforeChange(): void {
    if (this.isRestoring) return;
    const snap: HistorySnapshot = {
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      textEdits: structuredClone(this.textEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
    };
    this.historyStack = [...this.historyStack.slice(-39), snap];
    this.redoStack = [];
    this.historyUi.update((u) => u + 1);
  }

  undo(): void {
    if (this.historyStack.length === 0) return;
    this.isRestoring = true;
    const current: HistorySnapshot = {
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      textEdits: structuredClone(this.textEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
    };
    this.redoStack.push(current);
    const prev = this.historyStack.pop()!;
    this.imageEdits.set(prev.imageEdits);
    this.layoutEdits.set(prev.layoutEdits ?? {});
    this.textEdits.set(prev.textEdits ?? {});
    this.addedImages.set(prev.addedImages);
    this.addedVideos.set(prev.addedVideos);
    this.addedTables.set(prev.addedTables || {});
    this.addedRichTexts.set(prev.addedRichTexts || {});
    this.selEl.set(null);
    this.historyUi.update((u) => u + 1);
    queueMicrotask(() => {
      this.isRestoring = false;
    });
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    this.isRestoring = true;
    const current: HistorySnapshot = {
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      textEdits: structuredClone(this.textEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
    };
    this.historyStack.push(current);
    const next = this.redoStack.pop()!;
    this.imageEdits.set(next.imageEdits);
    this.layoutEdits.set(next.layoutEdits ?? {});
    this.textEdits.set(next.textEdits ?? {});
    this.addedImages.set(next.addedImages);
    this.addedVideos.set(next.addedVideos);
    this.addedTables.set(next.addedTables || {});
    this.addedRichTexts.set(next.addedRichTexts || {});
    this.selEl.set(null);
    this.historyUi.update((u) => u + 1);
    queueMicrotask(() => {
      this.isRestoring = false;
    });
  }

  totalEdits(): number {
    const le = this.layoutEdits();
    const te = this.textEdits();
    const geom = Object.values(le as LayoutEditsMap).reduce(
      (s: number, o: Record<string, unknown>) => s + Object.keys(o || {}).length,
      0,
    );
    const content = Object.values(te as TextEditsMap).reduce(
      (s: number, o: Record<string, unknown>) => s + Object.keys(o || {}).length,
      0,
    );
    return geom + content;
  }

  pageHasImageMods(pn: number): boolean {
    return (
      Object.keys(this.imageEdits()[pn] || {}).length > 0 ||
      (this.addedImages()[pn] || []).length > 0 ||
      (this.addedVideos()[pn] || []).length > 0 ||
      (this.addedTables()[pn] || []).length > 0 ||
      (this.addedRichTexts()[pn] || []).length > 0
    );
  }

  totalImageMods(): number {
    const ai = this.addedImages();
    const av = this.addedVideos();
    const at = this.addedTables();
    const ar = this.addedRichTexts();
    return (
      Object.values(this.imageEdits() as ImageEditsMap).reduce(
        (s: number, o: Record<string, unknown>) => s + Object.keys(o).length,
        0,
      ) +
      (Object.values(ai) as ImageElement[][]).reduce((s: number, arr) => s + arr.length, 0) +
      (Object.values(av) as VideoElement[][]).reduce((s: number, arr) => s + arr.length, 0) +
      (Object.values(at) as TableElement[][]).reduce((s: number, arr) => s + arr.length, 0) +
      (Object.values(ar) as UserTextElement[][]).reduce((s: number, arr) => s + arr.length, 0)
    );
  }

  deletePageAtIndex(delIdx: number): void {
    const pages = this.pages();
    if (pages.length <= 1) {
      alert('A PDF must keep at least one page.');
      return;
    }
    const delPn = pages[delIdx]?.pageNum;
    if (delPn === undefined) return;
    if (!confirm(`Delete page ${delPn}? You can use Undo (⌘Z / Ctrl+Z) to restore.`)) return;
    this.captureBeforeChange();
    ((this.addedVideos()[delPn] || []) as VideoElement[]).forEach((v: VideoElement) => {
      if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
    });
    const n = pages.length;
    const newPages = pages.filter((_, i) => i !== delIdx).map((p, i) => ({ ...p, pageNum: i + 1 }));
    this.pages.set(newPages);
    this.templates.set(clusterTemplates(newPages));
    this.imageEdits.update((prev) => remapPageKeyedState(prev, delPn));
    this.layoutEdits.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedImages.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedVideos.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedTables.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedRichTexts.update((prev) => remapPageKeyedState(prev, delPn));
    this.selEl.set(null);
    this.selPage.update((prev) => {
      if (delIdx < prev) return prev - 1;
      if (delIdx === prev) return Math.min(delIdx, n - 2);
      return prev;
    });
  }

  addPageAfterCurrent(): void {
    const pages = this.pages();
    if (!pages.length) return;
    this.captureBeforeChange();
    const refPg = pages[this.selPage()] || pages[0];
    const W = refPg.width;
    const H = refPg.height;
    const insertIdx = this.selPage() + 1;
    const insert1Based = insertIdx + 1;
    const blank = createBlankPageData(W, H, refPg.bgColor);
    const newPages = [...pages.slice(0, insertIdx), blank, ...pages.slice(insertIdx)].map((p, i) => ({
      ...p,
      pageNum: i + 1,
    }));
    this.pages.set(newPages);
    this.templates.set(clusterTemplates(newPages));
    this.imageEdits.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.layoutEdits.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedImages.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedVideos.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedTables.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedRichTexts.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.selEl.set(null);
    this.selPage.set(insertIdx);
  }

  async handleUpload(file: File): Promise<void> {
    this.revokeVideoBlobs(this.addedVideos());
    this.resetEditorStateForNewLoad();
    try {
      const buf = await file.arrayBuffer();
      this.openedPdfId = null;
      await this.loadPdfFromBuffer(buf);
    } catch (err: unknown) {
      console.error(err);
      alert('Error: ' + (err instanceof Error ? err.message : String(err)));
    }
    this.loading.set(false);
  }

  private async openPdfById(pdfId: string): Promise<void> {
    this.openedPdfId = pdfId;
    this.resetEditorStateForNewLoad();
    try {
      try {
        const meta = await firstValueFrom(this.pdfsApi.getPdfMeta(pdfId));
        if (meta?.pdf?.title) this.pdfTitle.set(meta.pdf.title);
      } catch { /* title is optional */ }
      const buf = await firstValueFrom(this.pdfsApi.getPdfFile(pdfId));
      await this.loadPdfFromBuffer(buf);
      await this.applySavedStateForPdf(pdfId);
    } catch (err: unknown) {
      console.error(err);
      alert('Error loading PDF: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadPdfFromBuffer(buf: ArrayBuffer): Promise<void> {
    this.loadedPdfBuf = buf.slice(0);
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const n = pdf.numPages;
    this.totalPgs.set(n);
    const all: PageData[] = [];
    for (let i = 1; i <= n; i++) {
      const pg = await pdf.getPage(i);
      const data = await extractPage(pg, i);
      all.push(data);
      this.doneCount.set(i);
      this.progress.set(Math.round((i / n) * 100));
      this.pages.set([...all]);
    }
    const clusters = clusterTemplates(all);
    all.forEach((pd) => {
      const c = clusters.find((cl) => cl.pageNums.includes(pd.pageNum));
      if (c) pd.templateId = c.id;
    });
    this.templates.set(clusters);
    this.pages.set([...all]);
    const ac = new Set<string>();
    const af = new Set<string>();
    const asz = new Set<number>();
    all.forEach((pd) => {
      pd.docColors.forEach((c) => ac.add(c));
      pd.textElements.forEach((e) => {
        if (e.style.fontFamily && e.style.fontFamily !== 'Unknown') af.add(e.style.fontFamily);
        if (e.style.fontSize > 0) asz.add(e.style.fontSize);
      });
    });
    this.tokens.set({
      colors: [...ac].filter((c) => !c.includes('NaN')).slice(0, 40),
      fonts: [...af].slice(0, 12),
      sizes: [...asz].sort((a, b) => a - b).slice(0, 20),
    });

    // Default: auto-select sections from document headings.
    this.ensureMandatorySections();
    this.seedAllSectionsFromDetectedHeadingsIfEmpty();
  }

  private async applySavedStateForPdf(pdfId: string): Promise<void> {
    try {
      const res = await firstValueFrom(this.pdfsApi.getPdfState(pdfId));
      const payload = res?.state?.state;
      if (!payload || typeof payload !== 'object') return;
      const s = payload as Partial<{
        tokens: DesignTokens;
        imageEdits: ImageEditsMap;
        layoutEdits: LayoutEditsMap;
        textEdits: TextEditsMap;
        addedImages: AddedImagesMap;
        addedVideos: AddedVideosMap;
        addedTables: AddedTablesMap;
        addedRichTexts: AddedRichTextsMap;
        proposalSections: ProposalSection[];
        selPage: number;
        zoom: number;
        editorMode: 'edit' | 'view';
        activeAddTool: 'image' | 'video' | 'table' | 'userText' | null;
      }>;

      if (s.tokens) this.tokens.set(s.tokens);
      if (Array.isArray(s.proposalSections)) this.proposalSections.set(this.normalizeSections(s.proposalSections));
      if (s.imageEdits) this.imageEdits.set(s.imageEdits);
      if (s.layoutEdits) this.layoutEdits.set(s.layoutEdits);
      if (s.textEdits) this.textEdits.set(s.textEdits);
      if (s.addedImages) this.addedImages.set(s.addedImages);
      if (s.addedVideos) this.addedVideos.set(s.addedVideos);
      if (s.addedTables) this.addedTables.set(s.addedTables);
      if (s.addedRichTexts) this.addedRichTexts.set(s.addedRichTexts);
      if (typeof s.zoom === 'number') this.zoom.set(s.zoom);
      if (s.editorMode === 'view' || s.editorMode === 'edit') this.editorMode.set(s.editorMode);
      if (
        s.activeAddTool === null ||
        s.activeAddTool === 'image' ||
        s.activeAddTool === 'video' ||
        s.activeAddTool === 'table' ||
        s.activeAddTool === 'userText'
      ) {
        this.activeAddTool.set(s.activeAddTool);
      }
      if (typeof s.selPage === 'number') {
        const maxIdx = Math.max(0, this.pages().length - 1);
        this.selPage.set(Math.min(Math.max(0, s.selPage), maxIdx));
      }
      this.ensureMandatorySections();
      this.seedAllSectionsFromDetectedHeadingsIfEmpty();
    } catch (err: unknown) {
      console.error(err);
    }
  }

  private currentPdfEditorState(): unknown {
    return {
      tokens: structuredClone(this.tokens()),
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      textEdits: structuredClone(this.textEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
      proposalSections: structuredClone(this.proposalSections()),
      selPage: this.selPage(),
      zoom: this.zoom(),
      editorMode: this.editorMode(),
      activeAddTool: this.activeAddTool(),
    };
  }

  async saveEdits(): Promise<void> {
    if (!this.openedPdfId) {
      alert('Saved (local).');
      return;
    }
    await firstValueFrom(this.pdfsApi.putPdfState(this.openedPdfId, this.currentPdfEditorState()));
    alert('Saved.');
  }

  patchImageEdit(
    pageNum: number,
    id: string,
    patch: { removed?: boolean; src?: string; x?: number; y?: number; w?: number; h?: number },
  ): void {
    this.imageEdits.update((prev) => ({
      ...prev,
      [pageNum]: { ...(prev[pageNum] || {}), [id]: { ...(prev[pageNum]?.[id] || {}), ...patch } },
    }));
  }

  async addImageFromFile(file: File, centerX?: number, centerY?: number): Promise<void> {
    if (!isLikelyImageFile(file)) return;
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const src = await readFileAsDataURL(file);
    const pn = pg.pageNum;
    const id = `user_${pn}_${Date.now()}`;
    const w = Math.min(240, pg.width * 0.4);
    const h = Math.min(200, pg.height * 0.3);
    const { x, y } = this.computeCenteredPlacementRect(pg, w, h, centerX, centerY);
    this.addedImages.update((prev) => ({
      ...prev,
      [pn]: [...(prev[pn] || []), { id, type: 'image', x, y, w, h, src, _userAdded: true }],
    }));
    this.editorMode.set('edit');
    this.activeAddTool.set('image');
  }

  async addVideoFromFile(file: File, centerX?: number, centerY?: number): Promise<void> {
    if (!isLikelyVideoFile(file)) return;
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const src = URL.createObjectURL(file);
    const pn = pg.pageNum;
    const id = `vid_${pn}_${Date.now()}`;
    const w = Math.min(320, pg.width * 0.5);
    const h = Math.min(220, pg.height * 0.36);
    const { x, y } = this.computeCenteredPlacementRect(pg, w, h, centerX, centerY);
    this.addedVideos.update((prev) => ({
      ...prev,
      [pn]: [...(prev[pn] || []), { id, type: 'video', x, y, w, h, src, _userAdded: true }],
    }));
    this.editorMode.set('edit');
    this.activeAddTool.set('video');
  }

  handleReplaceVideo(el: VideoElement, file: File): void {
    if (!isLikelyVideoFile(file)) return;
    this.captureBeforeChange();
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    const next = URL.createObjectURL(file);
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
    this.addedVideos.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as VideoElement[]).map((a) => (a.id === el.id ? { ...a, src: next } : a)),
    }));
  }

  handleRemoveVideo(el: VideoElement): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
    this.addedVideos.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as VideoElement[]).filter((a) => a.id !== el.id),
    }));
    this.selEl.set(null);
  }

  addDynamicTable(): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    const id = `tbl_${pn}_${Date.now()}`;
    const rows = 4;
    const cols = 3;
    const w = Math.min(340, Math.max(120, pg.width * 0.5));
    const h = Math.min(220, Math.max(80, pg.height * 0.28));
    const { x, y } = this.computeCenteredPlacementRect(pg, w, h);
    const tbl: TableElement = {
      id,
      type: 'table',
      x,
      y,
      w,
      h,
      rows,
      cols,
      cells: ensureTableCells(rows, cols, undefined),
      _userAdded: true,
    };
    this.addedTables.update((prev) => ({
      ...prev,
      [pn]: [...(prev[pn] || []), tbl],
    }));
    this.editorMode.set('edit');
    this.activeAddTool.set('table');
    this.selEl.set(tbl);
  }

  patchTable(el: TableElement, patch: Partial<TableElement>): void {
    const pg = this.pages()[this.selPage()];
    if (!pg || el.type !== 'table') return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    this.addedTables.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as TableElement[]).map((t) => {
        if (t.id !== el.id) return t;
        const next = { ...t, ...patch };
        if (patch.rows != null || patch.cols != null) {
          const r = patch.rows != null ? patch.rows : t.rows;
          const c = patch.cols != null ? patch.cols : t.cols;
          next.cells = ensureTableCells(r, c, t.cells);
        }
        return next;
      }),
    }));
    this.selEl.update((prev) => {
      if (prev?.id !== el.id || prev?.type !== 'table') return prev;
      const merged = { ...prev, ...patch } as TableElement;
      if (patch.rows != null || patch.cols != null) {
        const r = patch.rows != null ? patch.rows : prev.rows;
        const c = patch.cols != null ? patch.cols : prev.cols;
        merged.cells = ensureTableCells(r, c, prev.cells);
      }
      return merged;
    });
  }

  updateTableCellHtml(tableId: string, ri: number, ci: number, innerHtml: string): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    this.addedTables.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as TableElement[]).map((t) => {
        if (t.id !== tableId) return t;
        const cells = ensureTableCells(t.rows, t.cols, t.cells);
        cells[ri][ci] = innerHtml;
        return { ...t, cells };
      }),
    }));
    this.selEl.update((prev) => {
      if (prev?.id !== tableId || prev?.type !== 'table') return prev;
      const p = prev as TableElement;
      const cells = ensureTableCells(p.rows, p.cols, p.cells);
      cells[ri][ci] = innerHtml;
      return { ...p, cells };
    });
  }

  onPlacedTableCellFocus(tableId: string): void {
    if (this.tableUndoGate.tableId !== tableId) {
      this.captureBeforeChange();
      this.tableUndoGate = { tableId, armed: true };
    }
  }

  onPlacedUserTextFocus(id: string): void {
    if (this.placedTextUndoGate !== id) {
      this.captureBeforeChange();
    }
    this.placedTextUndoGate = id;
  }

  setUserTextSelection(id: string, hasSelection: boolean): void {
    this.userTextHasSelection.update((prev) => {
      if (prev[id] === hasSelection) return prev;
      return { ...prev, [id]: hasSelection };
    });
  }

  setUserTextFocus(id: string, focused: boolean): void {
    this.userTextHasFocus.update((prev) => {
      if (prev[id] === focused) return prev;
      return { ...prev, [id]: focused };
    });
  }

  onUserTextDragHandlePointerDown(e: PointerEvent, rt: UserTextElement, enabled: boolean): void {
    if (!enabled) return;
    e.stopPropagation();
    this.onImagePointerDown(e, rt);
  }

  onUserTextDragHandlePointerMove(e: PointerEvent, enabled: boolean): void {
    if (!enabled) return;
    this.onImagePointerMove(e);
  }

  onUserTextDragHandlePointerUp(e: PointerEvent, enabled: boolean): void {
    if (!enabled) return;
    this.onImagePointerUp(e);
  }

  onUserTextRemoveClick(e: MouseEvent, rt: UserTextElement, enabled: boolean): void {
    if (!enabled) return;
    e.stopPropagation();
    this.removeUserTextInspector(rt);
  }

  updateUserTextHtml(id: string, innerHtml: string): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    this.addedRichTexts.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as UserTextElement[]).map((b) => (b.id === id ? { ...b, html: innerHtml } : b)),
    }));
    const m = id.match(/^pdftext_(\d+)_(.+)$/);
    if (m) {
      const tPn = Number.parseInt(m[1]!, 10);
      const textId = m[2]!;
      this.textEdits.update((prev) => ({
        ...prev,
        [tPn]: {
          ...(prev[tPn] || {}),
          [textId]: { html: innerHtml, maskOriginal: true },
        },
      }));
    }
    this.selEl.update((prev) =>
      prev?.id === id && prev?.type === 'userText' ? { ...prev, html: innerHtml } : prev,
    );
  }

  patchUserTextBlock(el: UserTextElement, patch: Partial<UserTextElement>): void {
    if (el.type !== 'userText') return;
    this.captureBeforeChange();
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    this.addedRichTexts.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as UserTextElement[]).map((b) => (b.id === el.id ? { ...b, ...patch } : b)),
    }));
    this.selEl.update((prev) =>
      prev?.id === el.id ? ({ ...prev, ...patch } as SelElement) : prev,
    );
  }

  handleRemoveUserText(el: UserTextElement): void {
    if (el.type !== 'userText') return;
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    this.addedRichTexts.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as UserTextElement[]).filter((b) => b.id !== el.id),
    }));
    this.selEl.set(null);
    this.placedTextUndoGate = null;
  }

  handleRemoveTable(el: TableElement): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    this.addedTables.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as TableElement[]).filter((a) => a.id !== el.id),
    }));
    this.selEl.set(null);
  }

  async handleReplaceImage(el: ImageElement, file: File): Promise<void> {
    if (!isLikelyImageFile(file)) return;
    this.captureBeforeChange();
    const src = await readFileAsDataURL(file);
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    if (el._userAdded) {
      this.addedImages.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as ImageElement[]).map((a) => (a.id === el.id ? { ...a, src } : a)),
      }));
    } else {
      this.patchImageEdit(pn, el.id, { removed: false, src });
    }
  }

  handleViewerDragOver(e: DragEvent): void {
    if (!this.pages().length) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }

  handleViewerDragEnter(e: DragEvent): void {
    if (!this.pages().length) return;
    e.preventDefault();
    this.viewerImageDropActive.set(true);
  }

  handleViewerDragLeave(e: DragEvent): void {
    if (!e.currentTarget || !e.relatedTarget) {
      this.viewerImageDropActive.set(false);
      return;
    }
    if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) this.viewerImageDropActive.set(false);
  }

  async handleViewerDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    this.viewerImageDropActive.set(false);
    let file = await imageFileFromDataTransfer(e.dataTransfer);
    if (!file) file = Array.from(e.dataTransfer?.files || []).find(isLikelyVideoFile) || null;
    if (!file) return;
    this.editorMode.set('edit');
    const inner = this.pageStageRef()?.nativeElement;
    const pgLocal = this.pages()[this.selPage()];
    if (!inner || !pgLocal) return;
    const r = inner.getBoundingClientRect();
    const z = this.zoom();
    const x = (e.clientX - r.left) / z;
    const y = (e.clientY - r.top) / z;
    if (isLikelyVideoFile(file)) {
      const vhit = findVideoAtPagePoint(pgLocal.pageNum, this.addedVideos(), x, y);
      if (vhit) this.handleReplaceVideo(vhit, file);
      else await this.addVideoFromFile(file, x, y);
      return;
    }
    if (!isLikelyImageFile(file)) return;
    const hit = findImageAtPagePoint(pgLocal, pgLocal.pageNum, this.addedImages(), x, y, this.imageEdits());
    if (hit) await this.handleReplaceImage(hit, file);
    else await this.addImageFromFile(file, x, y);
  }

  clientToPageCoords(clientX: number, clientY: number): { x: number; y: number } {
    const inner = this.pageStageRef()?.nativeElement;
    if (!inner) return { x: 0, y: 0 };
    const r = inner.getBoundingClientRect();
    const z = this.zoom();
    return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
  }

  readonly resizeHandleList: readonly { id: ResizeHandleId; cursor: string }[] = [
    { id: 'nw', cursor: 'nw-resize' },
    { id: 'n', cursor: 'n-resize' },
    { id: 'ne', cursor: 'ne-resize' },
    { id: 'e', cursor: 'e-resize' },
    { id: 'se', cursor: 'se-resize' },
    { id: 's', cursor: 's-resize' },
    { id: 'sw', cursor: 'sw-resize' },
    { id: 'w', cursor: 'w-resize' },
  ];

  showOverlayResizeHandles(el: SelElement): boolean {
    if (this.editorMode() !== 'edit') return false;
    return el.type === 'image' || el.type === 'video' || el.type === 'text';
  }

  resizeHandlePositionStyle(id: ResizeHandleId): string {
    const pos: Record<ResizeHandleId, string> = {
      nw: 'left:0;top:0;transform:translate(-50%,-50%);',
      n: 'left:50%;top:0;transform:translate(-50%,-50%);',
      ne: 'left:100%;top:0;transform:translate(-50%,-50%);',
      e: 'left:100%;top:50%;transform:translate(-50%,-50%);',
      se: 'left:100%;top:100%;transform:translate(-50%,-50%);',
      s: 'left:50%;top:100%;transform:translate(-50%,-50%);',
      sw: 'left:0;top:100%;transform:translate(-50%,-50%);',
      w: 'left:0;top:50%;transform:translate(-50%,-50%);',
    };
    return (
      'position:absolute;' +
      pos[id] +
      'width:9px;height:9px;z-index:7;box-sizing:border-box;background:#fff;border:1.5px solid #2aacb8;border-radius:2px;'
    );
  }

  resizeHandleBoxStyle(rh: { id: ResizeHandleId; cursor: string }): string {
    return `${this.resizeHandlePositionStyle(rh.id)}cursor:${rh.cursor};`;
  }

  onResizeHandlePointerDown(e: PointerEvent, el: SelElement, handle: ResizeHandleId): void {
    if (e.button !== 0 || this.editorMode() !== 'edit') return;
    e.stopPropagation();
    e.preventDefault();
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    let mediaKind: NonNullable<ImageDragState['mediaKind']>;
    if (el.type === 'video') mediaKind = 'video';
    else if (el.type === 'table') mediaKind = 'table';
    else if (el.type === 'userText') mediaKind = 'userText';
    else if (el.type === 'text') mediaKind = 'text';
    else if (el.type === 'image') {
      const img = el as ImageElement;
      if (this.imageEdits()[pn]?.[img.id]?.removed) return;
      mediaKind = img._userAdded ? 'imageUser' : 'imagePdf';
    } else return;

    const ob = this.overlayBounds(el);
    const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
    const imgEl = el.type === 'image' ? (el as ImageElement) : null;
    this.imageDrag = {
      mode: 'resize',
      handle,
      startRect: { x: ob.x, y: ob.y, w: ob.w, h: ob.h },
      pointerId: e.pointerId,
      elId: el.id,
      pn,
      mediaKind,
      grabDx: 0,
      grabDy: 0,
      pw: pg.width,
      ph: pg.height,
      elW: ob.w,
      elH: ob.h,
      startPx: px,
      startPy: py,
      latestNX: ob.x,
      latestNY: ob.y,
      moved: false,
      captured: false,
      userAdded: imgEl ? !!imgEl._userAdded : undefined,
      fullUrl: imgEl && !imgEl._userAdded ? pg.fullUrl : undefined,
      pdfImageEl: imgEl && !imgEl._userAdded ? imgEl : undefined,
      extracting: false,
      extractDone: false,
    };
    this.draggingImageId.set(el.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private applyPlacementRect(d: ImageDragState, r: { x: number; y: number; w: number; h: number }): void {
    const { pn, elId } = d;
    const mk = d.mediaKind;
    if (mk === 'video') {
      this.addedVideos.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as VideoElement[]).map((a) => (a.id === elId ? { ...a, ...r } : a)),
      }));
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'video' ? ({ ...prev, ...r } as SelElement) : prev,
      );
      return;
    }
    if (mk === 'table') {
      this.addedTables.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as TableElement[]).map((a) => (a.id === elId ? { ...a, ...r } : a)),
      }));
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'table' ? ({ ...prev, ...r } as SelElement) : prev,
      );
      return;
    }
    if (mk === 'userText') {
      this.addedRichTexts.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as UserTextElement[]).map((a) => (a.id === elId ? { ...a, ...r } : a)),
      }));
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'userText' ? ({ ...prev, ...r } as SelElement) : prev,
      );
      return;
    }
    if (mk === 'text') {
      this.layoutEdits.update((prev) => ({
        ...prev,
        [pn]: {
          ...(prev[pn] || {}),
          [elId]: { ...(prev[pn]?.[elId] || {}), x: r.x, y: r.y, w: r.w, h: r.h },
        },
      }));
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'text' ? ({ ...prev, ...r } as SelElement) : prev,
      );
      return;
    }
    if (mk === 'imageUser') {
      this.addedImages.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as ImageElement[]).map((a) => (a.id === elId ? { ...a, ...r } : a)),
      }));
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'image' ? ({ ...prev, ...r } as SelElement) : prev,
      );
      return;
    }
    if (mk === 'imagePdf') {
      this.patchImageEdit(pn, elId, { x: r.x, y: r.y, w: r.w, h: r.h });
      this.selEl.update((prev) =>
        prev?.id === elId && prev.type === 'image' ? ({ ...prev, ...r } as SelElement) : prev,
      );
    }
  }

  onImagePointerDown(e: PointerEvent, el: SelElement): void {
    if (e.button !== 0) return;
    if (el.type === 'video') {
      e.stopPropagation();
      const pg = this.pages()[this.selPage()];
      if (!pg) return;
      const pn = pg.pageNum;
      const ob = { x: el.x, y: el.y, w: el.w, h: el.h };
      const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
      this.imageDrag = {
        pointerId: e.pointerId,
        elId: el.id,
        pn,
        mediaKind: 'video',
        grabDx: px - ob.x,
        grabDy: py - ob.y,
        pw: pg.width,
        ph: pg.height,
        elW: el.w,
        elH: el.h,
        startPx: px,
        startPy: py,
        latestNX: ob.x,
        latestNY: ob.y,
        moved: false,
        captured: false,
      };
      this.draggingImageId.set(el.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (el.type === 'table') {
      e.stopPropagation();
      const pg = this.pages()[this.selPage()];
      if (!pg) return;
      const pn = pg.pageNum;
      const ob = { x: el.x, y: el.y, w: el.w, h: el.h };
      const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
      this.imageDrag = {
        pointerId: e.pointerId,
        elId: el.id,
        pn,
        mediaKind: 'table',
        grabDx: px - ob.x,
        grabDy: py - ob.y,
        pw: pg.width,
        ph: pg.height,
        elW: el.w,
        elH: el.h,
        startPx: px,
        startPy: py,
        latestNX: ob.x,
        latestNY: ob.y,
        moved: false,
        captured: false,
      };
      this.draggingImageId.set(el.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (el.type === 'userText') {
      e.stopPropagation();
      const pg = this.pages()[this.selPage()];
      if (!pg) return;
      const pn = pg.pageNum;
      const ob = { x: el.x, y: el.y, w: el.w, h: el.h };
      const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
      this.imageDrag = {
        pointerId: e.pointerId,
        elId: el.id,
        pn,
        mediaKind: 'userText',
        grabDx: px - ob.x,
        grabDy: py - ob.y,
        pw: pg.width,
        ph: pg.height,
        elW: el.w,
        elH: el.h,
        startPx: px,
        startPy: py,
        latestNX: ob.x,
        latestNY: ob.y,
        moved: false,
        captured: false,
      };
      this.draggingImageId.set(el.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (el.type === 'text') {
      e.stopPropagation();
      const pg = this.pages()[this.selPage()];
      if (!pg) return;
      const pn = pg.pageNum;
      const ob = this.overlayBounds(el);
      const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
      this.imageDrag = {
        pointerId: e.pointerId,
        elId: el.id,
        pn,
        mediaKind: 'text',
        grabDx: px - ob.x,
        grabDy: py - ob.y,
        pw: pg.width,
        ph: pg.height,
        elW: ob.w,
        elH: ob.h,
        startPx: px,
        startPy: py,
        latestNX: ob.x,
        latestNY: ob.y,
        moved: false,
        captured: false,
      };
      this.draggingImageId.set(el.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (el.type !== 'image') return;
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    const imgEl = el as ImageElement;
    const ed = this.imageEdits()[pn]?.[imgEl.id];
    if (ed?.removed) return;
    e.stopPropagation();
    const ob = getImageOverlayBounds(imgEl, pn, this.imageEdits());
    const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);
    this.imageDrag = {
      pointerId: e.pointerId,
      elId: imgEl.id,
      pn,
      mediaKind: imgEl._userAdded ? 'imageUser' : 'imagePdf',
      userAdded: !!imgEl._userAdded,
      grabDx: px - ob.x,
      grabDy: py - ob.y,
      pw: pg.width,
      ph: pg.height,
      elW: ob.w,
      elH: ob.h,
      startPx: px,
      startPy: py,
      latestNX: ob.x,
      latestNY: ob.y,
      moved: false,
      captured: false,
      extracting: false,
      extractDone: false,
      fullUrl: pg.fullUrl,
      pdfImageEl: imgEl._userAdded ? null : imgEl,
    };
    this.draggingImageId.set(imgEl.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onImagePointerMove(e: PointerEvent): void {
    const d = this.imageDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const { x: px, y: py } = this.clientToPageCoords(e.clientX, e.clientY);

    if (d.mode === 'resize' && d.handle && d.startRect) {
      if (!d.moved && Math.hypot(px - d.startPx, py - d.startPy) < 2) return;
      if (!d.moved) {
        d.moved = true;
        if (!d.captured) {
          this.captureBeforeChange();
          d.captured = true;
        }
      }
      const rawNr = rectFromResizeHandle(d.handle, d.startRect, px, py, d.pw, d.ph);
      const obstacles = this.placementObstacleRects(d.pn, d.elId);
      const nr = this.resolvePlacementInContentBounds(d.pn, rawNr, obstacles, d.pw, d.ph, {
        preferX: rawNr.x,
        preferY: rawNr.y,
        allowShrink: true,
      });
      this.applyPlacementRect(d, nr);
      d.latestNX = nr.x;
      d.latestNY = nr.y;
      return;
    }

    if (!d.moved && Math.hypot(px - d.startPx, py - d.startPy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (!d.captured) {
        this.captureBeforeChange();
        d.captured = true;
      }
    }
    let nx = px - d.grabDx;
    let ny = py - d.grabDy;
    const b = this.pageContentBounds(d.pn);
    nx = Math.min(Math.max(b.minX, nx), Math.max(b.minX, b.maxX - d.elW));
    ny = Math.min(Math.max(b.minY, ny), Math.max(b.minY, b.maxY - d.elH));
    const moveObs = this.placementObstacleRects(d.pn, d.elId);
    const resolved = this.resolvePlacementInContentBounds(
      d.pn,
      { x: nx, y: ny, w: d.elW, h: d.elH },
      moveObs,
      d.pw,
      d.ph,
      { preferX: nx, preferY: ny, allowShrink: false },
    );
    nx = resolved.x;
    ny = resolved.y;
    d.latestNX = nx;
    d.latestNY = ny;

    if (d.mediaKind === 'video') {
      this.addedVideos.update((prev) => ({
        ...prev,
        [d.pn]: ((prev[d.pn] || []) as VideoElement[]).map((a) => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      this.selEl.update((prev) =>
        prev && prev.id === d.elId && prev.type === 'video' ? { ...prev, x: nx, y: ny } : prev,
      );
      return;
    }

    if (d.mediaKind === 'table') {
      this.addedTables.update((prev) => ({
        ...prev,
        [d.pn]: ((prev[d.pn] || []) as TableElement[]).map((a) => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      this.selEl.update((prev) =>
        prev && prev.id === d.elId && prev.type === 'table' ? { ...prev, x: nx, y: ny } : prev,
      );
      return;
    }

    if (d.mediaKind === 'userText') {
      this.addedRichTexts.update((prev) => ({
        ...prev,
        [d.pn]: ((prev[d.pn] || []) as UserTextElement[]).map((a) => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      this.selEl.update((prev) =>
        prev && prev.id === d.elId && prev.type === 'userText' ? { ...prev, x: nx, y: ny } : prev,
      );
      return;
    }

    if (d.mediaKind === 'text') {
      this.layoutEdits.update((prev) => ({
        ...prev,
        [d.pn]: {
          ...(prev[d.pn] || {}),
          [d.elId]: {
            ...(prev[d.pn]?.[d.elId] || {}),
            x: nx,
            y: ny,
          },
        },
      }));
      this.selEl.update((prev) =>
        prev && prev.id === d.elId && prev.type === 'text' ? { ...prev, x: nx, y: ny } : prev,
      );
      return;
    }

    if (d.mediaKind === 'imageUser') {
      this.addedImages.update((prev) => ({
        ...prev,
        [d.pn]: ((prev[d.pn] || []) as ImageElement[]).map((a) => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      this.selEl.update((prev) =>
        prev && prev.id === d.elId && prev.type === 'image' ? { ...prev, x: nx, y: ny } : prev,
      );
      return;
    }

    const hasSrc = !!this.imageEdits()[d.pn]?.[d.elId]?.src;
    if (d.mediaKind === 'imagePdf' && (hasSrc || d.extractDone)) {
      this.patchImageEdit(d.pn, d.elId, { x: nx, y: ny });
      return;
    }

    if (d.extracting) return;
    if (!d.pdfImageEl) return;
    d.extracting = true;
    const { pn, elId, fullUrl, pdfImageEl } = d;
    void regionFromPdfDataUrl(fullUrl!, pdfImageEl).then((dataUrl) => {
      d.extracting = false;
      if (!dataUrl) return;
      d.extractDone = true;
      const ref = this.imageDrag;
      const nx2 = ref?.elId === elId ? (ref.latestNX ?? nx) : nx;
      const ny2 = ref?.elId === elId ? (ref.latestNY ?? ny) : ny;
      this.patchImageEdit(pn, elId, { src: dataUrl, removed: false, x: nx2, y: ny2 });
    });
  }

  onImagePointerUp(e: PointerEvent): void {
    const d = this.imageDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.moved) this.suppressImageClick = true;
    this.imageDrag = null;
    this.draggingImageId.set(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  handleRemoveImage(el: ImageElement): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    if (el._userAdded) {
      this.addedImages.update((prev) => ({
        ...prev,
        [pn]: ((prev[pn] || []) as ImageElement[]).filter((a) => a.id !== el.id),
      }));
      this.selEl.set(null);
    } else {
      this.patchImageEdit(pn, el.id, { removed: true, src: undefined });
    }
  }

  async openCropForImage(el: ImageElement): Promise<void> {
    const pg = this.pages()[this.selPage()];
    if (!pg || el.type !== 'image') return;
    const pn = pg.pageNum;
    let sourceUrl = el._userAdded
      ? ((this.addedImages()[pn] || []) as ImageElement[]).find((a) => a.id === el.id)?.src
      : this.imageEdits()[pn]?.[el.id]?.src;
    if (!sourceUrl) sourceUrl = (await regionFromPdfDataUrl(pg.fullUrl, el)) || undefined;
    if (!sourceUrl) return;
    this.cropModal.set({
      sourceUrl,
      resolve: (croppedUrl: string) => {
        this.captureBeforeChange();
        if (el._userAdded) {
          this.addedImages.update((prev) => ({
            ...prev,
            [pn]: ((prev[pn] || []) as ImageElement[]).map((a) => (a.id === el.id ? { ...a, src: croppedUrl } : a)),
          }));
        } else {
          this.imageEdits.update((prev) => ({
            ...prev,
            [pn]: {
              ...(prev[pn] || {}),
              [el.id]: { ...(prev[pn]?.[el.id] || {}), removed: false, src: croppedUrl },
            },
          }));
        }
        this.cropModal.set(null);
      },
    });
  }

  newDocument(): void { 
    this.revokeVideoBlobs(this.addedVideos());
    this.pages.set([]);
    this.templates.set([]);
    this.tokens.set({ colors: [], fonts: [], sizes: [] });
    this.imageEdits.set({});
    this.layoutEdits.set({});
    this.textEdits.set({});
    this.addedImages.set({});
    this.addedVideos.set({});
    this.addedTables.set({});
    this.addedRichTexts.set({});
    this.proposalSections.set(this.normalizeSections([]));
    this.activeSectionId.set('sec_mandatory_cover');
    this.historyStack = [];
    this.redoStack = [];
    this.historyUi.update((u) => u + 1);
  }

  overlayEls(): SelElement[] {
    const pg = this.pg();
    if (!pg) return [];
    return [
      ...pg.textElements.filter((t) => !this.textEdits()[pg.pageNum]?.[t.id]?.maskOriginal),
      ...pg.shapes,
      ...pg.images,
      ...(this.addedImages()[pg.pageNum] || []),
      ...(this.addedVideos()[pg.pageNum] || []),
      ...(this.addedTables()[pg.pageNum] || []),
      ...(this.addedRichTexts()[pg.pageNum] || []),
    ];
  }

  /** View mode: same bounds as `overlayEls()` but omit videos — a transparent hit-layer would block the play control. */
  overlayElsForViewTooltips(): SelElement[] {
    return this.overlayEls().filter((e) => e.type !== 'video');
  }

  userTextForInspector(): UserTextElement | null {
    const pg = this.pg();
    const sel = this.selEl();
    if (!pg || sel?.type !== 'userText') return null;
    return (
      ((this.addedRichTexts()[pg.pageNum] || []) as UserTextElement[]).find((b) => b.id === sel.id) ||
      (sel as UserTextElement)
    );
  }

  pdfTextStyle(rt: UserTextElement): TextStyle | null {
    const m = rt.id.match(/^pdftext_(\d+)_(.+)$/);
    if (!m) return null;
    const pn = Number.parseInt(m[1]!, 10);
    const textId = m[2]!;
    const pg = this.pages().find((p) => p.pageNum === pn);
    const src = pg?.textElements.find((t) => t.id === textId);
    return src?.style ?? null;
  }

  addRichTextBlock(): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    const id = `rtxt_${pn}_${Date.now()}`;
    const w = Math.min(380, Math.max(200, pg.width * 0.5));
    const h = Math.min(280, Math.max(100, pg.height * 0.24));
    const { x, y } = this.computeCenteredPlacementRect(pg, w, h);
    const block: UserTextElement = {
      id,
      type: 'userText',
      x,
      y,
      w,
      h,
      html: '<p></p>',
      _userAdded: true,
    };
    this.addedRichTexts.update((prev) => ({
      ...prev,
      [pn]: [...(prev[pn] || []), block],
    }));
    this.editorMode.set('edit');
    this.activeAddTool.set('userText');
    this.placedTextUndoGate = id;
    this.selEl.set(block);
  }

  stageTransform(): string {
    return `scale(${this.zoom()})`;
  }

  onStageClick(): void {
    this.selEl.set(null);
    this.tableUndoGate = { tableId: null, armed: false };
    this.placedTextUndoGate = null;
  }

  /** Clears text edits, layout overrides, image edits, and user-placed content on all pages. */
  clearAllCanvasEdits(): void {
    if (
      !confirm(
        'Clear all edits on every page? This removes layout moves, image replacements, and placed images, videos, tables, and text blocks. Undo is available.',
      )
    ) {
      return;
    }
    this.revokeVideoBlobs(this.addedVideos());
    this.captureBeforeChange();
    this.imageEdits.set({});
    this.layoutEdits.set({});
    this.textEdits.set({});
    this.addedImages.set({});
    this.addedVideos.set({});
    this.addedTables.set({});
    this.addedRichTexts.set({});
    this.selEl.set(null);
    this.historyUi.update((u) => u + 1);
  }

  sendForApproval(): void {
    this.ensureMandatorySections();
    const secs = this.proposalSections();
    const first = secs[0];
    const last = secs[secs.length - 1];
    if (!first || first.catalogId !== 'cover') {
      alert('Cannot send for approval: Cover Page is mandatory and must be first.');
      return;
    }
    if (!last || last.catalogId !== 'acceptance') {
      alert('Cannot send for approval: Acceptance Page is mandatory and must be last.');
      return;
    }
    this.approvalStatus.set('in_review');
  }

  overlayElementTitle(el: SelElement): string {
    switch (el.type) {
      case 'text':
        return 'Text';
      case 'image':
        return 'Image — Drag to move, handles to resize';
      case 'video':
        return 'Video — Drag to move';
      case 'shape':
        return 'Shape — Vector graphics';
      default:
        return 'Element';
    }
  }

  onPlacedTableMousedown(e: MouseEvent, readOnly: boolean): void {
    if (readOnly) return;
    e.stopPropagation();
  }

  onPlacedTableClick(e: MouseEvent, t: TableElement, readOnly: boolean): void {
    if (readOnly) return;
    e.stopPropagation();
    this.selEl.set(t);
  }

  onPlacedRichTextMousedown(e: MouseEvent, readOnly: boolean): void {
    if (readOnly) return;
    e.stopPropagation();
  }

  onPlacedRichTextClick(e: MouseEvent, rt: UserTextElement, readOnly: boolean): void {
    if (readOnly) return;
    e.stopPropagation();
    this.selEl.set(rt);
  }

  applyCropResult(url: string): void {
    const m = this.cropModal();
    if (m) m.resolve(url);
  }

  private elementPageBounds(el: SelElement, pn: number): { x: number; y: number; w: number; h: number } {
    const pg = this.pages().find((p) => p.pageNum === pn) ?? null;
    if (!pg) return { x: el.x, y: el.y, w: el.w, h: el.h };
    if (el.type === 'image') {
      return getImageOverlayBounds(el as ImageElement, pn, this.imageEdits());
    }
    if (el.type === 'text') {
      const raw = pg.textElements.find((t) => t.id === el.id);
      if (!raw) return { x: el.x, y: el.y, w: el.w, h: el.h };
      const l = this.layoutEdits()[pn]?.[el.id];
      return {
        x: l?.x ?? raw.x,
        y: l?.y ?? raw.y,
        w: l?.w ?? raw.w,
        h: l?.h ?? raw.h,
      };
    }
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }

  /** Bounding boxes of every other placed element on the page (for non-overlap while dragging). */
  private placementObstacleRects(pn: number, excludeId: string): { x: number; y: number; w: number; h: number }[] {
    const pg = this.pages().find((p) => p.pageNum === pn);
    if (!pg) return [];
    const list: SelElement[] = [
      ...pg.textElements,
      ...pg.shapes,
      ...pg.images,
      ...(this.addedImages()[pn] || []),
      ...(this.addedVideos()[pn] || []),
      ...(this.addedTables()[pn] || []),
      ...(this.addedRichTexts()[pn] || []),
    ];
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of list) {
      if (el.id === excludeId) continue;
      if (el.type === 'image' && this.imageEdits()[pn]?.[el.id]?.removed) continue;
      out.push(this.elementPageBounds(el, pn));
    }
    return out;
  }

  overlayBounds(el: SelElement): { x: number; y: number; w: number; h: number } {
    const pg = this.pg();
    if (el.type === 'image' && pg) {
      return getImageOverlayBounds(el as ImageElement, pg.pageNum, this.imageEdits());
    }
    if (el.type === 'text' && pg) {
      const le = this.layoutEdits()[pg.pageNum]?.[el.id];
      if (!le) return { x: el.x, y: el.y, w: el.w, h: el.h };
      return {
        x: le.x ?? el.x,
        y: le.y ?? el.y,
        w: le.w ?? el.w,
        h: le.h ?? el.h,
      };
    }
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }

  max2(n: number): number {
    return Math.max(n, 2);
  }

  private addedVideoEl(videoId: string): HTMLVideoElement | null {
    const stage = this.pageStageRef()?.nativeElement;
    if (!stage) return null;
    return stage.querySelector(`video[data-added-video-id="${CSS.escape(videoId)}"]`);
  }

  syncAddedVideoPlaying(videoId: string, ev: Event): void {
    const el = ev.target as HTMLVideoElement;
    this.addedVideoPlaying.update((m) => ({ ...m, [videoId]: !el.paused }));
  }

  toggleAddedVideoPlayback(e: Event, videoId: string): void {
    e.stopPropagation();
    e.preventDefault();
    const node = this.addedVideoEl(videoId);
    if (!node) return;
    if (node.paused) void node.play().catch(() => { });
    else node.pause();
  }

  onOverlayClick(e: MouseEvent, el: SelElement, placementDrag: boolean, active: boolean): void {
    e.stopPropagation();
    if (placementDrag && this.suppressImageClick) {
      this.suppressImageClick = false;
      return;
    }
    this.selEl.set(active ? null : el);
  }

  onOverlayDblClick(e: MouseEvent, el: SelElement): void {
    if (this.editorMode() !== 'edit') return;
    if (el.type !== 'text') return;
    e.stopPropagation();
    e.preventDefault();
    this.beginEditPdfText(el as TextElement);
  }

  private beginEditPdfText(el: TextElement): void {
    const pg = this.pg();
    if (!pg) return;
    const pn = pg.pageNum;
    const ob = this.overlayBounds(el);

    const existing = this.textEdits()[pn]?.[el.id];
    if (!existing) this.captureBeforeChange();
    const html = existing?.html ?? `<p>${this.escapeHtml(el.content || '')}</p>`;

    this.textEdits.update((prev) => ({
      ...prev,
      [pn]: {
        ...(prev[pn] || {}),
        [el.id]: { html, maskOriginal: true },
      },
    }));

    // Represent edited PDF text as a userText block so we can reuse the rich-text editor UI.
    const rtId = `pdftext_${pn}_${el.id}`;
    // When double-clicking PDF text to edit, expand the editor to full available page width.
    // (Use remaining width from the original x so we don't overflow the page.)
    const fullWidth = Math.max(80, pg.width - ob.x);
    const block: UserTextElement = {
      id: rtId,
      type: 'userText',
      x: ob.x,
      y: ob.y,
      w: fullWidth,
      h: ob.h,
      html,
      _userAdded: true,
    };

    this.addedRichTexts.update((prev) => {
      const list = (prev[pn] || []) as UserTextElement[];
      const found = list.find((x) => x.id === rtId);
      return {
        ...prev,
        [pn]: found ? list.map((x) => (x.id === rtId ? { ...x, ...block } : x)) : [...list, block],
      };
    });

    this.selEl.set(block);
    this.editorMode.set('edit');
    this.activeAddTool.set('userText');
    this.placedTextUndoGate = rtId;
  }

  onOverlayEnter(e: MouseEvent, active: boolean, bgTint: string): void {
    if (active) return;
    (e.currentTarget as HTMLElement).style.background = bgTint;
  }

  onOverlayLeave(e: MouseEvent, active: boolean): void {
    if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
  }

  onPlacementPointerDown(e: PointerEvent, el: SelElement, placementDrag: boolean): void {
    if (placementDrag) this.onImagePointerDown(e, el);
  }

  onPointerMoveMaybe(e: PointerEvent, placementDrag: boolean): void {
    if (placementDrag) this.onImagePointerMove(e);
  }

  onPointerUpMaybe(e: PointerEvent, placementDrag: boolean): void {
    if (placementDrag) this.onImagePointerUp(e);
  }

  onAltDragUserText(e: PointerEvent, rt: UserTextElement): void {
    e.stopPropagation();
    this.onImagePointerDown(e, rt);
  }

  onAddImageFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.addImageFromFile(f);
    (e.target as HTMLInputElement).value = '';
  }

  onAddVideoFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.addVideoFromFile(f);
    (e.target as HTMLInputElement).value = '';
  }

  readonly Math = Math;

  clickAddImage(): void {
    this.addImageInputRef()?.nativeElement?.click();
  }

  clickAddVideo(): void {
    this.addVideoInputRef()?.nativeElement?.click();
  }

  clampNum(e: Event, min: number, max: number): number {
    const v = Number.parseInt((e.target as HTMLInputElement).value, 10);
    return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  }

  clampInt(e: Event, min: number, max: number): number {
    return this.clampNum(e, min, max);
  }

  onVideoReplace(e: Event, el: VideoElement): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) this.handleReplaceVideo(el, f);
    (e.target as HTMLInputElement).value = '';
  }

  onVideoReplaceInspector(e: Event, sel: SelElement): void {
    if (sel.type !== 'video') return;
    this.onVideoReplace(e, sel);
  }

  onImageReplace(e: Event, el: ImageElement): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.handleReplaceImage(el, f);
    (e.target as HTMLInputElement).value = '';
  }

  onImageReplaceInspector(e: Event, sel: SelElement): void {
    if (sel.type !== 'image') return;
    void this.onImageReplace(e, sel);
  }

  patchUserTextWidth(sel: SelElement, e: Event): void {
    if (sel.type !== 'userText') return;
    this.editorMode.set('edit');
    this.patchUserTextBlock(sel, { w: this.clampNum(e, 80, 2000) });
  }

  patchUserTextHeight(sel: SelElement, e: Event): void {
    if (sel.type !== 'userText') return;
    this.editorMode.set('edit');
    this.patchUserTextBlock(sel, { h: this.clampNum(e, 60, 2000) });
  }

  removeUserTextInspector(sel: SelElement): void {
    if (sel.type !== 'userText') return;
    this.handleRemoveUserText(sel);
  }

  patchTableRowsFromInspector(sel: SelElement, e: Event): void {
    if (sel.type !== 'table') return;
    this.editorMode.set('edit');
    this.patchTable(sel, { rows: this.clampInt(e, 1, 30) });
  }

  patchTableColsFromInspector(sel: SelElement, e: Event): void {
    if (sel.type !== 'table') return;
    this.editorMode.set('edit');
    this.patchTable(sel, { cols: this.clampInt(e, 1, 30) });
  }

  removeTableInspector(sel: SelElement): void {
    if (sel.type !== 'table') return;
    this.handleRemoveTable(sel);
  }

  removeVideoInspector(sel: SelElement): void {
    if (sel.type !== 'video') return;
    this.handleRemoveVideo(sel);
  }

  openCropInspector(sel: SelElement): void {
    if (sel.type !== 'image') return;
    void this.openCropForImage(sel);
  }

  removeImageInspector(sel: SelElement): void {
    if (sel.type !== 'image') return;
    this.handleRemoveImage(sel);
  }

  /** Delete image or video from the on-canvas selection control (stops event propagation). */
  onOverlayMediaDelete(e: Event, sel: SelElement): void {
    e.stopPropagation();
    e.preventDefault();
    if (sel.type === 'video') this.removeVideoInspector(sel);
    else if (sel.type === 'image') this.removeImageInspector(sel);
  }

  openAddSectionModal(): void {
    this.ensureMandatorySections();
    this.sectionModalDraft.set(structuredClone(this.proposalSections()));
    this.addSectionModalOpen.set(true);
  }

  closeAddSectionModal(): void {
    this.addSectionModalOpen.set(false);
  }

  saveAddSectionModal(): void {
    this.captureBeforeChange();
    this.proposalSections.set(this.normalizeSections(structuredClone(this.sectionModalDraft())));
    this.ensureMandatorySections();
    this.addSectionModalOpen.set(false);
  }

  addCatalogSectionToModal(catalogId: string, title: string): void {
    if (this.mandatoryCatalogIds.has(catalogId)) return;
    const exists = this.sectionModalDraft().some((s) => s.catalogId === catalogId);
    if (exists) return;
    const row: ProposalSection = {
      id: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      catalogId,
      title,
      mandatory: false,
      margins: this.defaultMargins(),
    };
    this.sectionModalDraft.update((list) => [...list, row]);
  }

  addDetectedHeadingToModal(h: { title: string; pageNum: number }): void {
    const title = h.title.trim();
    if (!title) return;
    const exists = this.sectionModalDraft().some((s) => s.title.trim().toLowerCase() === title.toLowerCase());
    if (exists) return;
    const row: ProposalSection = {
      id: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      catalogId: `detected:${h.pageNum}`,
      title,
      mandatory: false,
      margins: this.defaultMargins(),
      startPageNum: h.pageNum,
    };
    this.sectionModalDraft.update((list) => [...list, row]);
  }

  toggleSectionsMenu(): void {
    this.sectionsMenuOpen.update((v) => !v);
  }

  closeSectionsMenu(): void {
    this.sectionsMenuOpen.set(false);
  }

  addDetectedHeadingAsSection(h: { title: string; pageNum: number }): void {
    const title = h.title.trim();
    if (!title) return;
    const exists = this.proposalSections().some((s) => s.title.trim().toLowerCase() === title.toLowerCase());
    if (exists) return;
    this.captureBeforeChange();
    const row: ProposalSection = {
      id: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      catalogId: `detected:${h.pageNum}`,
      title,
      mandatory: false,
      margins: this.defaultMargins(),
      startPageNum: h.pageNum,
    };
    this.proposalSections.update((list) => this.normalizeSections([...list, row]));
    this.ensureMandatorySections();
    this.sectionsMenuOpen.set(false);
  }

  removeSection(sec: ProposalSection): void {
    if (this.isMandatorySection(sec)) return;
    this.captureBeforeChange();
    this.proposalSections.update((list) => this.normalizeSections(list.filter((s) => s.id !== sec.id)));
    this.ensureMandatorySections();
    if (this.activeSectionId() === sec.id) this.activeSectionId.set('sec_mandatory_cover');
    this.deletePagesForSection(sec)
  }

  detectedHeadingsNotSelected(): { key: string; title: string; pageNum: number }[] {
    const secs = this.proposalSections();
    const titles = new Set(secs.map((s) => s.title.trim().toLowerCase()).filter(Boolean));
    return this.detectedHeadings().filter((h) => !titles.has(h.title.trim().toLowerCase()));
  }

  removeSectionFromModal(id: string): void {
    const row = this.sectionModalDraft().find((s) => s.id === id);
    if (row?.mandatory || this.mandatoryCatalogIds.has(row?.catalogId || '')) return;
    this.sectionModalDraft.update((list) => list.filter((s) => s.id !== id));
  }

  onSectionDragStart(e: DragEvent, id: string): void {
    const row = this.sectionModalDraft().find((s) => s.id === id);
    if (row?.mandatory || this.mandatoryCatalogIds.has(row?.catalogId || '')) {
      e.preventDefault();
      return;
    }
    this.sectionDragKey = id;
    e.dataTransfer?.setData('text/plain', id);
    e.dataTransfer!.effectAllowed = 'move';
  }

  onSectionDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  onSectionDrop(e: DragEvent, targetId: string): void {
    e.preventDefault();
    const from = this.sectionDragKey || e.dataTransfer?.getData('text/plain');
    this.sectionDragKey = null;
    if (!from || from === targetId) return;
    this.sectionModalDraft.update((list) => {
      const i = list.findIndex((x) => x.id === from);
      const j = list.findIndex((x) => x.id === targetId);
      if (i < 0 || j < 0) return list;
      const fromRow = list[i];
      const toRow = list[j];
      if (fromRow?.mandatory || toRow?.mandatory) return list;
      const n = [...list];
      const [item] = n.splice(i, 1);
      n.splice(j, 0, item);
      return n;
    });
  }

  openLivePreview(): void {
    const pdfId = this.openedPdfId;
    if (!pdfId || !this.pages().length) {
      alert('Save your proposal to the server first, then use Live preview (opens the saved document in a new tab).');
      return;
    }
    const url = this.router.serializeUrl(
      this.router.createUrlTree(['/edit', pdfId], { queryParams: { preview: '1' } }),
    );
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  closePreview(): void {
    const id = this.openedPdfId;
    if (id) void this.router.navigate(['/edit', id], { queryParams: {} });
    else void this.router.navigate(['/edit'], { queryParams: {} });
  }

  toggleExportMenu(): void {
    this.exportMenuOpen.update((v) => !v);
  }

  closeExportMenu(): void {
    this.exportMenuOpen.set(false);
  }

  private sanitizeFilename(name: string): string {
    const s = name.replace(/[/\\?%*:|"<>]/g, '_').trim();
    return s.slice(0, 120) || 'proposal';
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    queueMicrotask(() => URL.revokeObjectURL(a.href));
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private buildWordExportHtml(): string {
    const title = this.pdfTitle() || 'Proposal';
    const sections = this.proposalSections();
    const secList = sections.map((x) => `<li>${this.escapeHtml(x.title)}</li>`).join('');
    const n = this.pages().length;
    return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title></head><body><h1>${this.escapeHtml(title)}</h1><p>Pages: ${n}</p><h2>Sections</h2><ul>${secList || '<li>(none)</li>'}</ul><p><em>Exported from Proposal Editor. Visual canvas edits are not baked into this file.</em></p></body></html>`;
  }

  private hexToRgb01(hex: string): { r: number; g: number; b: number } {
    const m = (hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return { r: 1, g: 1, b: 1 };
    const n = Number.parseInt(m[1]!, 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return { r, g, b };
  }

  private htmlToPlainText(html: string): string {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private wrapTextToWidth(
    text: string,
    width: number,
    measure: (s: string) => number,
  ): string[] {
    const out: string[] = [];
    const paras = (text || '').split(/\n+/g);
    for (const p of paras) {
      const words = p.trim().split(/\s+/g).filter(Boolean);
      if (!words.length) {
        out.push('');
        continue;
      }
      let line = words[0]!;
      for (let i = 1; i < words.length; i++) {
        const w = words[i]!;
        const cand = `${line} ${w}`;
        if (measure(cand) <= width) line = cand;
        else {
          out.push(line);
          line = w;
        }
      }
      out.push(line);
    }
    return out;
  }

  async exportEditedPdfFile(): Promise<void> {
    this.closeExportMenu();
    try {
      const srcBuf = this.openedPdfId
        ? await firstValueFrom(this.pdfsApi.getPdfFile(this.openedPdfId))
        : this.loadedPdfBuf;
      if (!srcBuf) {
        alert('No PDF loaded.');
        return;
      }

      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.load(srcBuf);

      // Must match the SCALE used in `extractPage()`.
      const SCALE = 1.5;

      const pages = this.pages();
      const textEdits = this.textEdits();
      const layoutEdits = this.layoutEdits();
      const imageEdits = this.imageEdits();
      const addedImages = this.addedImages();

      for (const pg of pages) {
        const page = pdfDoc.getPage(pg.pageNum - 1);
        const { width: pw, height: ph } = page.getSize();
        const bg = this.hexToRgb01(pg.bgColor || '#ffffff');

        // 1) Mask + redraw edited text
        const tMap = textEdits[pg.pageNum] || {};
        for (const [textId, ed] of Object.entries(tMap)) {
          if (!ed?.maskOriginal) continue;
          const src = pg.textElements.find((t) => t.id === textId);
          if (!src) continue;
          const le = layoutEdits[pg.pageNum]?.[textId] || {};
          const x = (le.x ?? src.x) / SCALE;
          const yTop = (le.y ?? src.y) / SCALE;
          const w = (le.w ?? src.w) / SCALE;
          const h = (le.h ?? src.h) / SCALE;
          const y = ph - yTop - h;

          page.drawRectangle({ x, y, width: w, height: h, color: rgb(bg.r, bg.g, bg.b) });

          const plain = this.htmlToPlainText(ed.html || '');
          const size = Math.max(6, (src.style.fontSizePx || 12) / SCALE);
          const isBold = src.style.fontWeight === 'bold';
          const isItalic = src.style.fontStyle === 'italic';
          const fontName = isBold
            ? isItalic
              ? StandardFonts.HelveticaBoldOblique
              : StandardFonts.HelveticaBold
            : isItalic
              ? StandardFonts.HelveticaOblique
              : StandardFonts.Helvetica;
          const font = await pdfDoc.embedFont(fontName);

          const col = this.hexToRgb01(src.style.color || '#0f172a');
          const pad = Math.max(1, size * 0.12);
          const lineHeight = size * 1.25;
          const measure = (s: string) => font.widthOfTextAtSize(s, size);
          const lines = this.wrapTextToWidth(plain, Math.max(2, w - pad * 2), measure);
          let ty = y + h - pad - size;
          for (const line of lines) {
            if (ty < y + pad) break;
            page.drawText(line, { x: x + pad, y: ty, size, font, color: rgb(col.r, col.g, col.b) });
            ty -= lineHeight;
          }
        }

        // 2) Mask removed PDF images and draw replacements / user-added images (best-effort)
        const iMap = imageEdits[pg.pageNum] || {};
        for (const imgEl of pg.images) {
          const ed = iMap[imgEl.id];
          if (!ed?.removed && !ed?.src) continue;
          const x = imgEl.x / SCALE;
          const yTop = imgEl.y / SCALE;
          const w = imgEl.w / SCALE;
          const h = imgEl.h / SCALE;
          const y = ph - yTop - h;
          page.drawRectangle({ x, y, width: w, height: h, color: rgb(bg.r, bg.g, bg.b) });
        }

        const drawImageDataUrl = async (dataUrl: string, x: number, y: number, w: number, h: number) => {
          const m = dataUrl.match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
          if (!m) return;
          const mime = m[1]!;
          const b64 = m[2]!;
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const img = mime === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
          page.drawImage(img, { x, y, width: w, height: h });
        };

        for (const imgEl of pg.images) {
          const ed = iMap[imgEl.id];
          if (!ed?.src || ed?.removed) continue;
          const ox = (ed.x ?? imgEl.x) / SCALE;
          const oyTop = (ed.y ?? imgEl.y) / SCALE;
          const ow = (ed.w ?? imgEl.w) / SCALE;
          const oh = (ed.h ?? imgEl.h) / SCALE;
          const oy = ph - oyTop - oh;
          await drawImageDataUrl(ed.src, ox, oy, ow, oh);
        }

        for (const imgEl of addedImages[pg.pageNum] || []) {
          if (!imgEl.src) continue;
          const x = imgEl.x / SCALE;
          const yTop = imgEl.y / SCALE;
          const w = imgEl.w / SCALE;
          const h = imgEl.h / SCALE;
          const y = ph - yTop - h;
          await drawImageDataUrl(imgEl.src, x, y, w, h);
        }
      }

      const bytes = await pdfDoc.save();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], { type: 'application/pdf' });
      const base = this.sanitizeFilename(this.pdfTitle() || 'proposal');
      this.downloadBlob(blob, `${base}-edited.pdf`);
    } catch (e: unknown) {
      alert('Export failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async exportPdfFile(): Promise<void> {
    this.closeExportMenu();
    const id = this.openedPdfId;
    if (!id) {
      alert('Save your proposal to the server first to download the original PDF file.');
      return;
    }
    try {
      const buf = await firstValueFrom(this.pdfsApi.getPdfFile(id));
      const blob = new Blob([buf], { type: 'application/pdf' });
      this.downloadBlob(blob, `${this.sanitizeFilename(this.pdfTitle())}.pdf`);
    } catch (e: unknown) {
      alert('Download failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  exportWordFile(): void {
    this.closeExportMenu();
    const blob = new Blob([`\ufeff${this.buildWordExportHtml()}`], {
      type: 'application/msword',
    });
    this.downloadBlob(blob, `${this.sanitizeFilename(this.pdfTitle())}.doc`);
  }

  async exportPptxFile(): Promise<void> {
    this.closeExportMenu();
    try {
      const pptxgen = (await import('pptxgenjs')).default;
      const pptx = new pptxgen();
      pptx.title = this.pdfTitle() || 'Proposal';
      this.ensureMandatorySections();
      const secs = this.proposalSections();
      const list = secs.length ? secs : this.normalizeSections([]);
      for (const sec of list) {
        const slide = pptx.addSlide();
        slide.addText(this.sectionLabel(sec), {
          x: 0.6,
          y: 0.8,
          w: 9,
          fontSize: 28,
          bold: true,
          color: '0f172a',
        });
        const m = sec.margins ?? this.defaultMargins();
        slide.addText(`Margins — T:${m.top} R:${m.right} B:${m.bottom} L:${m.left}`, {
          x: 0.6,
          y: 1.6,
          w: 9,
          fontSize: 12,
          color: '64748b',
        });
      }
      await pptx.writeFile({ fileName: `${this.sanitizeFilename(this.pdfTitle())}.pptx` });
    } catch (e: unknown) {
      alert('PPTX export failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-export-menu]')) return;
    this.exportMenuOpen.set(false);
    if (t.closest('[data-sections-menu]')) return;
    this.sectionsMenuOpen.set(false);
  }

  goBackToList(): void {
    void this.router.navigate(['/']);
  }

  goToEditSummary(e: { pgData: PageData | undefined; elId: string }): void {
    const idx = e.pgData ? this.pages().indexOf(e.pgData) : -1;
    if (idx < 0) return;
    const origEl = e.pgData?.textElements.find((te) => te.id === e.elId);
    this.selPage.set(idx);
    if (origEl) this.selEl.set(origEl);
    this.editorMode.set('edit');
  }

  clickById(id: string): void {
    document.getElementById(id)?.click();
  }

  protected readonly isProbablyHtml = isProbablyHtml;
}
