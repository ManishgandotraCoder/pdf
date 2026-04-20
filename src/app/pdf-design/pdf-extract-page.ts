import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';

import type { ImageElement, PageData, ShapeElement, TextElement } from './pdf-design.models';
import {
  argsToHex,
  concatTransform,
  isWhiteish,
  layoutSignature,
  sampleTextColor,
  toHex,
} from './pdf-design.helpers';

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
        images.push({
          id: `i_${pageNum}_${images.length}`,
          type: 'image',
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: iw,
          h: ih,
        });
      }
    }
  }

  const textElements: TextElement[] = [];
  textContent.items.forEach((item, idx) => {
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
    textElements.push({
      id: `t_${pageNum}_${idx}`,
      type: 'text',
      x: elX,
      y: elY,
      w: elW,
      h: elH,
      content: ti.str,
      style: {
        fontFamily,
        fontSize: Math.round((fontSize / SCALE) * 10) / 10,
        fontSizePx: fontSize,
        fontWeight: /bold/i.test(raw) || /bold/i.test(ti.fontName) ? 'bold' : 'normal',
        fontStyle: /italic|oblique/i.test(raw) || /italic|oblique/i.test(ti.fontName) ? 'italic' : 'normal',
        color,
      },
    });
  });

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
