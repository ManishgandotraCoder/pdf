import * as pdfjsLib from 'pdfjs-dist';
import {
  Component,
  computed,
  effect,
  signal,
  viewChild,
  ElementRef,
  DestroyRef,
  inject,
} from '@angular/core';
import { ImageCropModalComponent } from './image-crop-modal.component';
import { RichTextToolbarComponent } from './rich-text-toolbar.component';
import { InlineEditorComponent } from './inline-editor.component';
import { LoadingScreenComponent } from './loading-screen.component';
import { PlacedTableGridComponent } from './placed-table-grid.component';
import { PlacedUserTextBodyComponent } from './placed-user-text-body.component';
import { RichTextEditorBlockComponent } from './rich-text-editor-block.component';
import { SafeHtmlPipe } from './safe-html.pipe';
import { UploadZoneComponent } from './upload-zone.component';
import {
  AddedImagesMap,
  AddedRichTextsMap,
  AddedTablesMap,
  AddedVideosMap,
  CropModalState,
  DesignTokens,
  EditsMap,
  HistorySnapshot,
  ImageDragState,
  ImageEditsMap,
  ImageElement,
  LayoutEditsMap,
  PageData,
  ResizeHandleId,
  SelElement,
  TableElement,
  TemplateCluster,
  TextElement,
  UserTextElement,
  VideoElement,
} from './pdf-design.models';
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
  remapPageKeyedState,
  remapPageKeyedStateInsert,
} from './pdf-design.helpers';
import { extractPage } from './pdf-extract-page';
import { ensureTableCells, isProbablyHtml } from './rich-text.utils';

@Component({
  selector: 'app-pdf-design-extractor',
  standalone: true,
  imports: [
    SafeHtmlPipe,
    UploadZoneComponent,
    LoadingScreenComponent,
    ImageCropModalComponent,
    InlineEditorComponent,
    PlacedTableGridComponent,
    PlacedUserTextBodyComponent,
    RichTextEditorBlockComponent,
    RichTextToolbarComponent,
  ],
  templateUrl: './pdf-design-extractor.component.html',
})
export class PdfDesignExtractorComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly pages = signal<PageData[]>([]);
  readonly loading = signal(false);
  readonly progress = signal(0);
  readonly doneCount = signal(0);
  readonly totalPgs = signal(0);
  readonly selPage = signal(0);
  readonly selEl = signal<SelElement | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly edits = signal<EditsMap>({});
  readonly imageEdits = signal<ImageEditsMap>({});
  readonly layoutEdits = signal<LayoutEditsMap>({});
  readonly addedImages = signal<AddedImagesMap>({});
  readonly addedVideos = signal<AddedVideosMap>({});
  readonly addedTables = signal<AddedTablesMap>({});
  readonly addedRichTexts = signal<AddedRichTextsMap>({});
  readonly cropModal = signal<CropModalState | null>(null);
  readonly templates = signal<TemplateCluster[]>([]);
  readonly tokens = signal<DesignTokens>({ colors: [], fonts: [], sizes: [] });
  readonly editorMode = signal<'edit' | 'view'>('edit');
  readonly activeAddTool = signal<'image' | 'video' | 'table' | 'userText' | null>(null);
  readonly zoom = signal(0.9);
  readonly viewerImageDropActive = signal(false);
  readonly draggingImageId = signal<string | null>(null);
  readonly historyUi = signal(0);
  /** Tracks whether each placed video is currently playing (for play/stop toggle UI). */
  readonly addedVideoPlaying = signal<Record<string, boolean>>({});

  readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly pageStageRef = viewChild<ElementRef<HTMLDivElement>>('pageStage');
  readonly addImageInputRef = viewChild<ElementRef<HTMLInputElement>>('addImageInput');
  readonly addVideoInputRef = viewChild<ElementRef<HTMLInputElement>>('addVideoInput');

  private historyStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private isRestoring = false;
  private lastTextHistoryAt = 0;
  private imageDrag: ImageDragState | null = null;
  private suppressImageClick = false;
  private tableUndoGate: { tableId: string | null; armed: boolean } = { tableId: null, armed: false };
  private placedTextUndoGate: string | null = null;

  readonly pg = computed(() => {
    const p = this.pages();
    const i = this.selPage();
    return p[i] ?? null;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      (Object.values(this.addedVideos()) as VideoElement[][]).forEach((arr: VideoElement[]) =>
        arr.forEach((v: VideoElement) => {
          if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
        }),
      );
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
        const bg = pg.bgColor || '#ffffff';
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
    const w = typeof globalThis !== 'undefined' ? globalThis : window;
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
    w.addEventListener('keydown', onKey);
    this.destroyRef.onDestroy(() => w.removeEventListener('keydown', onKey));
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
      edits: structuredClone(this.edits()),
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
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
      edits: structuredClone(this.edits()),
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
    };
    this.redoStack.push(current);
    const prev = this.historyStack.pop()!;
    this.edits.set(prev.edits);
    this.imageEdits.set(prev.imageEdits);
    this.layoutEdits.set(prev.layoutEdits ?? {});
    this.addedImages.set(prev.addedImages);
    this.addedVideos.set(prev.addedVideos);
    this.addedTables.set(prev.addedTables || {});
    this.addedRichTexts.set(prev.addedRichTexts || {});
    this.selEl.set(null);
    this.editingId.set(null);
    this.historyUi.update((u) => u + 1);
    queueMicrotask(() => {
      this.isRestoring = false;
    });
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    this.isRestoring = true;
    const current: HistorySnapshot = {
      edits: structuredClone(this.edits()),
      imageEdits: structuredClone(this.imageEdits()),
      layoutEdits: structuredClone(this.layoutEdits()),
      addedImages: structuredClone(this.addedImages()),
      addedVideos: structuredClone(this.addedVideos()),
      addedTables: structuredClone(this.addedTables()),
      addedRichTexts: structuredClone(this.addedRichTexts()),
    };
    this.historyStack.push(current);
    const next = this.redoStack.pop()!;
    this.edits.set(next.edits);
    this.imageEdits.set(next.imageEdits);
    this.layoutEdits.set(next.layoutEdits ?? {});
    this.addedImages.set(next.addedImages);
    this.addedVideos.set(next.addedVideos);
    this.addedTables.set(next.addedTables || {});
    this.addedRichTexts.set(next.addedRichTexts || {});
    this.selEl.set(null);
    this.editingId.set(null);
    this.historyUi.update((u) => u + 1);
    queueMicrotask(() => {
      this.isRestoring = false;
    });
  }

  setEdit(pageNum: number, elId: string, val: string, historyMode: 'debounced' | 'commit' | 'skip' = 'debounced'): void {
    if (historyMode !== 'skip') {
      const now = Date.now();
      const shouldSnap = historyMode === 'commit' || now - this.lastTextHistoryAt > 650;
      if (shouldSnap) {
        this.captureBeforeChange();
        this.lastTextHistoryAt = now;
      }
    }
    this.edits.update((prev) => ({
      ...prev,
      [pageNum]: { ...(prev[pageNum] || {}), [elId]: val },
    }));
  }

  clearEdit(pageNum: number, elId: string): void {
    this.captureBeforeChange();
    this.edits.update((prev) => {
      const pgEdits = { ...(prev[pageNum] || {}) };
      delete pgEdits[elId];
      return { ...prev, [pageNum]: pgEdits };
    });
  }

  pageHasEdits(pn: number): boolean {
    return Object.keys(this.edits()[pn] || {}).length > 0;
  }

  totalEdits(): number {
    return Object.values(this.edits()).reduce((s, pg) => s + Object.keys(pg).length, 0);
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
    this.edits.update((prev) => remapPageKeyedState(prev, delPn));
    this.imageEdits.update((prev) => remapPageKeyedState(prev, delPn));
    this.layoutEdits.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedImages.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedVideos.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedTables.update((prev) => remapPageKeyedState(prev, delPn));
    this.addedRichTexts.update((prev) => remapPageKeyedState(prev, delPn));
    this.selEl.set(null);
    this.editingId.set(null);
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
    this.edits.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.imageEdits.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.layoutEdits.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedImages.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedVideos.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedTables.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.addedRichTexts.update((prev) => remapPageKeyedStateInsert(prev, insert1Based));
    this.selEl.set(null);
    this.editingId.set(null);
    this.selPage.set(insertIdx);
  }

  async handleUpload(file: File): Promise<void> {
    (Object.values(this.addedVideos()) as VideoElement[][]).forEach((arr: VideoElement[]) =>
      arr.forEach((v: VideoElement) => {
        if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
      }),
    );
    this.loading.set(true);
    this.progress.set(0);
    this.doneCount.set(0);
    this.pages.set([]);
    this.selPage.set(0);
    this.selEl.set(null);
    this.edits.set({});
    this.editingId.set(null);
    this.imageEdits.set({});
    this.layoutEdits.set({});
    this.addedImages.set({});
    this.addedVideos.set({});
    this.addedTables.set({});
    this.addedRichTexts.set({});
    this.historyStack = [];
    this.redoStack = [];
    this.historyUi.update((u) => u + 1);
    try {
      const buf = await file.arrayBuffer();
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
    } catch (err: unknown) {
      console.error(err);
      alert('Error: ' + (err instanceof Error ? err.message : String(err)));
    }
    this.loading.set(false);
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
    let x: number;
    let y: number;
    if (
      typeof centerX === 'number' &&
      typeof centerY === 'number' &&
      !Number.isNaN(centerX) &&
      !Number.isNaN(centerY)
    ) {
      x = Math.min(Math.max(centerX - w / 2, 0), Math.max(0, pg.width - w));
      y = Math.min(Math.max(centerY - h / 2, 0), Math.max(0, pg.height - h));
    } else {
      x = Math.max(8, (pg.width - w) / 2);
      y = Math.max(8, (pg.height - h) / 2);
    }
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
    let x: number;
    let y: number;
    if (
      typeof centerX === 'number' &&
      typeof centerY === 'number' &&
      !Number.isNaN(centerX) &&
      !Number.isNaN(centerY)
    ) {
      x = Math.min(Math.max(centerX - w / 2, 0), Math.max(0, pg.width - w));
      y = Math.min(Math.max(centerY - h / 2, 0), Math.max(0, pg.height - h));
    } else {
      x = Math.max(8, (pg.width - w) / 2);
      y = Math.max(8, (pg.height - h) / 2);
    }
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
    const x = Math.max(8, (pg.width - w) / 2);
    const y = Math.max(8, (pg.height - h) / 2);
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

  updateUserTextHtml(id: string, innerHtml: string): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    const pn = pg.pageNum;
    this.addedRichTexts.update((prev) => ({
      ...prev,
      [pn]: ((prev[pn] || []) as UserTextElement[]).map((b) => (b.id === id ? { ...b, html: innerHtml } : b)),
    }));
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
    if (el.type === 'text' && this.editingId() === el.id) return false;
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
      const nr = rectFromResizeHandle(d.handle, d.startRect, px, py, d.pw, d.ph);
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
    nx = Math.min(Math.max(0, nx), Math.max(0, d.pw - d.elW));
    ny = Math.min(Math.max(0, ny), Math.max(0, d.ph - d.elH));
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
    (Object.values(this.addedVideos()) as VideoElement[][]).forEach((arr: VideoElement[]) =>
      arr.forEach((v: VideoElement) => {
        if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src);
      }),
    );
    this.pages.set([]);
    this.templates.set([]);
    this.tokens.set({ colors: [], fonts: [], sizes: [] });
    this.edits.set({});
    this.imageEdits.set({});
    this.layoutEdits.set({});
    this.addedImages.set({});
    this.addedVideos.set({});
    this.addedTables.set({});
    this.addedRichTexts.set({});
    this.historyStack = [];
    this.redoStack = [];
    this.historyUi.update((u) => u + 1);
  }

  overlayEls(): SelElement[] {
    const pg = this.pg();
    if (!pg) return [];
    return [
      ...pg.textElements,
      ...pg.shapes,
      ...pg.images,
      ...(this.addedImages()[pg.pageNum] || []),
      ...(this.addedVideos()[pg.pageNum] || []),
    ];
  }

  editedTexts(): TextElement[] {
    const pg = this.pg();
    if (!pg) return [];
    const pageEdits = this.edits()[pg.pageNum] || {};
    return pg.textElements.filter((e) => pageEdits[e.id] !== undefined);
  }

  pageEdits(): Record<string, string> {
    const pg = this.pg();
    if (!pg) return {};
    return this.edits()[pg.pageNum] || {};
  }

  /** Edited HTML/string when present in `pageEdits()`, otherwise the extracted PDF text. */
  textEditOrOriginal(elId: string, original: string): string {
    const m = this.pageEdits();
    return Object.prototype.hasOwnProperty.call(m, elId) ? m[elId] : original;
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

  addRichTextBlock(): void {
    const pg = this.pages()[this.selPage()];
    if (!pg) return;
    this.captureBeforeChange();
    const pn = pg.pageNum;
    const id = `rtxt_${pn}_${Date.now()}`;
    const w = Math.min(380, Math.max(200, pg.width * 0.5));
    const h = Math.min(280, Math.max(100, pg.height * 0.24));
    const x = Math.max(8, (pg.width - w) / 2);
    const y = Math.max(8, (pg.height - h) / 2);
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
    if (!this.editingId()) {
      this.selEl.set(null);
      this.tableUndoGate = { tableId: null, armed: false };
      this.placedTextUndoGate = null;
    }
  }

  clearAllEdits(): void {
    this.captureBeforeChange();
    this.edits.set({});
  }

  editingTextEl(): TextElement | null {
    const id = this.editingId();
    const pg = this.pg();
    if (!id || !pg) return null;
    const raw = pg.textElements.find((e) => e.id === id);
    if (!raw) return null;
    const le = this.layoutEdits()[pg.pageNum]?.[id];
    if (!le) return raw;
    return { ...raw, ...le };
  }

  applyCropResult(url: string): void {
    const m = this.cropModal();
    if (m) m.resolve(url);
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
    if (this.editingId()) return;
    if (placementDrag && this.suppressImageClick) {
      this.suppressImageClick = false;
      return;
    }
    this.selEl.set(active ? null : el);
  }

  onOverlayDblClick(e: MouseEvent, el: SelElement): void {
    e.stopPropagation();
    if (this.editorMode() !== 'edit') return;
    if (el.type === 'text') {
      this.selEl.set(el);
      this.editingId.set(el.id);
    }
  }

  onOverlayEnter(e: MouseEvent, active: boolean, bgTint: string): void {
    if (active || this.editingId()) return;
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

  onInspectorTextHtml(html: string, pageNum: number, id: string): void {
    if (this.editorMode() !== 'edit') this.editorMode.set('edit');
    this.setEdit(pageNum, id, html);
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

  editSummaryEntries(): {
    key: string;
    pn: string;
    was: string;
    now: string;
    pgData: PageData | undefined;
    elId: string;
  }[] {
    const out: {
      key: string;
      pn: string;
      was: string;
      now: string;
      pgData: PageData | undefined;
      elId: string;
    }[] = [];
    for (const [pn, pEdits] of Object.entries(this.edits())) {
      for (const [elId, newText] of Object.entries(pEdits)) {
        const pgData = this.pages().find((p) => p.pageNum === +pn);
        const origEl = pgData?.textElements.find((e) => e.id === elId);
        out.push({
          key: `${pn}-${elId}`,
          pn,
          was: origEl?.content?.slice(0, 30) || '…',
          now: newText.slice(0, 30),
          pgData,
          elId,
        });
      }
    }
    return out;
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
