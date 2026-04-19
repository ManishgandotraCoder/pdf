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
  const next: string[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: string[] = [];
    for (let j = 0; j < cols; j++) {
      const v = prev?.[i]?.[j];
      row.push(typeof v === 'string' ? v : '');
    }
    next.push(row);
  }
  return next;
}

export function execRich(cmd: string, val?: string): boolean {
  try {
    (document as Document & { execCommand(commandId: string, showUI?: boolean, value?: string | boolean): boolean }).execCommand(
      'styleWithCSS',
      false,
      true,
    );
    return document.execCommand(cmd, false, val);
  } catch {
    return false;
  }
}

export function applyFontSizePx(px: string | number): void {
  const n = Number(px);
  if (!Number.isFinite(n) || n < 1) return;
  (document as Document & { execCommand(commandId: string, showUI?: boolean, value?: string | boolean): boolean }).execCommand(
    'styleWithCSS',
    false,
    true,
  );
  document.execCommand('fontSize', false, '7');
  const fonts = document.getElementsByTagName('font');
  for (let i = fonts.length - 1; i >= 0; i--) {
    const el = fonts[i];
    if (el.size === '7') {
      el.removeAttribute('size');
      el.style.fontSize = `${n}px`;
    }
  }
}

export function promptLinkUrl(): void {
  const u = window.prompt('Link URL', 'https://');
  if (u) execRich('createLink', absolutizeUrl(u.trim()));
}
