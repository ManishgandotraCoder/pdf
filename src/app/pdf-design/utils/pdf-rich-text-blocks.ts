import type { TextElement, TextStyle } from '../models/pdf-design.models';

export interface PdfRichTextBlockDraft {
  x: number;
  y: number;
  w: number;
  h: number;
  html: string;
  sourceTextIds: string[];
  sourceStyle: TextStyle;
}

type TextLine = {
  x: number;
  y: number;
  w: number;
  h: number;
  plainText: string;
  html: string;
  sourceTextIds: string[];
  style: TextStyle;
  indent: number;
  right: number;
  list:
    | {
        ordered: boolean;
        itemText: string;
      }
    | null;
};

type TextRegion = {
  lines: TextLine[];
  x: number;
  y: number;
  right: number;
  bottom: number;
};

type ParagraphSegmentState = {
  kind: 'paragraph';
  html: string;
  style: TextStyle;
  lastLine: TextLine;
};

type ListSegmentState = {
  kind: 'list';
  ordered: boolean;
  items: { html: string; style: TextStyle }[];
  style: TextStyle;
  lastLine: TextLine;
};

type SegmentState = ParagraphSegmentState | ListSegmentState;

const UNORDERED_LIST_RE = /^([•●◦▪■▸►◆◇○●\-–—*])\s+(.+)$/u;
const ORDERED_LIST_RE = /^((?:\d+|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])\s+(.+)$/;

export function createPdfRichTextBlocks(textElements: readonly TextElement[]): PdfRichTextBlockDraft[] {
  const lines = createTextLines(textElements);
  const regions = createTextRegions(lines);
  return regions.map((region) => createDraftFromRegion(region));
}

function createDraftFromRegion(region: TextRegion): PdfRichTextBlockDraft {
  const segments: string[] = [];
  let current: SegmentState | null = null;

  const flush = () => {
    if (!current) return;
    if (current.kind === 'paragraph') {
      segments.push(`<p style="${blockStyleCss(current.style)}">${current.html || '<br>'}</p>`);
    } else {
      const tag = current.ordered ? 'ol' : 'ul';
      const items = current.items
        .map((item) => `<li style="${blockStyleCss(item.style)}">${item.html || '<br>'}</li>`)
        .join('');
      segments.push(`<${tag} style="margin:0;padding-left:1.4em">${items || '<li><br></li>'}</${tag}>`);
    }
    current = null;
  };

  for (const line of region.lines) {
    if (line.list) {
      const canContinueList =
        current?.kind === 'list' &&
        current.ordered === line.list.ordered &&
        shouldStayInSameList(current.lastLine, line);

      if (!canContinueList) {
        flush();
        current = {
          kind: 'list',
          ordered: line.list.ordered,
          items: [{ html: escapeHtml(line.list.itemText), style: line.style }],
          style: line.style,
          lastLine: line,
        };
      } else {
        const listSegment = current as ListSegmentState;
        listSegment.items.push({ html: escapeHtml(line.list.itemText), style: line.style });
        listSegment.lastLine = line;
      }
      continue;
    }

    const canContinueParagraph =
      current?.kind === 'paragraph' && shouldStayInSameParagraph(current.lastLine, line);

    if (!canContinueParagraph) {
      flush();
      current = {
        kind: 'paragraph',
        html: line.html,
        style: line.style,
        lastLine: line,
      };
    } else {
      const paragraphSegment = current as ParagraphSegmentState;
      const separator =
        line.plainText.startsWith('.') || paragraphSegment.html.endsWith('-') ? '' : ' ';
      paragraphSegment.html += `${separator}${line.html}`;
      paragraphSegment.lastLine = line;
    }
  }

  flush();

  const sourceTextIds = [...new Set(region.lines.flatMap((line) => line.sourceTextIds))];
  return {
    x: region.x,
    y: region.y,
    w: Math.max(12, region.right - region.x),
    h: Math.max(12, region.bottom - region.y),
    html: segments.join('') || '<p><br></p>',
    sourceTextIds,
    sourceStyle: dominantStyle(region.lines.map((line) => line.style)),
  };
}

function createTextRegions(lines: readonly TextLine[]): TextRegion[] {
  const regions: TextRegion[] = [];

  for (const line of lines) {
    let bestRegion: TextRegion | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const region of regions) {
      const score = regionJoinScore(region, line);
      if (score > bestScore) {
        bestScore = score;
        bestRegion = region;
      }
    }

    if (!bestRegion) {
      regions.push(startRegion(line));
      continue;
    }

    appendLineToRegion(bestRegion, line);
  }

  for (const region of regions) {
    region.lines.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
}

function startRegion(line: TextLine): TextRegion {
  return {
    lines: [line],
    x: line.x,
    y: line.y,
    right: line.right,
    bottom: line.y + line.h,
  };
}

function appendLineToRegion(region: TextRegion, line: TextLine): void {
  region.lines.push(line);
  region.x = Math.min(region.x, line.x);
  region.y = Math.min(region.y, line.y);
  region.right = Math.max(region.right, line.right);
  region.bottom = Math.max(region.bottom, line.y + line.h);
}

function shouldJoinRegion(region: TextRegion, line: TextLine): boolean {
  const prev = region.lines[region.lines.length - 1]!;
  const avgHeight = average(region.lines.map((item) => item.h));
  const gap = line.y - (prev.y + prev.h);
  if (gap > Math.max(avgHeight, line.h) * 1.9) return false;

  const edgeTol = Math.max(avgHeight, line.h) * 4.5;
  const overlapWithPrev = horizontalOverlap(prev.x, prev.right, line.x, line.right);
  const overlapWithRegion = horizontalOverlap(region.x, region.right, line.x, line.right);
  const leftAligned = Math.abs(line.x - prev.x) <= edgeTol || Math.abs(line.x - region.x) <= edgeTol;
  const rightAligned = Math.abs(line.right - prev.right) <= edgeTol || Math.abs(line.right - region.right) <= edgeTol;
  const enclosedByRegion = line.x >= region.x - edgeTol && line.right <= region.right + edgeTol;

  if (overlapWithPrev > 0 || overlapWithRegion > 0) return true;
  if (leftAligned || rightAligned) return true;
  if (enclosedByRegion && gap <= Math.max(avgHeight, line.h) * 1.15) return true;
  return false;
}

function regionJoinScore(region: TextRegion, line: TextLine): number {
  if (!shouldJoinRegion(region, line)) return Number.NEGATIVE_INFINITY;
  const prev = region.lines[region.lines.length - 1]!;
  const verticalGap = Math.max(0, line.y - (prev.y + prev.h));
  const overlapWithPrev = Math.max(0, horizontalOverlap(prev.x, prev.right, line.x, line.right));
  const overlapWithRegion = Math.max(0, horizontalOverlap(region.x, region.right, line.x, line.right));
  const edgeDelta = Math.min(
    Math.abs(line.x - prev.x),
    Math.abs(line.x - region.x),
    Math.abs(line.right - prev.right),
    Math.abs(line.right - region.right),
  );
  const widthExpansion = Math.max(0, region.x - line.x) + Math.max(0, line.right - region.right);

  return overlapWithPrev * 3 + overlapWithRegion * 2 - verticalGap * 24 - edgeDelta - widthExpansion * 2;
}

function shouldStayInSameParagraph(prev: TextLine, next: TextLine): boolean {
  const gap = next.y - (prev.y + prev.h);
  const size = Math.max(prev.h, next.h);
  if (gap > size * 0.75) return false;
  if (Math.abs(next.indent - prev.indent) > size * 1.8) return false;
  if (!stylesParagraphCompatible(prev.style, next.style)) return false;
  return true;
}

function shouldStayInSameList(prev: TextLine, next: TextLine): boolean {
  const gap = next.y - (prev.y + prev.h);
  const size = Math.max(prev.h, next.h);
  if (gap > size * 1.1) return false;
  if (Math.abs(next.indent - prev.indent) > size * 2.2) return false;
  return true;
}

function createTextLines(textElements: readonly TextElement[]): TextLine[] {
  const sorted = [...textElements]
    .filter((el) => (el.content || '').trim().length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const grouped: TextElement[][] = [];
  for (const el of sorted) {
    const prev = grouped[grouped.length - 1];
    if (!prev?.length) {
      grouped.push([el]);
      continue;
    }
    const prevTop = prev[0]!.y;
    const prevH = Math.max(...prev.map((item) => item.h));
    const yTol = Math.max(prevH * 0.34, el.h * 0.34, 3);
    if (Math.abs(prevTop - el.y) <= yTol) prev.push(el);
    else grouped.push([el]);
  }

  return grouped
    .flatMap((row) => splitRowIntoTextLineGroups(row).map((group) => createTextLine(group)))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function splitRowIntoTextLineGroups(row: readonly TextElement[]): TextElement[][] {
  const parts = [...row].sort((a, b) => a.x - b.x);
  if (parts.length <= 1) return [parts];

  const rowHeight = Math.max(...parts.map((part) => part.h));
  const avgFontPx = average(parts.map((part) => part.style.fontSizePx || part.style.fontSize || 12));
  const breakGap = Math.max(24, rowHeight * 2.2, avgFontPx * 2.6);

  const out: TextElement[][] = [];
  let current: TextElement[] = [parts[0]!];
  let currentRight = parts[0]!.x + parts[0]!.w;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const gap = part.x - currentRight;
    if (gap > breakGap) {
      out.push(current);
      current = [part];
    } else {
      current.push(part);
    }
    currentRight = Math.max(currentRight, part.x + part.w);
  }

  out.push(current);
  return out;
}

function createTextLine(row: TextElement[]): TextLine {
  const parts = [...row].sort((a, b) => a.x - b.x);
  const baseStyle = parts[0]!.style;
  let plainText = '';
  let html = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const prev = parts[i - 1];
    const gap = prev == null ? Number.POSITIVE_INFINITY : part.x - (prev.x + prev.w);
    const fontPx = part.style.fontSizePx || part.style.fontSize || 12;
    const needsSpace = i > 0 && gap > fontPx * 0.18;
    if (needsSpace) {
      plainText += ' ';
      html += ' ';
    }
    plainText += part.content;
    html += inlineHtmlForFragment(part, baseStyle);
  }

  const trimmed = plainText.trim();
  const unordered = trimmed.match(UNORDERED_LIST_RE);
  const ordered = trimmed.match(ORDERED_LIST_RE);
  const list = unordered
    ? { ordered: false, itemText: unordered[2]!.trim() }
    : ordered
      ? { ordered: true, itemText: ordered[2]!.trim() }
      : null;

  const x = Math.min(...parts.map((part) => part.x));
  const y = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.w));
  const bottom = Math.max(...parts.map((part) => part.y + part.h));

  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
    plainText: trimmed,
    html: html.trim() || escapeHtml(trimmed),
    sourceTextIds: parts.map((part) => part.id),
    style: baseStyle,
    indent: x,
    right,
    list,
  };
}

function inlineHtmlForFragment(part: TextElement, baseStyle: TextStyle): string {
  const text = escapeHtml(part.content || '');
  if (!text) return '';
  if (stylesExactlyMatch(part.style, baseStyle)) return text;
  return `<span style="${inlineStyleCss(part.style)}">${text}</span>`;
}

function dominantStyle(styles: readonly TextStyle[]): TextStyle {
  const counts = new Map<string, { style: TextStyle; count: number }>();
  for (const style of styles) {
    const key = JSON.stringify([
      style.fontFamily,
      style.fontSizePx ?? style.fontSize,
      style.fontWeight,
      style.fontStyle,
      style.color,
    ]);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { style, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.style ?? styles[0]!;
}

function blockStyleCss(style: TextStyle): string {
  return `margin:0;${inlineStyleCss(style)}`;
}

function inlineStyleCss(style: TextStyle): string {
  const css: string[] = [];
  if (style.fontFamily) css.push(`font-family:${quoteCssString(style.fontFamily)}`);
  if (style.fontSizePx != null) css.push(`font-size:${style.fontSizePx}px`);
  else if (style.fontSize) css.push(`font-size:${style.fontSize}px`);
  if (style.fontWeight) css.push(`font-weight:${style.fontWeight}`);
  if (style.fontStyle) css.push(`font-style:${style.fontStyle}`);
  if (style.color) css.push(`color:${style.color}`);
  return css.join(';');
}

function quoteCssString(value: string): string {
  return `'${String(value || '').replace(/'/g, "\\'")}'`;
}

function stylesExactlyMatch(a: TextStyle, b: TextStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    (a.fontSizePx ?? a.fontSize) === (b.fontSizePx ?? b.fontSize) &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color
  );
}

function stylesParagraphCompatible(a: TextStyle, b: TextStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    Math.abs((a.fontSizePx ?? a.fontSize ?? 12) - (b.fontSizePx ?? b.fontSize ?? 12)) <= 3 &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle
  );
}

function horizontalOverlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.min(a2, b2) - Math.max(a1, b1);
}

function average(nums: readonly number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
