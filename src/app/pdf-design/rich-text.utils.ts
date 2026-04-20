import { absolutizeUrl } from './pdf-design.helpers';

export const DEFAULT_RICH_FONT_LIST = [
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
  'Palatino Linotype',
  'Garamond',
  'Comic Sans MS',
];

export const FONT_SIZE_PX_LIST = [10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48];

/** Default HTML for new / empty table cells: one line, 12px text. */
export const DEFAULT_TABLE_CELL_HTML =
  '<p style="font-size:12px;line-height:1.5;margin:0"><br></p>';

let savedRichTextRange: Range | null = null;
let savedRichTextEditable: HTMLElement | null = null;

/** Call from toolbar mousedown (capture) so selection survives focus moving to the toolbar. */
export function saveRichTextSelection(): void {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const r = sel.getRangeAt(0);
  const root =
    r.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (r.commonAncestorContainer as Element)
      : r.commonAncestorContainer.parentElement;
  const editable = root?.closest('[contenteditable="true"]') as HTMLElement | null;
  if (!editable) return;
  savedRichTextRange = r.cloneRange();
  savedRichTextEditable = editable;
}

export function restoreRichTextSelection(): void {
  if (!savedRichTextRange && !savedRichTextEditable) return;
  // If the saved editable is no longer in the document, clear stale state.
  if (savedRichTextEditable && !savedRichTextEditable.isConnected) {
    savedRichTextRange = null;
    savedRichTextEditable = null;
    return;
  }
  try {
    // Re-focus the editable element first so execCommand has a valid target
    if (savedRichTextEditable) {
      savedRichTextEditable.focus();
    }
    const sel = window.getSelection();
    if (savedRichTextRange) {
      sel?.removeAllRanges();
      sel?.addRange(savedRichTextRange);
    }
  } catch {
    savedRichTextRange = null;
  }
}

/**
 * After restoring the selection, if it is still collapsed (cursor only, no text
 * highlighted) expand it to cover all content in the saved editable element.
 * This ensures toolbar commands like Bold / font-name always have visible effect.
 */
export function expandToAllIfCollapsed(): void {
  const editable = savedRichTextEditable;
  if (!editable || !editable.isConnected) return;
  const sel = window.getSelection();
  if (!sel) return;
  const isCollapsed = sel.rangeCount === 0 || sel.getRangeAt(0).collapsed;
  if (isCollapsed) {
    try {
      const range = document.createRange();
      range.selectNodeContents(editable);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRichTextRange = range.cloneRange();
    } catch {
      /* range may be invalid if DOM was just replaced — swallow */
    }
  }
}

export function mergeFontOptions(extracted: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...(extracted || []), ...DEFAULT_RICH_FONT_LIST]) {
    const s = String(f || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 40);
}

export function isProbablyHtml(s: string | null | undefined): boolean {
  return typeof s === 'string' && /<[a-z][\s\S]*>/i.test(s);
}

/** Build / trim a rows×cols matrix of HTML cell strings. */
export function ensureTableCells(rows: number, cols: number, prev: string[][] | undefined): string[][] {
  if (prev && prev.length === rows && prev[0]?.length === cols) {
    let needsDefault = false;
    outer: for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = prev[i][j];
        if (typeof v !== 'string' || v.trim() === '') {
          needsDefault = true;
          break outer;
        }
      }
    }
    if (!needsDefault) return prev;
    return prev.map((row) =>
      row.map((cell) =>
        typeof cell === 'string' && cell.trim() !== '' ? cell : DEFAULT_TABLE_CELL_HTML,
      ),
    );
  }
  const next: string[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: string[] = [];
    for (let j = 0; j < cols; j++) {
      const raw = prev?.[i]?.[j];
      row.push(
        typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_TABLE_CELL_HTML,
      );
    }
    next.push(row);
  }
  return next;
}

export function execRich(cmd: string, val?: string): boolean {
  try {
    const doc = document as Document & {
      execCommand(commandId: string, showUI?: boolean, value?: string | boolean): boolean;
    };
    doc.execCommand('styleWithCSS', false, true);
    return doc.execCommand(cmd, false, val);
  } catch {
    return false;
  }
}

/**
 * Maps legacy font size (1–7) to px using `<font>` tags. Browsers only emit those tags when
 * `styleWithCSS` is false; with styleWithCSS true, `fontSize` often does nothing useful.
 */
export function applyFontSizePx(px: string | number): void {
  // Caller is responsible for restoreRichTextSelection() + expandToAllIfCollapsed()
  // before calling this function.
  const n = Number(px);
  if (!Number.isFinite(n) || n < 1) return;
  const doc = document as Document & {
    execCommand(commandId: string, showUI?: boolean, value?: string | boolean): boolean;
  };
  doc.execCommand('styleWithCSS', false, false);
  doc.execCommand('fontSize', false, '7');
  const scope = savedRichTextEditable ?? document.body;
  const fonts = scope.getElementsByTagName('font');
  for (let i = fonts.length - 1; i >= 0; i--) {
    const el = fonts[i];
    if (el.size === '7') {
      el.removeAttribute('size');
      el.style.fontSize = `${n}px`;
    }
  }
  doc.execCommand('styleWithCSS', false, true);
}

export function promptLinkUrl(): void {
  const u = window.prompt('Link URL', 'https://');
  if (u) {
    restoreRichTextSelection();
    execRich('createLink', absolutizeUrl(u.trim()));
  }
}
