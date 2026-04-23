import type {
  AddedImagesMap,
  AddedVideosMap,
  ImageEditsMap,
  ImageElement,
  PageData,
  ResizeHandleId,
  TemplateCluster,
  VideoElement,
} from '../models/pdf-design.models';

export function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function argsToHex(args: number[] | undefined, isGray = false): string | null {
  if (!args || !args.length) return null;
  if (isGray) {
    const g = args[0] * 255;
    return toHex(g, g, g);
  }
  if (args.length >= 3) return toHex(args[0] * 255, args[1] * 255, args[2] * 255);
  return null;
}

export function isWhiteish(hex: string | null | undefined): boolean {
  if (!hex) return true;
  const h = hex.replace('#', '').toLowerCase();
  return h === 'ffffff' || h === 'fff' || h.includes('NaN');
}

/**
 * Parse a CSS hex colour string like "#rrggbb" into {r,g,b} or null.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * Sample the rendered canvas to find the dominant foreground colour in the area
 * covered by a text element.  Returns a hex string, or '' if undetermined.
 *
 * Strategy: scan a grid of pixels across the text bounding box; for each pixel
 * compute its luminance-distance from the page background; pick the pixel that
 * deviates most from the background – that is most likely to be text ink.
 */
export function sampleTextColor(
  ctx: CanvasRenderingContext2D,
  el: { x: number; y: number; w: number; h: number },
  bgHex: string,
  canvasW: number,
  canvasH: number,
): string {
  const bg = hexToRgb(bgHex) ?? { r: 255, g: 255, b: 255 };

  // Clamp sample region to canvas bounds, leave a 1 px inset
  const sx = Math.max(1, Math.floor(el.x + 1));
  const sy = Math.max(1, Math.floor(el.y + 1));
  const ex = Math.min(canvasW - 1, Math.floor(el.x + el.w - 1));
  const ey = Math.min(canvasH - 1, Math.floor(el.y + el.h - 1));

  if (sx >= ex || sy >= ey) return '';

  // Take at most an 18×5 grid of sample points
  const cols = Math.min(ex - sx, 18);
  const rows = Math.min(ey - sy, 5);
  const stepX = (ex - sx) / (cols + 1);
  const stepY = (ey - sy) / (rows + 1);

  let bestDist = 0;
  let bestHex = '';

  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const px = Math.round(sx + col * stepX);
      const py = Math.round(sy + row * stepY);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const dist =
        Math.abs(d[0] - bg.r) + Math.abs(d[1] - bg.g) + Math.abs(d[2] - bg.b);
      if (dist > bestDist) {
        bestDist = dist;
        bestHex = toHex(d[0], d[1], d[2]);
      }
    }
  }

  // If difference is negligible the pixel is background — return empty (unknown)
  return bestDist > 30 ? bestHex : '';
}

export function concatTransform(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function layoutSignature(
  els: { type: string; x: number; y: number; w: number; h: number }[],
  pw: number,
  ph: number,
): string {
  if (!els.length) return '';
  return els
    .map((e) => {
      const col = Math.round((e.x / pw) * 10);
      const row = Math.round((e.y / ph) * 10);
      const w = Math.max(1, Math.round((e.w / pw) * 10));
      const h = Math.max(1, Math.round((e.h / ph) * 10));
      return `${e.type[0]}:${col},${row},${w},${h}`;
    })
    .sort()
    .join('|');
}

function jaccard(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const sa = new Set(a.split('|'));
  const sb = new Set(b.split('|'));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
}

export function clusterTemplates(pds: PageData[]): TemplateCluster[] {
  const cs: TemplateCluster[] = [];
  pds.forEach((pd) => {
    let found = false;
    for (const c of cs) {
      if (jaccard(c.sig, pd.signature) >= 0.62) {
        c.pageNums.push(pd.pageNum);
        found = true;
        break;
      }
    }
    if (!found) cs.push({ id: `T${cs.length + 1}`, sig: pd.signature, pageNums: [pd.pageNum] });
  });
  return cs;
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/** macOS / some sources omit MIME type on drag; match common image extensions. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif|ico)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;

export function isLikelyImageFile(f: File | null | undefined): boolean {
  if (!f) return false;
  if (f.type && f.type.startsWith('image/')) return true;
  if (IMAGE_EXT_RE.test(f.name || '')) return true;
  return false;
}

export function isLikelyVideoFile(f: File | null | undefined): boolean {
  if (!f) return false;
  if (f.type && f.type.startsWith('video/')) return true;
  if (VIDEO_EXT_RE.test(f.name || '')) return true;
  return false;
}

function firstImageLikeFileFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt?.files?.length) return null;
  return Array.from(dt.files).find(isLikelyImageFile) || null;
}

function decodeHtmlEntities(s: string): string {
  if (!s) return s;
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

export function absolutizeUrl(u: string): string {
  try {
    return new URL(u, document.baseURI).href;
  } catch {
    return u;
  }
}

/** When dragging a full image from a page (not a file), the browser often exposes a URL or HTML, not Files. */
function extractImageUrlFromDataTransfer(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const first = uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (first && !first.startsWith('#') && (first.startsWith('http') || first.startsWith('data:image/'))) {
      return first.startsWith('data:') ? first : absolutizeUrl(first);
    }
  }
  const plain = dt.getData('text/plain')?.trim();
  if (plain && (plain.startsWith('http') || plain.startsWith('data:image/'))) {
    return plain.startsWith('data:') ? plain : absolutizeUrl(plain);
  }
  const html = dt.getData('text/html');
  if (html) {
    const m = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (m) return absolutizeUrl(decodeHtmlEntities(m[1]));
    const m2 = html.match(/srcset\s*=\s*["']([^"']+)/i);
    if (m2) {
      const part = m2[1].split(',')[0].trim().split(/\s+/)[0];
      if (part) return absolutizeUrl(decodeHtmlEntities(part));
    }
  }
  return null;
}

async function imageUrlToFile(url: string): Promise<File | null> {
  if (url.startsWith('data:image/')) {
    const res = await fetch(url);
    const blob = await res.blob();
    return new File([blob], 'image.png', { type: blob.type || 'image/png' });
  }
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const ct = blob.type || '';
    if (ct && !ct.startsWith('image/') && !IMAGE_EXT_RE.test(url.split('?')[0])) return null;
    const name = (url.split('/').pop() || 'image').split('?')[0] || 'image.png';
    return new File([blob], name, { type: ct || 'image/png' });
  } catch {
    /* fall through */
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        c.toBlob(
          (blob) => {
            if (!blob) {
              resolve(null);
              return;
            }
            resolve(new File([blob], 'image.png', { type: blob.type || 'image/png' }));
          },
          'image/png',
        );
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** File from OS, or image dragged from a webpage (URL / HTML payload). */
export async function imageFileFromDataTransfer(dt: DataTransfer | null): Promise<File | null> {
  const direct = firstImageLikeFileFromDataTransfer(dt);
  if (direct) return direct;
  const url = extractImageUrlFromDataTransfer(dt);
  if (!url) return null;
  return imageUrlToFile(url);
}

export function regionFromPdfDataUrl(
  fullUrl: string,
  el: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(el.w));
      c.height = Math.max(1, Math.round(el.h));
      c.getContext('2d')!.drawImage(img, el.x, el.y, el.w, el.h, 0, 0, el.w, el.h);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(null);
    img.src = fullUrl;
  });
}

export function cropDataUrl(
  sourceDataUrl: string,
  rect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { x, y, w, h } = rect;
      const cw = Math.max(1, Math.round(w));
      const ch = Math.max(1, Math.round(h));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, cw, ch);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(sourceDataUrl);
    img.src = sourceDataUrl;
  });
}

export function drawImageFit(
  ctx: CanvasRenderingContext2D,
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      ctx.drawImage(im, x, y, w, h);
      resolve();
    };
    im.onerror = () => resolve();
    im.src = src;
  });
}

/** Display rect for hit-test (PDF images may have x,y/w/h overrides in imageEdits). */
export function getImageDisplayBounds(
  el: ImageElement,
  pn: number,
  imageEdits: ImageEditsMap,
): { x: number; y: number; w: number; h: number } {
  if (el.type !== 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el._userAdded) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const ed = imageEdits[pn]?.[el.id];
  return {
    x: ed?.x ?? el.x,
    y: ed?.y ?? el.y,
    w: ed?.w ?? el.w,
    h: ed?.h ?? el.h,
  };
}

const MIN_PLACE = { w: 32, h: 24 } as const;

/** Resize a box by dragging a handle; pointer (px, py) is in page coordinates. */
export function rectFromResizeHandle(
  handle: ResizeHandleId,
  sr: { x: number; y: number; w: number; h: number },
  px: number,
  py: number,
  pw: number,
  ph: number,
  minW = MIN_PLACE.w,
  minH = MIN_PLACE.h,
): { x: number; y: number; w: number; h: number } {
  const right = sr.x + sr.w;
  const bottom = sr.y + sr.h;
  let x = sr.x;
  let y = sr.y;
  let w = sr.w;
  let h = sr.h;

  switch (handle) {
    case 'e': {
      w = Math.max(minW, Math.min(px, pw) - sr.x);
      break;
    }
    case 's': {
      h = Math.max(minH, Math.min(py, ph) - sr.y);
      break;
    }
    case 'w': {
      const nx = Math.min(Math.max(0, px), right - minW);
      w = right - nx;
      x = nx;
      break;
    }
    case 'n': {
      const ny = Math.min(Math.max(0, py), bottom - minH);
      h = bottom - ny;
      y = ny;
      break;
    }
    case 'se': {
      w = Math.max(minW, Math.min(px, pw) - sr.x);
      h = Math.max(minH, Math.min(py, ph) - sr.y);
      break;
    }
    case 'sw': {
      const nx = Math.min(Math.max(0, px), right - minW);
      w = right - nx;
      x = nx;
      h = Math.max(minH, Math.min(py, ph) - sr.y);
      break;
    }
    case 'ne': {
      w = Math.max(minW, Math.min(px, pw) - sr.x);
      const ny = Math.min(Math.max(0, py), bottom - minH);
      h = bottom - ny;
      y = ny;
      break;
    }
    case 'nw': {
      const nx = Math.min(Math.max(0, px), right - minW);
      const ny = Math.min(Math.max(0, py), bottom - minH);
      x = nx;
      y = ny;
      w = right - nx;
      h = bottom - ny;
      break;
    }
    default:
      break;
  }

  x = Math.max(0, Math.min(x, pw - minW));
  y = Math.max(0, Math.min(y, ph - minH));
  w = Math.max(minW, Math.min(w, pw - x));
  h = Math.max(minH, Math.min(h, ph - y));
  return { x, y, w, h };
}

export function aabbOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export type ResolvePlacementOptions = {
  minW?: number;
  minH?: number;
  /** When true (resize), may shrink dimensions to escape tight spots. */
  allowShrink?: boolean;
  /** Prefer staying close to this point (e.g. raw cursor intent). */
  preferX?: number;
  preferY?: number;
};

/**
 * Adjusts a placement rectangle so it does not overlap any obstacle, staying on the page.
 * Uses flush positions and optional shrinking (for resize) so elements stay in their own space.
 */
export function resolvePlacementRectAgainstObstacles(
  r: { x: number; y: number; w: number; h: number },
  obstacles: readonly { x: number; y: number; w: number; h: number }[],
  pw: number,
  ph: number,
  options: ResolvePlacementOptions = {},
): { x: number; y: number; w: number; h: number } {
  const minW = options.minW ?? MIN_PLACE.w;
  const minH = options.minH ?? MIN_PLACE.h;
  const allowShrink = options.allowShrink ?? false;
  const preferX = options.preferX ?? r.x;
  const preferY = options.preferY ?? r.y;

  let x = Math.max(0, Math.min(r.x, Math.max(0, pw - minW)));
  let y = Math.max(0, Math.min(r.y, Math.max(0, ph - minH)));
  let w = Math.max(minW, Math.min(r.w, Math.max(minW, pw - x)));
  let h = Math.max(minH, Math.min(r.h, Math.max(minH, ph - y)));

  const validAgainstAll = (tx: number, ty: number, tw: number, th: number): boolean => {
    const test = { x: tx, y: ty, w: tw, h: th };
    return !obstacles.some((o) => aabbOverlap(test, o));
  };

  const score = (tx: number, ty: number): number => {
    return (tx - preferX) ** 2 + (ty - preferY) ** 2;
  };

  for (let iter = 0; iter < 72; iter++) {
    if (validAgainstAll(x, y, w, h)) break;

    const cands: { x: number; y: number; w: number; h: number; s: number }[] = [];
    const pushCand = (tx: number, ty: number, tw: number, th: number) => {
      const cx = Math.max(0, Math.min(tx, pw - tw));
      const cy = Math.max(0, Math.min(ty, ph - th));
      if (!validAgainstAll(cx, cy, tw, th)) return;
      cands.push({ x: cx, y: cy, w: tw, h: th, s: score(cx, cy) });
    };

    for (const o of obstacles) {
      const self = { x, y, w, h };
      if (!aabbOverlap(self, o)) continue;
      pushCand(o.x - w, y, w, h);
      pushCand(o.x + o.w, y, w, h);
      pushCand(x, o.y - h, w, h);
      pushCand(x, o.y + o.h, w, h);
      pushCand(o.x - w, o.y - h, w, h);
      pushCand(o.x + o.w, o.y - h, w, h);
      pushCand(o.x - w, o.y + o.h, w, h);
      pushCand(o.x + o.w, o.y + o.h, w, h);
    }

    if (cands.length > 0) {
      cands.sort((a, b) => a.s - b.s);
      const pick = cands[0];
      x = pick.x;
      y = pick.y;
      w = pick.w;
      h = pick.h;
      continue;
    }

    if (allowShrink) {
      const nw = Math.max(minW, w * 0.94);
      const nh = Math.max(minH, h * 0.94);
      if (nw < w - 0.5 || nh < h - 0.5) {
        w = nw;
        h = nh;
        x = Math.max(0, Math.min(x, pw - w));
        y = Math.max(0, Math.min(y, ph - h));
        continue;
      }
    }

    // Last resort: axis depenetration toward preferred point (helps when flush candidates are invalid)
    const hit = obstacles.find((o) => aabbOverlap({ x, y, w, h }, o));
    if (!hit) break;
    const overlapX = Math.min(x + w, hit.x + hit.w) - Math.max(x, hit.x);
    const overlapY = Math.min(y + h, hit.y + hit.h) - Math.max(y, hit.y);
    if (overlapX <= 0 || overlapY <= 0) break;
    const ax = x + w / 2;
    const ay = y + h / 2;
    const hx = hit.x + hit.w / 2;
    const hy = hit.y + hit.h / 2;
    if (overlapX < overlapY) {
      x += ax < hx ? -overlapX : overlapX;
    } else {
      y += ay < hy ? -overlapY : overlapY;
    }
    x = Math.max(0, Math.min(x, pw - w));
    y = Math.max(0, Math.min(y, ph - h));
  }

  return { x, y, w, h };
}

/** Top-most image at page coordinates (added images checked first — drawn above PDF images). */
export function findImageAtPagePoint(
  pg: PageData,
  pn: number,
  addedMap: AddedImagesMap,
  px: number,
  py: number,
  imageEdits: ImageEditsMap,
): ImageElement | null {
  const inRect = (x: number, y: number, w: number, h: number) =>
    px >= x && px <= x + w && py >= y && py <= y + h;
  const added = addedMap[pn] || [];
  for (let i = added.length - 1; i >= 0; i--) {
    const el = added[i];
    if (el.type === 'image' && inRect(el.x, el.y, el.w, el.h)) return el;
  }
  const pageEdits = imageEdits[pn] || {};
  const candidates: { el: ImageElement; area: number }[] = [];
  for (const el of pg.images) {
    if (pageEdits[el.id]?.removed) continue;
    const b = getImageDisplayBounds(el, pn, imageEdits);
    if (!inRect(b.x, b.y, b.w, b.h)) continue;
    candidates.push({ el, area: Math.max(1, b.w) * Math.max(1, b.h) });
  }
  if (!candidates.length) return null;
  // Prefer the most specific hit when PDF images overlap (smallest box under pointer).
  candidates.sort((a, b) => a.area - b.area);
  return candidates[0]!.el;
}

export function findVideoAtPagePoint(
  pn: number,
  addedVideosMap: AddedVideosMap,
  px: number,
  py: number,
): VideoElement | null {
  const list = addedVideosMap[pn] || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];
    if (px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h) return el;
  }
  return null;
}

/** After removing one page, shift numeric keys so page numbers stay 1…n. */
export function remapPageKeyedState<T>(obj: Record<number, T> | undefined, deletedPageNum: number): Record<number, T> {
  const next: Record<number, T> = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const pn = Number(k);
    if (pn === deletedPageNum || Number.isNaN(pn)) return;
    const nk = pn > deletedPageNum ? pn - 1 : pn;
    next[nk] = v;
  });
  return next;
}

/** After inserting a blank page at 1-based position `insert1Based`, shift keys at or above that slot. */
export function remapPageKeyedStateInsert<T>(
  obj: Record<number, T> | undefined,
  insert1Based: number,
): Record<number, T> {
  const next: Record<number, T> = {};
  const keys = Object.keys(obj || {})
    .map(Number)
    .filter((k) => !Number.isNaN(k))
    .sort((a, b) => b - a);
  keys.forEach((pn) => {
    if (pn >= insert1Based) next[pn + 1] = obj![pn];
    else next[pn] = obj![pn];
  });
  return next;
}

/** Blank page matching extract shape (same pixel size as reference page). */
export function createBlankPageData(width: number, height: number, bgColor = '#ffffff'): PageData {
  const bg = bgColor && String(bgColor).startsWith('#') ? bgColor : '#ffffff';
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  const fullUrl = c.toDataURL('image/jpeg', 0.92);
  const tw = Math.max(64, Math.round(c.width * 0.16));
  const th = Math.max(64, Math.round(c.height * 0.16));
  const tc = document.createElement('canvas');
  tc.width = tw;
  tc.height = th;
  const tctx = tc.getContext('2d')!;
  tctx.fillStyle = bg;
  tctx.fillRect(0, 0, tw, th);
  const thumbUrl = tc.toDataURL('image/jpeg', 0.7);
  return {
    pageNum: 0,
    width: c.width,
    height: c.height,
    fullUrl,
    thumbUrl,
    bgColor: bg,
    textElements: [],
    shapes: [],
    images: [],
    allElements: [],
    docColors: [],
    signature: '',
    templateId: null,
  };
}
