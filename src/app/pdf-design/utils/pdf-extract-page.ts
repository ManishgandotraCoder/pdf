import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';

import type { ImageElement, PageData, ShapeElement, TextElement } from '../models/pdf-design.models';
import {
  argsToHex,
  concatTransform,
  isWhiteish,
  layoutSignature,
  sampleTextColor,
  toHex,
} from './pdf-design.helpers';

export interface ExtractedTextRun {
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  fontFamily: string;
  fontSize: number;
  fontSizePx: number;
  fontWeight: 'bold' | 'normal';
  fontStyle: 'italic' | 'normal';
  color: string;
}

export async function extractPage(page: PDFPageProxy, pageNum: number): Promise<PageData> {
  const SCALE = 1.5;
  const vp = page.getViewport({ scale: SCALE });
  const W = vp.width;
  const H = vp.height;

  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const fullUrl = cvs.toDataURL('image/jpeg', 0.9);

  const tvp = page.getViewport({ scale: 0.16 });
  const tc = document.createElement('canvas');
  tc.width = tvp.width;
  tc.height = tvp.height;
  await page.render({ canvasContext: tc.getContext('2d')!, viewport: tvp }).promise;
  const thumbUrl = tc.toDataURL('image/jpeg', 0.7);

  const px = ctx.getImageData(4, 4, 1, 1).data;
  const bgColor = toHex(px[0], px[1], px[2]);

  const textContent = await page.getTextContent({ includeMarkedContent: false });
  const styles = textContent.styles || {};

  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const OPS = pdfjsLib.OPS;

  const gsStack: { fill: string; stroke: string; ctm: number[] }[] = [
    { fill: '#333333', stroke: '#000000', ctm: [1, 0, 0, 1, 0, 0] },
  ];
  const gs = () => gsStack[gsStack.length - 1];
  const docColors = new Set<string>();
  const shapes: ShapeElement[] = [];
  const images: ImageElement[] = [];
  // Stable image ids prevent saved edits from applying to the wrong PDF image.
  // Prefer the XObject name (when available) plus rounded geometry; fall back to geometry.
  const imageIdCounts = new Map<string, number>();
  let pendingRect: { x: number; y: number; w: number; h: number } | null = null;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as number[] | undefined;
    if (fn === OPS.save) {
      gsStack.push({ ...gs(), ctm: [...gs().ctm] });
    } else if (fn === OPS.restore) {
      if (gsStack.length > 1) gsStack.pop();
    } else if (fn === OPS.transform && args) {
      gs().ctm = concatTransform(gs().ctm, args);
    } else if (fn === OPS.setFillRGBColor && args) {
      const h = argsToHex(args);
      if (h) {
        gs().fill = h;
        if (!isWhiteish(h)) docColors.add(h);
      }
    } else if (fn === OPS.setFillGray && args) {
      const h = argsToHex(args, true);
      if (h) gs().fill = h;
    } else if ((fn === OPS.setFillColor || fn === OPS.setFillColorN) && args && args.length >= 3) {
      const h = argsToHex(args);
      if (h && !isWhiteish(h)) {
        gs().fill = h;
        docColors.add(h);
      }
    } else if (fn === OPS.setStrokeRGBColor && args) {
      const h = argsToHex(args);
      if (h) {
        gs().stroke = h;
        if (!isWhiteish(h)) docColors.add(h);
      }
    } else if (fn === OPS.setStrokeGray && args) {
      const h = argsToHex(args, true);
      if (h) gs().stroke = h;
    } else if ((fn === OPS.setStrokeColor || fn === OPS.setStrokeColorN) && args && args.length >= 3) {
      const h = argsToHex(args);
      if (h && !isWhiteish(h)) {
        gs().stroke = h;
        docColors.add(h);
      }
    } else if (fn === OPS.rectangle && args) {
      const [rx, ry, rw, rh] = args;
      if (Math.abs(rw) > 1 && Math.abs(rh) > 1) {
        const [x1, y1] = pdfjsLib.Util.applyTransform([rx, ry], vp.transform);
        const [x2, y2] = pdfjsLib.Util.applyTransform([rx + rw, ry + rh], vp.transform);
        pendingRect = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
        };
      }
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
      if (pendingRect && pendingRect.w > 2 && pendingRect.h > 2) {
        const fill = gs().fill;
        if (!isWhiteish(fill)) {
          shapes.push({
            id: `s_${pageNum}_${shapes.length}`,
            type: 'shape',
            ...pendingRect,
            fill,
            stroke: null,
          });
          docColors.add(fill);
        }
      }
      pendingRect = null;
    } else if (fn === OPS.stroke || fn === OPS.closeStroke) {
      if (pendingRect && pendingRect.w > 0 && pendingRect.h > 0) {
        const stroke = gs().stroke;
        if (!isWhiteish(stroke))
          shapes.push({
            id: `s_${pageNum}_${shapes.length}`,
            type: 'shape',
            ...pendingRect,
            fill: null,
            stroke,
          });
      }
      pendingRect = null;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const rawArgs = (argsArray[i] ?? []) as unknown[];
      const xObjectName = typeof rawArgs[0] === 'string' ? String(rawArgs[0]) : '';
      const m = gs().ctm;
      const pts = [
        [m[4], m[5]],
        [m[4] + m[0], m[5] + m[1]],
        [m[4] + m[2], m[5] + m[3]],
        [m[4] + m[0] + m[2], m[5] + m[1] + m[3]],
      ];
      const xs = pts.map((p) => pdfjsLib.Util.applyTransform(p, vp.transform)[0]);
      const ys = pts.map((p) => pdfjsLib.Util.applyTransform(p, vp.transform)[1]);
      const iw = Math.max(...xs) - Math.min(...xs);
      const ih = Math.max(...ys) - Math.min(...ys);
      if (iw > 20 && ih > 20) {
        const ix = Math.min(...xs);
        const iy = Math.min(...ys);
        const geoKey = `${Math.round(ix)}_${Math.round(iy)}_${Math.round(iw)}_${Math.round(ih)}`;
        const baseKey = xObjectName ? `${xObjectName}_${geoKey}` : geoKey;
        const count = (imageIdCounts.get(baseKey) ?? 0) + 1;
        imageIdCounts.set(baseKey, count);
        images.push({
          id: `i_${pageNum}_${baseKey}_${count}`,
          type: 'image',
          x: ix,
          y: iy,
          w: iw,
          h: ih,
        });
      }
    }
  }

  const rawRuns: ExtractedTextRun[] = [];
  textContent.items.forEach((item) => {
    const ti = item as { str?: string; transform: number[]; width: number; fontName: string };
    if (!ti.str?.trim()) return;
    const [sx, sy] = pdfjsLib.Util.applyTransform([ti.transform[4], ti.transform[5]], vp.transform);
    const fontSize = Math.sqrt(ti.transform[0] ** 2 + ti.transform[1] ** 2) * SCALE;
    const info = (styles as Record<string, { fontFamily?: string }>)[ti.fontName] || {};
    const raw = info.fontFamily || 'sans-serif';
    const fontFamily = raw.replace(/,.*$/, '').trim();
    const elX = sx;
    const elY = sy - fontSize;
    const elW = Math.max(ti.width * SCALE, 4);
    const elH = Math.max(fontSize * 1.3, 8);
    const color = sampleTextColor(ctx, { x: elX, y: elY, w: elW, h: elH }, bgColor, W, H);
    rawRuns.push({
      x: elX,
      y: elY,
      w: elW,
      h: elH,
      content: ti.str,
      fontFamily,
      fontSize: Math.round((fontSize / SCALE) * 10) / 10,
      fontSizePx: fontSize,
      fontWeight: /bold/i.test(raw) || /bold/i.test(ti.fontName) ? 'bold' : 'normal',
      fontStyle: /italic|oblique/i.test(raw) || /italic|oblique/i.test(ti.fontName) ? 'italic' : 'normal',
      color,
    });
  });
  const textElements = mergeAdjacentTextRuns(rawRuns, pageNum);

  const allEls = [...textElements, ...shapes, ...images].filter(
    (e) => e.x >= 0 && e.y >= 0 && e.x < W && e.y < H,
  );

  return {
    pageNum,
    width: W,
    height: H,
    fullUrl,
    thumbUrl,
    bgColor,
    textElements,
    shapes,
    images,
    allElements: allEls,
    docColors: [...docColors].filter((c) => !c.includes('NaN')),
    signature: layoutSignature(allEls, W, H),
    templateId: null,
  };
}

const RUN_MERGE_GAP_FACTOR = 1.35;
const RUN_MERGE_GAP_MIN_PX = 18;

export function mergeAdjacentTextRuns(rawRuns: readonly ExtractedTextRun[], pageNum = 0): TextElement[] {
  const sorted = [...rawRuns].sort((a, b) => a.y - b.y || a.x - b.x);
  const textElements: TextElement[] = [];

  for (const run of sorted) {
    const prev = textElements[textElements.length - 1];
    const yTol = Math.max(run.fontSizePx * 0.35, 2.5);
    const gap = prev ? run.x - (prev.x + prev.w) : Number.POSITIVE_INFINITY;
    const mergeGap = Math.max(run.fontSizePx * RUN_MERGE_GAP_FACTOR, RUN_MERGE_GAP_MIN_PX);
    const canMerge =
      prev &&
      Math.abs(prev.y - run.y) < yTol &&
      gap <= mergeGap &&
      prev.style.fontFamily === run.fontFamily &&
      prev.style.fontSizePx === run.fontSizePx &&
      prev.style.fontWeight === run.fontWeight &&
      prev.style.fontStyle === run.fontStyle &&
      prev.style.color === run.color;

    if (canMerge) {
      const sep = gap > run.fontSizePx * 0.2 ? ' ' : '';
      prev.content += sep + run.content;
      const right = Math.max(prev.x + prev.w, run.x + run.w);
      prev.w = right - prev.x;
      prev.h = Math.max(prev.h, run.h);
      continue;
    }

    textElements.push({
      id: `t_${pageNum}_${textElements.length}`,
      type: 'text',
      x: run.x,
      y: run.y,
      w: run.w,
      h: run.h,
      content: run.content,
      style: {
        fontFamily: run.fontFamily,
        fontSize: run.fontSize,
        fontSizePx: run.fontSizePx,
        fontWeight: run.fontWeight,
        fontStyle: run.fontStyle,
        color: run.color,
      },
    });
  }

  return textElements;
}
