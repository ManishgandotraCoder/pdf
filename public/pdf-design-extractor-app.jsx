const { useState, useEffect, useRef, useCallback } = React;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── Utilities ────────────────────────────────────────────────────────────────
function toHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function argsToHex(args, isGray = false) {
  if (!args || !args.length) return null;
  if (isGray) { const g = args[0] * 255; return toHex(g, g, g); }
  if (args.length >= 3) return toHex(args[0] * 255, args[1] * 255, args[2] * 255);
  return null;
}
function isWhiteish(hex) {
  if (!hex) return true;
  const h = hex.replace('#', '').toLowerCase();
  return h === 'ffffff' || h === 'fff' || h.includes('NaN');
}
function concatTransform(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function layoutSig(els, pw, ph) {
  if (!els.length) return '';
  return els.map(e => {
    const col = Math.round((e.x / pw) * 10), row = Math.round((e.y / ph) * 10);
    const w = Math.max(1, Math.round((e.w / pw) * 10)), h = Math.max(1, Math.round((e.h / ph) * 10));
    return `${e.type[0]}:${col},${row},${w},${h}`;
  }).sort().join('|');
}
function jaccard(a, b) {
  if (!a && !b) return 1; if (!a || !b) return 0;
  const sa = new Set(a.split('|')), sb = new Set(b.split('|'));
  const inter = [...sa].filter(x => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
}
function clusterTemplates(pds) {
  const cs = [];
  pds.forEach(pd => {
    let found = false;
    for (const c of cs) { if (jaccard(c.sig, pd.signature) >= 0.62) { c.pageNums.push(pd.pageNum); found = true; break; } }
    if (!found) cs.push({ id: `T${cs.length + 1}`, sig: pd.signature, pageNums: [pd.pageNum] });
  });
  return cs;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/** macOS / some sources omit MIME type on drag; match common image extensions. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif|ico)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;
function isLikelyImageFile(f) {
  if (!f) return false;
  if (f.type && f.type.startsWith('image/')) return true;
  if (IMAGE_EXT_RE.test(f.name || '')) return true;
  return false;
}
function isLikelyVideoFile(f) {
  if (!f) return false;
  if (f.type && f.type.startsWith('video/')) return true;
  if (VIDEO_EXT_RE.test(f.name || '')) return true;
  return false;
}

function firstImageLikeFileFromDataTransfer(dt) {
  if (!dt?.files?.length) return null;
  return Array.from(dt.files).find(isLikelyImageFile) || null;
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function absolutizeUrl(u) {
  try {
    return new URL(u, document.baseURI).href;
  } catch {
    return u;
  }
}

/** When dragging a full image from a page (not a file), the browser often exposes a URL or HTML, not Files. */
function extractImageUrlFromDataTransfer(dt) {
  if (!dt) return null;
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const first = uriList.split(/\r?\n/).map(l => l.trim()).find(Boolean);
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

async function imageUrlToFile(url) {
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
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          resolve(new File([blob], 'image.png', { type: blob.type || 'image/png' }));
        }, 'image/png');
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** File from OS, or image dragged from a webpage (URL / HTML payload). */
async function imageFileFromDataTransfer(dt) {
  const direct = firstImageLikeFileFromDataTransfer(dt);
  if (direct) return direct;
  const url = extractImageUrlFromDataTransfer(dt);
  if (!url) return null;
  return imageUrlToFile(url);
}

function regionFromPdfDataUrl(fullUrl, el) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(el.w));
      c.height = Math.max(1, Math.round(el.h));
      c.getContext('2d').drawImage(img, el.x, el.y, el.w, el.h, 0, 0, el.w, el.h);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(null);
    img.src = fullUrl;
  });
}

function cropDataUrl(sourceDataUrl, rect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { x, y, w, h } = rect;
      const cw = Math.max(1, Math.round(w));
      const ch = Math.max(1, Math.round(h));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, cw, ch);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(sourceDataUrl);
    img.src = sourceDataUrl;
  });
}

function drawImageFit(ctx, src, x, y, w, h) {
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

/** Display rect for overlay / hit-test (PDF images may have x,y overrides in imageEdits). */
function getImageOverlayBounds(el, pn, imageEdits) {
  if (el.type !== 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el._userAdded) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const ed = imageEdits[pn]?.[el.id];
  return { x: ed?.x ?? el.x, y: ed?.y ?? el.y, w: el.w, h: el.h };
}

/** Top-most image at page coordinates (added images checked first — drawn above PDF images). */
function findImageAtPagePoint(pg, pn, addedMap, px, py, imageEdits) {
  const inRect = (x, y, w, h) =>
    px >= x && px <= x + w && py >= y && py <= y + h;
  const added = addedMap[pn] || [];
  for (let i = added.length - 1; i >= 0; i--) {
    const el = added[i];
    if (el.type === 'image' && inRect(el.x, el.y, el.w, el.h)) return el;
  }
  const iEd = imageEdits?.[pn];
  for (let i = pg.images.length - 1; i >= 0; i--) {
    const el = pg.images[i];
    const ox = iEd?.[el.id]?.x ?? el.x;
    const oy = iEd?.[el.id]?.y ?? el.y;
    if (inRect(ox, oy, el.w, el.h)) return el;
  }
  return null;
}

function findVideoAtPagePoint(pn, addedVideosMap, px, py) {
  const list = addedVideosMap[pn] || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];
    if (px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h) return el;
  }
  return null;
}

/** After removing one page, shift numeric keys so page numbers stay 1…n. */
function remapPageKeyedState(obj, deletedPageNum) {
  const next = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const pn = Number(k);
    if (pn === deletedPageNum || Number.isNaN(pn)) return;
    const nk = pn > deletedPageNum ? pn - 1 : pn;
    next[nk] = v;
  });
  return next;
}

/** After inserting a blank page at 1-based position `insert1Based`, shift keys at or above that slot. */
function remapPageKeyedStateInsert(obj, insert1Based) {
  const next = {};
  const keys = Object.keys(obj || {}).map(Number).filter(k => !Number.isNaN(k)).sort((a, b) => b - a);
  keys.forEach((pn) => {
    if (pn >= insert1Based) next[pn + 1] = obj[pn];
    else next[pn] = obj[pn];
  });
  return next;
}

/** Blank page matching extract shape (same pixel size as reference page). */
function createBlankPageData(width, height, bgColor = '#ffffff') {
  const bg = bgColor && String(bgColor).startsWith('#') ? bgColor : '#ffffff';
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  const fullUrl = c.toDataURL('image/jpeg', 0.92);
  const tw = Math.max(64, Math.round(c.width * 0.16));
  const th = Math.max(64, Math.round(c.height * 0.16));
  const tc = document.createElement('canvas');
  tc.width = tw;
  tc.height = th;
  const tctx = tc.getContext('2d');
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

// ─── PDF Extraction ───────────────────────────────────────────────────────────
async function extractPage(page, pageNum) {
  const SCALE = 1.5;
  const vp = page.getViewport({ scale: SCALE });
  const W = vp.width, H = vp.height;

  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const fullUrl = cvs.toDataURL('image/jpeg', 0.9);

  const tvp = page.getViewport({ scale: 0.16 });
  const tc = document.createElement('canvas');
  tc.width = tvp.width; tc.height = tvp.height;
  await page.render({ canvasContext: tc.getContext('2d'), viewport: tvp }).promise;
  const thumbUrl = tc.toDataURL('image/jpeg', 0.7);

  const px = ctx.getImageData(4, 4, 1, 1).data;
  const bgColor = toHex(px[0], px[1], px[2]);

  const textContent = await page.getTextContent({ includeMarkedContent: false });
  const styles = textContent.styles || {};

  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const OPS = pdfjsLib.OPS;

  const gsStack = [{ fill: '#333333', stroke: '#000000', ctm: [1, 0, 0, 1, 0, 0] }];
  const gs = () => gsStack[gsStack.length - 1];
  const docColors = new Set();
  const shapes = [], images = [];
  let pendingRect = null;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) {
      gsStack.push({ ...gs(), ctm: [...gs().ctm] });
    } else if (fn === OPS.restore) {
      if (gsStack.length > 1) gsStack.pop();
    } else if (fn === OPS.transform && args) {
      gs().ctm = concatTransform(gs().ctm, args);
    } else if (fn === OPS.setFillRGBColor && args) {
      const h = argsToHex(args); if (h) { gs().fill = h; if (!isWhiteish(h)) docColors.add(h); }
    } else if (fn === OPS.setFillGray && args) {
      const h = argsToHex(args, true); if (h) gs().fill = h;
    } else if ((fn === OPS.setFillColor || fn === OPS.setFillColorN) && args?.length >= 3) {
      const h = argsToHex(args); if (h && !isWhiteish(h)) { gs().fill = h; docColors.add(h); }
    } else if (fn === OPS.setStrokeRGBColor && args) {
      const h = argsToHex(args); if (h) { gs().stroke = h; if (!isWhiteish(h)) docColors.add(h); }
    } else if (fn === OPS.setStrokeGray && args) {
      const h = argsToHex(args, true); if (h) gs().stroke = h;
    } else if ((fn === OPS.setStrokeColor || fn === OPS.setStrokeColorN) && args?.length >= 3) {
      const h = argsToHex(args); if (h && !isWhiteish(h)) { gs().stroke = h; docColors.add(h); }
    } else if (fn === OPS.rectangle && args) {
      const [rx, ry, rw, rh] = args;
      if (Math.abs(rw) > 1 && Math.abs(rh) > 1) {
        const [x1, y1] = pdfjsLib.Util.applyTransform([rx, ry], vp.transform);
        const [x2, y2] = pdfjsLib.Util.applyTransform([rx + rw, ry + rh], vp.transform);
        pendingRect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      }
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
      if (pendingRect?.w > 2 && pendingRect?.h > 2) {
        const fill = gs().fill;
        if (!isWhiteish(fill)) { shapes.push({ id: `s_${pageNum}_${shapes.length}`, type: 'shape', ...pendingRect, fill, stroke: null }); docColors.add(fill); }
      }
      pendingRect = null;
    } else if (fn === OPS.stroke || fn === OPS.closeStroke) {
      if (pendingRect?.w > 0 && pendingRect?.h > 0) {
        const stroke = gs().stroke;
        if (!isWhiteish(stroke)) shapes.push({ id: `s_${pageNum}_${shapes.length}`, type: 'shape', ...pendingRect, fill: null, stroke });
      }
      pendingRect = null;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
      const m = gs().ctm;
      const pts = [[m[4], m[5]], [m[4] + m[0], m[5] + m[1]], [m[4] + m[2], m[5] + m[3]], [m[4] + m[0] + m[2], m[5] + m[1] + m[3]]];
      const xs = pts.map(p => pdfjsLib.Util.applyTransform(p, vp.transform)[0]);
      const ys = pts.map(p => pdfjsLib.Util.applyTransform(p, vp.transform)[1]);
      const iw = Math.max(...xs) - Math.min(...xs), ih = Math.max(...ys) - Math.min(...ys);
      if (iw > 20 && ih > 20) images.push({ id: `i_${pageNum}_${images.length}`, type: 'image', x: Math.min(...xs), y: Math.min(...ys), w: iw, h: ih });
    }
  }

  const textElements = [];
  textContent.items.forEach((item, idx) => {
    if (!item.str?.trim()) return;
    const [sx, sy] = pdfjsLib.Util.applyTransform([item.transform[4], item.transform[5]], vp.transform);
    const fontSize = Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2) * SCALE;
    const info = styles[item.fontName] || {};
    const raw = info.fontFamily || 'sans-serif';
    const fontFamily = raw.replace(/,.*$/, '').trim();
    textElements.push({
      id: `t_${pageNum}_${idx}`,
      type: 'text',
      x: sx, y: sy - fontSize,
      w: Math.max(item.width * SCALE, 4),
      h: Math.max(fontSize * 1.3, 8),
      content: item.str,
      style: {
        fontFamily,
        fontSize: Math.round(fontSize / SCALE * 10) / 10,
        fontSizePx: fontSize,           // in canvas pixels at 1.5x
        fontWeight: /bold/i.test(raw) || /bold/i.test(item.fontName) ? 'bold' : 'normal',
        fontStyle: /italic|oblique/i.test(raw) || /italic|oblique/i.test(item.fontName) ? 'italic' : 'normal',
      }
    });
  });

  const allEls = [...textElements, ...shapes, ...images].filter(e => e.x >= 0 && e.y >= 0 && e.x < W && e.y < H);

  return {
    pageNum, width: W, height: H, fullUrl, thumbUrl, bgColor,
    textElements, shapes, images, allElements: allEls,
    docColors: [...docColors].filter(c => !c.includes('NaN')),
    signature: layoutSig(allEls, W, H),
    templateId: null,
  };
}

// ─── Small Components ─────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700, marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid #e8ecf0' }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
      <span style={{ fontSize: 11, color: '#555' }}>{label}</span>
      <span style={{ fontSize: 11, color: '#334155', fontFamily: mono ? 'monospace' : 'inherit', maxWidth: 145, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{value ?? '—'}</span>
    </div>
  );
}
function TypeBadge({ type }) {
  const map = { text: '#2AACB8', shape: '#8B5CF6', image: '#F59E0B', video: '#6366F1' };
  return <span style={{ background: map[type] || '#555', color: '#fff', fontSize: 9, padding: '2px 7px', borderRadius: 4, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{type}</span>;
}

function IconAddImage() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" /><path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
function IconAddVideo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="5" width="14" height="14" rx="2" /><path d="M18 9l4 3v6l-4-3V9z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6" />
    </svg>
  );
}
function IconAddPage() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 3h11l5 5v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}
function IconUndo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}
function IconRedo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
  );
}

/** Overlay mode toolbar (icons only). */
function IconModeNone() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="M4.93 4.93l14.14 14.14" />
    </svg>
  );
}
function IconModeText() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M4 12h12M4 17h16" />
    </svg>
  );
}
function IconModeShapes() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="8" height="8" rx="1" /><circle cx="16" cy="9" r="5" />
    </svg>
  );
}
function IconModeImages() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" /><path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
function IconModeAll() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="16" height="11" rx="1" opacity="0.35" />
      <rect x="4" y="7" width="16" height="11" rx="1" opacity="0.65" />
      <rect x="6" y="11" width="16" height="11" rx="1" />
    </svg>
  );
}

const OVERLAY_MODE_ICONS = [
  ['off', 'None', IconModeNone],
  ['text', 'Text', IconModeText],
  ['shapes', 'Shapes', IconModeShapes],
  ['images', 'Images', IconModeImages],
  ['all', 'All', IconModeAll],
];

function ImageCropModal({ sourceUrl, onApply, onCancel }) {
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setNatural({ w, h });
      setCrop({ x: 0, y: 0, w, h });
    };
    img.src = sourceUrl;
  }, [sourceUrl]);

  const apply = async () => {
    const out = await cropDataUrl(sourceUrl, crop);
    onApply(out);
  };

  const pct = (v, max) => (max ? Math.round((v / max) * 100) : 0);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, maxWidth: 420, width: '100%', boxShadow: '0 20px 50px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>Crop image</div>
        <p style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>Adjust the crop rectangle (pixels from top-left of the current image).</p>
        {natural.w > 0 && (
          <div style={{ marginBottom: 12, borderRadius: 8, overflow: 'hidden', border: '1px solid #e8ecf0', background: '#f4f6fa' }}>
            <img alt="" src={sourceUrl} style={{ width: '100%', display: 'block', opacity: 0.85 }} />
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          {['x', 'y', 'w', 'h'].map((k) => (
            <label key={k} style={{ fontSize: 10, color: '#64748b' }}>
              {k.toUpperCase()} (px)
              <input type="number" value={Math.round(crop[k])} min={0}
                onChange={e => setCrop(prev => ({ ...prev, [k]: Math.max(0, +e.target.value || 0) }))}
                style={{ width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid #d1d9e0', borderRadius: 6, fontSize: 12 }} />
            </label>
          ))}
        </div>
        {natural.w > 0 && (
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 12 }}>
            Image {natural.w}×{natural.h}px · crop covers {pct(crop.w, natural.w)}% × {pct(crop.h, natural.h)}%
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #d1d9e0', background: '#fff', color: '#475569', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
          <button type="button" disabled={natural.w === 0 || crop.w < 1 || crop.h < 1} onClick={apply} style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: '#2AACB8', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600, opacity: natural.w === 0 || crop.w < 1 || crop.h < 1 ? 0.5 : 1 }}>Apply crop</button>
        </div>
      </div>
    </div>
  );
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────
function UploadZone({ onUpload }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f4f6fa', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="#2AACB8" fillOpacity="0.15" />
          <path d="M8 8h10a6 6 0 0 1 0 12H8V8z" stroke="#2AACB8" strokeWidth="2" fill="none" />
          <line x1="8" y1="14" x2="18" y2="14" stroke="#2AACB8" strokeWidth="1.5" />
        </svg>
        <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px', color: '#0f172a' }}>PDF Design Extractor</span>
      </div>
      <p style={{ color: '#555', fontSize: 13, maxWidth: 360, textAlign: 'center', lineHeight: 1.7 }}>
        Upload any PDF to extract colors, fonts, shapes and layout templates — then edit the text directly
      </p>
      <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') onUpload(f); }}
        onClick={() => ref.current.click()}
        style={{ border: `2px dashed ${drag ? '#2AACB8' : '#94a3b8'}`, borderRadius: 14, padding: '52px 88px', cursor: 'pointer', background: drag ? 'rgba(42,172,184,0.12)' : '#ffffff', textAlign: 'center', transition: 'all 0.2s' }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={drag ? '#2AACB8' : '#444'} strokeWidth="1.5" style={{ display: 'block', margin: '0 auto 14px' }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p style={{ color: drag ? '#2AACB8' : '#888', fontSize: 14, marginBottom: 6 }}>Drop PDF or <span style={{ color: '#2AACB8' }}>browse</span></p>
        <p style={{ color: '#64748b', fontSize: 11 }}>Proposals, reports, brochures — any PDF</p>
      </div>
      <input ref={ref} type="file" accept=".pdf" style={{ display: 'none' }} onChange={e => e.target.files[0] && onUpload(e.target.files[0])} />
    </div>
  );
}

function LoadingScreen({ progress, done, total }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f4f6fa', gap: 18 }}>
      <div style={{ fontSize: 11, color: '#555', letterSpacing: 1.5, textTransform: 'uppercase' }}>Extracting Design Data</div>
      <div style={{ width: 300, height: 4, background: '#e8ecf0', borderRadius: 2 }}>
        <div style={{ width: `${progress}%`, height: '100%', background: '#2AACB8', borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: '#2AACB8', fontVariantNumeric: 'tabular-nums' }}>{progress}%</div>
      <div style={{ fontSize: 11, color: '#64748b' }}>Page {done} of {total}</div>
    </div>
  );
}

// ─── Inline Text Editor (canvas overlay) ─────────────────────────────────────
function InlineEditor({ el, bgColor, initialValue, onSave, onCancel }) {
  const ref = useRef(null);
  const [val, setVal] = useState(initialValue);

  useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, []);

  const commit = () => onSave(val);

  return (
    <textarea
      ref={ref}
      className="edit-textarea"
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      }}
      style={{
        left: el.x - 1,
        top: el.y - 1,
        width: el.w + 8,
        minHeight: el.h + 4,
        fontSize: el.style.fontSizePx || el.h * 0.72,
        fontFamily: el.style.fontFamily || 'sans-serif',
        fontWeight: el.style.fontWeight,
        fontStyle: el.style.fontStyle,
        background: bgColor || '#ffffff',
      }}
    />
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [pages, setPages] = useState([]);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [totalPgs, setTotalPgs] = useState(0);
  const [selPage, setSelPage] = useState(0);
  const [selEl, setSelEl] = useState(null);
  const [editingId, setEditingId] = useState(null);  // id of element being inline-edited
  const [edits, setEdits] = useState({});    // { [pageNum]: { [elId]: newText } }
  const [imageEdits, setImageEdits] = useState({});    // { [pageNum]: { [imageId]: { removed?, src? } } }
  const [addedImages, setAddedImages] = useState({});  // { [pageNum]: [{ id, x,y,w,h, src, type:'image' }] }
  const [addedVideos, setAddedVideos] = useState({});  // { [pageNum]: [{ id, x,y,w,h, src blob url, type:'video' }] }
  const [cropModal, setCropModal] = useState(null);  // { sourceUrl, resolve: (dataUrl) => void }
  const [templates, setTemplates] = useState([]);
  const [tokens, setTokens] = useState({ colors: [], fonts: [], sizes: [] });
  const [overlay, setOverlay] = useState('text');
  const [showOverlay, setShowOverlay] = useState(true);
  const [zoom, setZoom] = useState(0.9);
  const canvasRef = useRef(null);
  const addImageInputRef = useRef(null);
  const addVideoInputRef = useRef(null);
  const pageStageRef = useRef(null);
  const [viewerImageDropActive, setViewerImageDropActive] = useState(false);
  const imageDragRef = useRef(null);
  const suppressImageClickRef = useRef(false);
  const [draggingImageId, setDraggingImageId] = useState(null);

  // Undo / redo (snapshots of edits + imageEdits + addedImages + addedVideos)
  const historyStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const isRestoringRef = useRef(false);
  const editsRef = useRef(edits);
  const imageEditsRef = useRef(imageEdits);
  const addedImagesRef = useRef(addedImages);
  const addedVideosRef = useRef(addedVideos);
  const lastTextHistoryAtRef = useRef(0);
  const [historyUi, setHistoryUi] = useState(0);

  useEffect(() => { editsRef.current = edits; }, [edits]);
  useEffect(() => { imageEditsRef.current = imageEdits; }, [imageEdits]);
  useEffect(() => { addedImagesRef.current = addedImages; }, [addedImages]);
  useEffect(() => { addedVideosRef.current = addedVideos; }, [addedVideos]);

  const captureBeforeChange = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap = {
      edits: JSON.parse(JSON.stringify(editsRef.current)),
      imageEdits: JSON.parse(JSON.stringify(imageEditsRef.current)),
      addedImages: JSON.parse(JSON.stringify(addedImagesRef.current)),
      addedVideos: JSON.parse(JSON.stringify(addedVideosRef.current)),
    };
    historyStackRef.current = [...historyStackRef.current.slice(-39), snap];
    redoStackRef.current = [];
    setHistoryUi(u => u + 1);
  }, []);

  const undo = useCallback(() => {
    if (historyStackRef.current.length === 0) return;
    isRestoringRef.current = true;
    const current = {
      edits: JSON.parse(JSON.stringify(editsRef.current)),
      imageEdits: JSON.parse(JSON.stringify(imageEditsRef.current)),
      addedImages: JSON.parse(JSON.stringify(addedImagesRef.current)),
      addedVideos: JSON.parse(JSON.stringify(addedVideosRef.current)),
    };
    redoStackRef.current.push(current);
    const prev = historyStackRef.current.pop();
    setEdits(prev.edits);
    setImageEdits(prev.imageEdits);
    setAddedImages(prev.addedImages);
    setAddedVideos(prev.addedVideos);
    setSelEl(null);
    setEditingId(null);
    setHistoryUi(u => u + 1);
    queueMicrotask(() => { isRestoringRef.current = false; });
  }, []);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    isRestoringRef.current = true;
    const current = {
      edits: JSON.parse(JSON.stringify(editsRef.current)),
      imageEdits: JSON.parse(JSON.stringify(imageEditsRef.current)),
      addedImages: JSON.parse(JSON.stringify(addedImagesRef.current)),
      addedVideos: JSON.parse(JSON.stringify(addedVideosRef.current)),
    };
    historyStackRef.current.push(current);
    const next = redoStackRef.current.pop();
    setEdits(next.edits);
    setImageEdits(next.imageEdits);
    setAddedImages(next.addedImages);
    setAddedVideos(next.addedVideos);
    setSelEl(null);
    setEditingId(null);
    setHistoryUi(u => u + 1);
    queueMicrotask(() => { isRestoringRef.current = false; });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = e.target?.tagName;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'file')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const canUndo = historyStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;
  void historyUi;

  // helper: get/set edits for a page
  const getEdit = (pageNum, elId) => edits[pageNum]?.[elId];
  /** historyMode: 'debounced' (inspector typing), 'commit' (inline save / reset), 'skip' internal */
  const setEdit = useCallback((pageNum, elId, val, historyMode = 'debounced') => {
    if (historyMode !== 'skip') {
      const now = Date.now();
      const shouldSnap =
        historyMode === 'commit' ||
        now - lastTextHistoryAtRef.current > 650;
      if (shouldSnap) {
        captureBeforeChange();
        lastTextHistoryAtRef.current = now;
      }
    }
    setEdits(prev => ({
      ...prev,
      [pageNum]: { ...(prev[pageNum] || {}), [elId]: val },
    }));
  }, [captureBeforeChange]);

  const clearEdit = useCallback((pageNum, elId) => {
    captureBeforeChange();
    setEdits(prev => {
      const pg = { ...(prev[pageNum] || {}) };
      delete pg[elId];
      return { ...prev, [pageNum]: pg };
    });
  }, [captureBeforeChange]);
  const pageHasEdits = pn => Object.keys(edits[pn] || {}).length > 0;
  const totalEdits = Object.values(edits).reduce((s, pg) => s + Object.keys(pg).length, 0);

  const pageHasImageMods = pn =>
    Object.keys(imageEdits[pn] || {}).length > 0 || (addedImages[pn] || []).length > 0 || (addedVideos[pn] || []).length > 0;
  const totalImageMods =
    Object.values(imageEdits).reduce((s, o) => s + Object.keys(o).length, 0) +
    Object.values(addedImages).reduce((s, arr) => s + arr.length, 0) +
    Object.values(addedVideos).reduce((s, arr) => s + arr.length, 0);

  const deletePageAtIndex = useCallback((delIdx) => {
    if (pages.length <= 1) {
      alert('A PDF must keep at least one page.');
      return;
    }
    const delPn = pages[delIdx]?.pageNum;
    if (delPn === undefined) return;
    if (!confirm(`Delete page ${delPn}? You can use Undo (⌘Z / Ctrl+Z) to restore.`)) return;
    captureBeforeChange();
    (addedVideos[delPn] || []).forEach(v => { if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src); });
    const n = pages.length;
    const newPages = pages.filter((_, i) => i !== delIdx).map((p, i) => ({ ...p, pageNum: i + 1 }));
    setPages(newPages);
    setTemplates(clusterTemplates(newPages));
    setEdits(prev => remapPageKeyedState(prev, delPn));
    setImageEdits(prev => remapPageKeyedState(prev, delPn));
    setAddedImages(prev => remapPageKeyedState(prev, delPn));
    setAddedVideos(prev => remapPageKeyedState(prev, delPn));
    setSelEl(null);
    setEditingId(null);
    setSelPage(prev => {
      if (delIdx < prev) return prev - 1;
      if (delIdx === prev) return Math.min(delIdx, n - 2);
      return prev;
    });
  }, [pages, addedVideos, captureBeforeChange]);

  const addPageAfterCurrent = useCallback(() => {
    if (!pages.length) return;
    captureBeforeChange();
    const refPg = pages[selPage] || pages[0];
    const W = refPg.width;
    const H = refPg.height;
    const insertIdx = selPage + 1;
    const insert1Based = insertIdx + 1;
    const blank = createBlankPageData(W, H, refPg.bgColor);
    const newPages = [...pages.slice(0, insertIdx), blank, ...pages.slice(insertIdx)].map((p, i) => ({ ...p, pageNum: i + 1 }));
    setPages(newPages);
    setTemplates(clusterTemplates(newPages));
    setEdits(prev => remapPageKeyedStateInsert(prev, insert1Based));
    setImageEdits(prev => remapPageKeyedStateInsert(prev, insert1Based));
    setAddedImages(prev => remapPageKeyedStateInsert(prev, insert1Based));
    setAddedVideos(prev => remapPageKeyedStateInsert(prev, insert1Based));
    setSelEl(null);
    setEditingId(null);
    setSelPage(insertIdx);
  }, [pages, selPage, captureBeforeChange]);

  // ── Upload ──
  const handleUpload = useCallback(async file => {
    Object.values(addedVideosRef.current).flat().forEach(v => { if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src); });
    setLoading(true); setProgress(0); setDoneCount(0);
    setFileName(file.name); setPages([]); setSelPage(0); setSelEl(null); setEdits({}); setEditingId(null);
    setImageEdits({}); setAddedImages({}); setAddedVideos({});
    historyStackRef.current = []; redoStackRef.current = []; setHistoryUi(u => u + 1);
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const n = pdf.numPages; setTotalPgs(n);
      const all = [];
      for (let i = 1; i <= n; i++) {
        const pg = await pdf.getPage(i);
        const data = await extractPage(pg, i);
        all.push(data);
        setDoneCount(i); setProgress(Math.round(i / n * 100));
        setPages(p => [...p, data]);
      }
      const clusters = clusterTemplates(all);
      all.forEach(pd => { const c = clusters.find(cl => cl.pageNums.includes(pd.pageNum)); if (c) pd.templateId = c.id; });
      setTemplates(clusters); setPages([...all]);
      const ac = new Set(), af = new Set(), as_ = new Set();
      all.forEach(pd => {
        pd.docColors.forEach(c => ac.add(c));
        pd.textElements.forEach(e => { if (e.style.fontFamily && e.style.fontFamily !== 'Unknown') af.add(e.style.fontFamily); if (e.style.fontSize > 0) as_.add(e.style.fontSize); });
      });
      setTokens({ colors: [...ac].filter(c => !c.includes('NaN')).slice(0, 40), fonts: [...af].slice(0, 12), sizes: [...as_].sort((a, b) => a - b).slice(0, 20) });
    } catch (err) { console.error(err); alert('Error: ' + err.message); }
    setLoading(false);
  }, []);

  const patchImageEdit = useCallback((pageNum, id, patch) => {
    setImageEdits(prev => ({
      ...prev,
      [pageNum]: { ...(prev[pageNum] || {}), [id]: { ...(prev[pageNum]?.[id] || {}), ...patch } },
    }));
  }, []);

  const addImageFromFile = useCallback(async (file, centerX, centerY) => {
    if (!isLikelyImageFile(file)) return;
    const pg = pages[selPage];
    if (!pg) return;
    captureBeforeChange();
    const src = await readFileAsDataURL(file);
    const pn = pg.pageNum;
    const id = `user_${pn}_${Date.now()}`;
    const w = Math.min(240, pg.width * 0.4);
    const h = Math.min(200, pg.height * 0.3);
    let x;
    let y;
    if (typeof centerX === 'number' && typeof centerY === 'number' && !Number.isNaN(centerX) && !Number.isNaN(centerY)) {
      x = Math.min(Math.max(centerX - w / 2, 0), Math.max(0, pg.width - w));
      y = Math.min(Math.max(centerY - h / 2, 0), Math.max(0, pg.height - h));
    } else {
      x = Math.max(8, (pg.width - w) / 2);
      y = Math.max(8, (pg.height - h) / 2);
    }
    setAddedImages(prev => ({
      ...prev,
      [pn]: [...(prev[pn] || []), { id, type: 'image', x, y, w, h, src, _userAdded: true }],
    }));
    setShowOverlay(true);
    setOverlay('images');
  }, [pages, selPage, captureBeforeChange]);

  const handleAddImageFile = useCallback((file) => addImageFromFile(file), [addImageFromFile]);

  const addVideoFromFile = useCallback(async (file, centerX, centerY) => {
    if (!isLikelyVideoFile(file)) return;
    const pg = pages[selPage];
    if (!pg) return;
    captureBeforeChange();
    const src = URL.createObjectURL(file);
    const pn = pg.pageNum;
    const id = `vid_${pn}_${Date.now()}`;
    const w = Math.min(320, pg.width * 0.5);
    const h = Math.min(220, pg.height * 0.36);
    let x;
    let y;
    if (typeof centerX === 'number' && typeof centerY === 'number' && !Number.isNaN(centerX) && !Number.isNaN(centerY)) {
      x = Math.min(Math.max(centerX - w / 2, 0), Math.max(0, pg.width - w));
      y = Math.min(Math.max(centerY - h / 2, 0), Math.max(0, pg.height - h));
    } else {
      x = Math.max(8, (pg.width - w) / 2);
      y = Math.max(8, (pg.height - h) / 2);
    }
    setAddedVideos(prev => ({
      ...prev,
      [pn]: [...(prev[pn] || []), { id, type: 'video', x, y, w, h, src, _userAdded: true }],
    }));
    setShowOverlay(true);
    setOverlay('images');
  }, [pages, selPage, captureBeforeChange]);

  const handleAddVideoFile = useCallback((file) => addVideoFromFile(file), [addVideoFromFile]);

  const handleReplaceVideo = useCallback((el, file) => {
    if (!isLikelyVideoFile(file)) return;
    captureBeforeChange();
    const pg = pages[selPage];
    if (!pg) return;
    const pn = pg.pageNum;
    const next = URL.createObjectURL(file);
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
    setAddedVideos(prev => ({
      ...prev,
      [pn]: (prev[pn] || []).map(a => (a.id === el.id ? { ...a, src: next } : a)),
    }));
  }, [pages, selPage, captureBeforeChange]);

  const handleRemoveVideo = useCallback((el) => {
    const pg = pages[selPage];
    if (!pg) return;
    captureBeforeChange();
    const pn = pg.pageNum;
    if (el.src?.startsWith('blob:')) URL.revokeObjectURL(el.src);
    setAddedVideos(prev => ({
      ...prev,
      [pn]: (prev[pn] || []).filter(a => a.id !== el.id),
    }));
    setSelEl(null);
  }, [pages, selPage, captureBeforeChange]);

  const handleReplaceImage = useCallback(async (el, file) => {
    if (!isLikelyImageFile(file)) return;
    captureBeforeChange();
    const src = await readFileAsDataURL(file);
    const pg = pages[selPage];
    if (!pg) return;
    const pn = pg.pageNum;
    if (el._userAdded) {
      setAddedImages(prev => ({
        ...prev,
        [pn]: (prev[pn] || []).map(a => (a.id === el.id ? { ...a, src } : a)),
      }));
    } else {
      patchImageEdit(pn, el.id, { removed: false, src });
    }
  }, [pages, selPage, patchImageEdit, captureBeforeChange]);

  const handleViewerDragOver = useCallback((e) => {
    if (!pages.length) return;
    // Must always preventDefault while a PDF is open or the browser never fires drop (Safari often omits "Files" in types during dragover).
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [pages.length]);

  const handleViewerDragEnter = useCallback((e) => {
    if (!pages.length) return;
    e.preventDefault();
    setViewerImageDropActive(true);
  }, [pages.length]);

  const handleViewerDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setViewerImageDropActive(false);
  }, []);

  const handleViewerDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setViewerImageDropActive(false);
    let file = await imageFileFromDataTransfer(e.dataTransfer);
    if (!file) file = Array.from(e.dataTransfer.files || []).find(isLikelyVideoFile) || null;
    if (!file) return;
    const inner = pageStageRef.current;
    const pgLocal = pages[selPage];
    if (!inner || !pgLocal) return;
    const r = inner.getBoundingClientRect();
    const x = (e.clientX - r.left) / zoom;
    const y = (e.clientY - r.top) / zoom;
    if (isLikelyVideoFile(file)) {
      const vhit = findVideoAtPagePoint(pgLocal.pageNum, addedVideos, x, y);
      if (vhit) handleReplaceVideo(vhit, file);
      else await addVideoFromFile(file, x, y);
      return;
    }
    if (!isLikelyImageFile(file)) return;
    const hit = findImageAtPagePoint(pgLocal, pgLocal.pageNum, addedImages, x, y, imageEdits);
    if (hit) {
      await handleReplaceImage(hit, file);
    } else {
      await addImageFromFile(file, x, y);
    }
  }, [pages, selPage, zoom, addedImages, addedVideos, imageEdits, handleReplaceImage, handleReplaceVideo, addImageFromFile, addVideoFromFile]);

  const clientToPageCoords = useCallback((clientX, clientY) => {
    const inner = pageStageRef.current;
    if (!inner) return { x: 0, y: 0 };
    const r = inner.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  }, [zoom]);

  const onImagePointerDown = useCallback((e, el) => {
    if (e.button !== 0) return;
    if (el.type === 'video') {
      e.stopPropagation();
      const pg = pages[selPage];
      if (!pg) return;
      const pn = pg.pageNum;
      const ob = { x: el.x, y: el.y, w: el.w, h: el.h };
      const { x: px, y: py } = clientToPageCoords(e.clientX, e.clientY);
      imageDragRef.current = {
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
      setDraggingImageId(el.id);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (el.type !== 'image') return;
    const pg = pages[selPage];
    if (!pg) return;
    const pn = pg.pageNum;
    const ed = imageEditsRef.current?.[pn]?.[el.id];
    if (ed?.removed) return;
    e.stopPropagation();
    const ob = getImageOverlayBounds(el, pn, imageEditsRef.current);
    const { x: px, y: py } = clientToPageCoords(e.clientX, e.clientY);
    imageDragRef.current = {
      pointerId: e.pointerId,
      elId: el.id,
      pn,
      userAdded: !!el._userAdded,
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
      extracting: false,
      extractDone: false,
      fullUrl: pg.fullUrl,
      pdfImageEl: el._userAdded ? null : el,
    };
    setDraggingImageId(el.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [pages, selPage, clientToPageCoords]);

  const onImagePointerMove = useCallback((e) => {
    const d = imageDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const { x: px, y: py } = clientToPageCoords(e.clientX, e.clientY);
    if (!d.moved && Math.hypot(px - d.startPx, py - d.startPy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (!d.captured) {
        captureBeforeChange();
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
      setAddedVideos(prev => ({
        ...prev,
        [d.pn]: (prev[d.pn] || []).map(a => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      setSelEl(prev => (prev && prev.id === d.elId && prev.type === 'video' ? { ...prev, x: nx, y: ny } : prev));
      return;
    }

    if (d.userAdded) {
      setAddedImages(prev => ({
        ...prev,
        [d.pn]: (prev[d.pn] || []).map(a => (a.id === d.elId ? { ...a, x: nx, y: ny } : a)),
      }));
      setSelEl(prev => (prev && prev.id === d.elId && prev.type === 'image' ? { ...prev, x: nx, y: ny } : prev));
      return;
    }

    const hasSrc = !!(imageEditsRef.current?.[d.pn]?.[d.elId]?.src);
    if (!d.userAdded && (hasSrc || d.extractDone)) {
      patchImageEdit(d.pn, d.elId, { x: nx, y: ny });
      return;
    }

    if (d.extracting) return;
    if (!d.pdfImageEl) return;
    d.extracting = true;
    const { pn, elId, fullUrl, pdfImageEl } = d;
    void regionFromPdfDataUrl(fullUrl, pdfImageEl).then((dataUrl) => {
      d.extracting = false;
      if (!dataUrl) return;
      d.extractDone = true;
      const ref = imageDragRef.current;
      const nx2 = ref?.elId === elId ? (ref.latestNX ?? nx) : nx;
      const ny2 = ref?.elId === elId ? (ref.latestNY ?? ny) : ny;
      patchImageEdit(pn, elId, { src: dataUrl, removed: false, x: nx2, y: ny2 });
    });
  }, [clientToPageCoords, captureBeforeChange, patchImageEdit]);

  const onImagePointerUp = useCallback((e) => {
    const d = imageDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.moved) suppressImageClickRef.current = true;
    imageDragRef.current = null;
    setDraggingImageId(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const handleRemoveImage = useCallback((el) => {
    const pg = pages[selPage];
    if (!pg) return;
    captureBeforeChange();
    const pn = pg.pageNum;
    if (el._userAdded) {
      setAddedImages(prev => ({
        ...prev,
        [pn]: (prev[pn] || []).filter(a => a.id !== el.id),
      }));
      setSelEl(null);
    } else {
      patchImageEdit(pn, el.id, { removed: true, src: undefined });
    }
  }, [pages, selPage, patchImageEdit, captureBeforeChange]);

  const openCropForImage = useCallback(async (el) => {
    const pg = pages[selPage];
    if (!pg || el.type !== 'image') return;
    const pn = pg.pageNum;
    let sourceUrl = el._userAdded
      ? (addedImages[pn] || []).find(a => a.id === el.id)?.src
      : imageEdits[pn]?.[el.id]?.src;
    if (!sourceUrl) sourceUrl = await regionFromPdfDataUrl(pg.fullUrl, el);
    if (!sourceUrl) return;
    setCropModal({
      sourceUrl,
      resolve: (croppedUrl) => {
        captureBeforeChange();
        if (el._userAdded) {
          setAddedImages(prev => ({
            ...prev,
            [pn]: (prev[pn] || []).map(a => (a.id === el.id ? { ...a, src: croppedUrl } : a)),
          }));
        } else {
          setImageEdits(prev => ({
            ...prev,
            [pn]: {
              ...(prev[pn] || {}),
              [el.id]: { ...(prev[pn]?.[el.id] || {}), removed: false, src: croppedUrl },
            },
          }));
        }
        setCropModal(null);
      },
    });
  }, [pages, selPage, addedImages, imageEdits, captureBeforeChange]);

  // ── Render page canvas (PDF + image edits + added images) ──
  useEffect(() => {
    let cancelled = false;
    const pg = pages[selPage];
    if (!pg || !canvasRef.current) return;
    const img = new Image();
    img.onload = async () => {
      if (cancelled) return;
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      c.width = img.width;
      c.height = img.height;
      ctx.drawImage(img, 0, 0);
      const pn = pg.pageNum;
      const iEd = imageEdits[pn] || {};
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
        if (ox !== el.x || oy !== el.y) {
          ctx.fillStyle = bg;
          ctx.fillRect(el.x, el.y, el.w, el.h);
        }
        await drawImageFit(ctx, ed.src, ox, oy, el.w, el.h);
        if (cancelled) return;
      }
      for (const el of addedImages[pn] || []) {
        await drawImageFit(ctx, el.src, el.x, el.y, el.w, el.h);
        if (cancelled) return;
      }
    };
    img.src = pg.fullUrl;
    return () => { cancelled = true; };
  }, [selPage, pages, imageEdits, addedImages]);

  if (loading) return <LoadingScreen progress={progress} done={doneCount} total={totalPgs} />;
  if (!pages.length) return <UploadZone onUpload={handleUpload} />;

  const pg = pages[selPage];
  const pageEdits = edits[pg?.pageNum] || {};

  // Which elements to show in overlay (includes user-placed images)
  const overlayEls = pg ? [
    ...(overlay === 'text' || overlay === 'all' ? pg.textElements : []),
    ...(overlay === 'shapes' || overlay === 'all' ? pg.shapes : []),
    ...(overlay === 'images' || overlay === 'all' ? pg.images : []),
    ...(overlay === 'images' || overlay === 'all' ? (addedImages[pg.pageNum] || []) : []),
    ...(overlay === 'images' || overlay === 'all' ? (addedVideos[pg.pageNum] || []) : []),
  ] : [];

  // Text elements that have been edited on this page
  const editedTexts = pg ? pg.textElements.filter(e => pageEdits[e.id] !== undefined) : [];

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#f4f6fa' }}>

      {/* ══ LEFT SIDEBAR ══ */}
      <div style={{ width: 228, minWidth: 228, background: '#ffffff', borderRight: '1px solid #e8ecf0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '20px 14px 16px', borderBottom: '1px solid #e8ecf0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>Page {pg?.pageNum}/{pages.length}</span>
            {(totalEdits + totalImageMods) > 0 && (
              <span style={{ fontSize: 10, color: '#d97706', fontWeight: 600 }}>
                {totalEdits > 0 && `${totalEdits} text`}
                {totalEdits > 0 && totalImageMods > 0 && ' · '}
                {totalImageMods > 0 && `${totalImageMods} media`}
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
          <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700, padding: '5px 2px 7px' }}>Pages</div>
          {pages.map((p, idx) => (
            <div key={idx} onClick={() => { setSelPage(idx); setSelEl(null); setEditingId(null); }}
              style={{ marginBottom: 8, cursor: 'pointer', borderRadius: 6, overflow: 'hidden', border: `2px solid ${idx === selPage ? '#2AACB8' : 'transparent'}`, position: 'relative', transition: 'border-color 0.15s' }}>
              <button
                type="button"
                title={pages.length <= 1 ? 'Cannot delete the only page' : `Delete page ${p.pageNum}`}
                aria-label={`Delete page ${p.pageNum}`}
                onClick={(e) => { e.stopPropagation(); deletePageAtIndex(idx); }}
                disabled={pages.length <= 1}
                style={{
                  position: 'absolute',
                  top: 4,
                  left: 4,
                  zIndex: 2,
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  border: '1px solid rgba(0,0,0,0.1)',
                  background: 'rgba(255,255,255,0.95)',
                  color: pages.length <= 1 ? '#cbd5e1' : '#b91c1c',
                  cursor: pages.length <= 1 ? 'not-allowed' : 'pointer',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                }}
              >
                <IconTrash />
              </button>
              <img src={p.thumbUrl} style={{ width: '100%', display: 'block' }} alt={`p${p.pageNum}`} />
              <div style={{ position: 'absolute', bottom: 4, right: 4, background: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>{p.pageNum}</div>
              {(pageHasEdits(p.pageNum) || pageHasImageMods(p.pageNum)) && <div style={{ position: 'absolute', top: 4, right: 4, background: '#F59E0B', width: 8, height: 8, borderRadius: '50%' }} />}
            </div>
          ))}
        </div>
      </div>

      {/* ══ CENTER ══ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Toolbar */}
        <div style={{ minHeight: 64, background: '#ffffff', borderBottom: '1px solid #e8ecf0', display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 8, flexShrink: 0, flexWrap: 'wrap', rowGap: 8 }}>
          <span style={{ fontSize: 11, color: '#555' }}>Page {pg?.pageNum}/{pages.length}</span>
          {(totalEdits + totalImageMods) > 0 && (
            <span style={{ fontSize: 10, background: 'rgba(245,158,11,0.15)', color: '#F59E0B', padding: '2px 7px', borderRadius: 10, border: '1px solid rgba(245,158,11,0.3)' }}>
              {totalEdits > 0 && `${totalEdits} text`}
              {totalEdits > 0 && totalImageMods > 0 && ' · '}
              {totalImageMods > 0 && `${totalImageMods} media`}
            </span>
          )}

          <div style={{ flex: 1 }} />

          <div style={{ width: 1, height: 26, background: '#d1d9e0' }} />
          <button type="button" title="Undo (⌘Z / Ctrl+Z)" aria-label="Undo" onClick={undo} disabled={!canUndo} style={{ width: 36, height: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: canUndo ? '#e8ecf0' : '#f1f5f9', color: canUndo ? '#334155' : '#94a3b8', border: '1px solid #d1d9e0', borderRadius: 8, cursor: canUndo ? 'pointer' : 'not-allowed' }}><IconUndo /></button>
          <button type="button" title="Redo (⌘⇧Z / Ctrl+Y)" aria-label="Redo" onClick={redo} disabled={!canRedo} style={{ width: 36, height: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: canRedo ? '#e8ecf0' : '#f1f5f9', color: canRedo ? '#334155' : '#94a3b8', border: '1px solid #d1d9e0', borderRadius: 8, cursor: canRedo ? 'pointer' : 'not-allowed' }}><IconRedo /></button>

          <div style={{ width: 1, height: 26, background: '#d1d9e0' }} />
          <button type="button" onClick={() => {
            Object.values(addedVideosRef.current).flat().forEach(v => { if (v?.src?.startsWith('blob:')) URL.revokeObjectURL(v.src); });
            setPages([]); setTemplates([]); setTokens({ colors: [], fonts: [], sizes: [] }); setEdits({}); setImageEdits({}); setAddedImages({}); setAddedVideos({});
            historyStackRef.current = []; redoStackRef.current = []; setHistoryUi(u => u + 1);
          }} style={{ padding: '5px 9px', background: '#e8ecf0', color: '#666', border: '1px solid #d1d9e0', borderRadius: 5, fontSize: 11, cursor: 'pointer' }}>New</button>
        </div>

        {/* Page canvas + overlays */}
        <div
          style={{
            flex: 1, overflow: 'auto', padding: 20, display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            transition: 'background 0.15s, outline 0.15s',
            outline: viewerImageDropActive ? '2px dashed #2AACB8' : 'none',
            outlineOffset: -4,
            background: viewerImageDropActive ? 'rgba(42,172,184,0.08)' : 'transparent',
          }}
          onClick={() => { if (!editingId) setSelEl(null); }}
          onDragOver={handleViewerDragOver}
          onDragEnter={handleViewerDragEnter}
          onDragLeave={handleViewerDragLeave}
          onDrop={handleViewerDrop}
        >
          <div ref={pageStageRef} style={{ position: 'relative', display: 'inline-block', boxShadow: '0 12px 40px rgba(15,23,42,0.1)', transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
            <canvas ref={canvasRef} style={{ display: 'block' }} />

            {/* Placed videos (HTML layer above PDF bitmap) */}
            {(addedVideos[pg.pageNum] || []).map(v => (
              <video
                key={v.id}
                src={v.src}
                muted
                playsInline
                loop
                autoPlay
                style={{
                  position: 'absolute',
                  left: v.x,
                  top: v.y,
                  width: v.w,
                  height: v.h,
                  objectFit: 'cover',
                  pointerEvents: 'none',
                  borderRadius: 2,
                }}
              />
            ))}

            {/* ── Edited text overlays (cover original, always shown) ── */}
            {editedTexts.map(el => {
              const newText = pageEdits[el.id];
              if (newText === undefined || editingId === el.id) return null;
              return (
                <div key={el.id} className="edited-overlay" style={{
                  left: el.x - 2, top: el.y - 1,
                  width: el.w + 12, minHeight: el.h + 4,
                  background: pg.bgColor || '#ffffff',
                  fontSize: el.style.fontSizePx || el.h * 0.72,
                  fontFamily: el.style.fontFamily,
                  fontWeight: el.style.fontWeight,
                  fontStyle: el.style.fontStyle,
                  color: '#222',
                  padding: '1px 2px',
                }}>
                  {newText}
                </div>
              );
            })}

            {/* ── Inline editor (when double-clicking) ── */}
            {editingId && (() => {
              const el = pg.textElements.find(e => e.id === editingId);
              if (!el) return null;
              return (
                <InlineEditor
                  el={el}
                  bgColor={pg.bgColor}
                  initialValue={pageEdits[el.id] ?? el.content}
                  onSave={val => { setEdit(pg.pageNum, el.id, val, 'commit'); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              );
            })()}

            {/* ── Element overlay boxes ── */}
            {showOverlay && pg && (
              <div style={{ position: 'absolute', top: 0, left: 0, width: pg.width, height: pg.height, pointerEvents: 'none' }}>
                {overlayEls.map((el, idx) => {
                  const bord = el.type === 'text' ? '#2AACB8' : el.type === 'image' ? '#F59E0B' : el.type === 'video' ? '#6366F1' : '#8B5CF6';
                  const bg = el.type === 'text' ? 'rgba(42,172,184,0.1)' : el.type === 'image' ? 'rgba(245,158,11,0.1)' : el.type === 'video' ? 'rgba(99,102,241,0.12)' : 'rgba(139,92,246,0.1)';
                  const active = selEl?.id === el.id;
                  const hasEdit = el.type === 'text' && pageEdits[el.id] !== undefined;
                  const pn = pg.pageNum;
                  const imgEdited = el.type === 'image' && !el._userAdded && (imageEdits[pn]?.[el.id]?.src || imageEdits[pn]?.[el.id]?.removed);
                  const imgUser = el.type === 'image' && el._userAdded;
                  const vidUser = el.type === 'video';
                  const ob = getImageOverlayBounds(el, pn, imageEdits);
                  const imgRemoved = el.type === 'image' && imageEdits[pn]?.[el.id]?.removed;
                  const placementDrag = el.type === 'image' || el.type === 'video';
                  const imgCursor = !placementDrag ? (el.type === 'text' ? 'text' : 'pointer')
                    : el.type === 'image' && imgRemoved ? 'pointer' : (draggingImageId === el.id ? 'grabbing' : 'grab');
                  return (
                    <div key={el.id || idx}
                      onClick={e => {
                        e.stopPropagation();
                        if (editingId) return;
                        if (placementDrag && suppressImageClickRef.current) {
                          suppressImageClickRef.current = false;
                          return;
                        }
                        setSelEl(active ? null : el);
                      }}
                      onDoubleClick={e => { e.stopPropagation(); if (el.type === 'text') { setSelEl(el); setEditingId(el.id); } }}
                      onPointerDown={placementDrag ? e => onImagePointerDown(e, el) : undefined}
                      onPointerMove={placementDrag ? onImagePointerMove : undefined}
                      onPointerUp={placementDrag ? onImagePointerUp : undefined}
                      onPointerCancel={placementDrag ? onImagePointerUp : undefined}
                      style={{
                        position: 'absolute', pointerEvents: 'auto', cursor: imgCursor,
                        touchAction: placementDrag ? 'none' : undefined,
                        left: ob.x, top: ob.y, width: Math.max(ob.w, 2), height: Math.max(ob.h, 2),
                        border: `1px solid ${active ? bord : bord + '66'}`,
                        background: active ? bg : 'transparent',
                        boxSizing: 'border-box',
                        outline: hasEdit || imgEdited || imgUser ? '1.5px solid #F59E0B' : vidUser ? '1.5px solid #6366F1' : 'none',
                        outlineOffset: 1,
                      }}
                      onMouseEnter={e => { if (!active && !editingId) e.currentTarget.style.background = bg; }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══ RIGHT INSPECTOR ══ */}
      <div style={{ width: 312, minWidth: 312, background: '#ffffff', borderLeft: '1px solid #e8ecf0', overflow: 'auto', padding: '20px 16px 28px' }}>
        <input ref={addImageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleAddImageFile(f); e.target.value = ''; }} />
        <input ref={addVideoInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleAddVideoFile(f); e.target.value = ''; }} />
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8ecf0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>Page zoom</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min={25}
              max={150}
              step={1}
              value={Math.round(zoom * 100)}
              onChange={e => setZoom(Number(e.target.value) / 100)}
              aria-label="Page zoom"
              style={{ flex: 1, height: 6, accentColor: '#2AACB8', cursor: 'pointer', minWidth: 0 }}
            />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#334155', fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>{Math.round(zoom * 100)}%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, fontWeight: 600, color: '#94a3b8' }}>
            <span>25%</span>
            <span>150%</span>
          </div>
        </div>

        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8ecf0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Mode</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {OVERLAY_MODE_ICONS.map(([v, label, IconComp]) => {
              const active = v === 'off' ? !showOverlay : (showOverlay && overlay === v);
              return (
                <button
                  key={v}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => { if (v === 'off') { setShowOverlay(false); } else { setShowOverlay(true); setOverlay(v); } }}
                  style={{
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    border: `1px solid ${active ? '#2AACB8' : '#d1d9e0'}`,
                    background: active ? '#2AACB8' : '#f8fafc',
                    color: active ? '#fff' : '#475569',
                    cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  <IconComp />
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8ecf0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Add to page</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" title="Add image" aria-label="Add image" onClick={() => addImageInputRef.current?.click()}
              style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid #d1d9e0', background: '#f8fafc', color: '#334155', cursor: 'pointer' }}>
              <IconAddImage />
            </button>
            <button type="button" title="Add video" aria-label="Add video" onClick={() => addVideoInputRef.current?.click()}
              style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid #d1d9e0', background: '#f8fafc', color: '#4338ca', cursor: 'pointer' }}>
              <IconAddVideo />
            </button>
          </div>
          <p style={{ fontSize: 10, color: '#94a3b8', margin: '10px 0 0', lineHeight: 1.45 }}>Adds centered on the current page. Drag on the page to move. Drop files on the canvas to add or replace.</p>
        </div>

        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8ecf0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>Page</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              onClick={addPageAfterCurrent}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(42,172,184,0.35)',
                background: 'rgba(42,172,184,0.1)',
                color: '#0f766e',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <IconAddPage />
              Add page after current
            </button>
            <button
              type="button"
              onClick={() => deletePageAtIndex(selPage)}
              disabled={pages.length <= 1}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${pages.length <= 1 ? '#e2e8f0' : '#fecaca'}`,
                background: pages.length <= 1 ? '#f1f5f9' : '#fef2f2',
                color: pages.length <= 1 ? '#94a3b8' : '#b91c1c',
                fontSize: 12,
                fontWeight: 600,
                cursor: pages.length <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              <IconTrash />
              Delete page {pg?.pageNum ?? '—'}
            </button>
          </div>
          <p style={{ fontSize: 10, color: '#94a3b8', margin: '8px 0 0', lineHeight: 1.45 }}>Add inserts a blank page (same size as the current page) after the page you’re on. Delete removes the current page. Undo applies to both.</p>
        </div>

        {selEl ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <TypeBadge type={selEl.type} />
              <span style={{ fontSize: 12, color: '#888', fontWeight: 600 }}>Inspector</span>
              {((pageEdits[selEl.id] !== undefined && selEl.type === 'text') || (selEl.type === 'image' && (imageEdits[pg.pageNum]?.[selEl.id]?.src || imageEdits[pg.pageNum]?.[selEl.id]?.removed))) && (
                <span style={{ fontSize: 9, background: 'rgba(245,158,11,0.15)', color: '#F59E0B', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(245,158,11,0.3)' }}>EDITED</span>
              )}
              {(selEl.type === 'image' || selEl.type === 'video') && selEl._userAdded && (
                <span style={{ fontSize: 9, background: selEl.type === 'video' ? 'rgba(99,102,241,0.12)' : 'rgba(42,172,184,0.12)', color: selEl.type === 'video' ? '#4338ca' : '#0f766e', padding: '2px 6px', borderRadius: 4, border: selEl.type === 'video' ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(42,172,184,0.3)' }}>PLACED</span>
              )}
              <button onClick={() => setSelEl(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#444', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
            </div>

            {/* ── TEXT EDITING ── */}
            {selEl.type === 'text' && (
              <Section title="Edit Text">
                <textarea
                  value={pageEdits[selEl.id] ?? selEl.content}
                  onChange={e => setEdit(pg.pageNum, selEl.id, e.target.value)}
                  placeholder="Edit text content..."
                  style={{
                    width: '100%', minHeight: 72, background: '#ffffff', border: '1px solid #2AACB8',
                    borderRadius: 6, color: '#0f172a', fontSize: 12, padding: '8px 10px',
                    resize: 'vertical', fontFamily: selEl.style.fontFamily || 'inherit',
                    lineHeight: 1.5, outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={() => { setEdit(pg.pageNum, selEl.id, selEl.content, 'commit'); }} style={{ flex: 1, padding: '5px 0', background: '#e8ecf0', color: '#888', border: '1px solid #d1d9e0', borderRadius: 5, fontSize: 10, cursor: 'pointer' }}>
                    Reset
                  </button>
                  <button onClick={() => { setEditingId(selEl.id); }} style={{ flex: 1, padding: '5px 0', background: 'rgba(42,172,184,0.15)', color: '#2AACB8', border: '1px solid rgba(42,172,184,0.3)', borderRadius: 5, fontSize: 10, cursor: 'pointer' }}>
                    Edit on Page
                  </button>
                </div>
                {pageEdits[selEl.id] !== undefined && pageEdits[selEl.id] !== selEl.content && (
                  <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(245,158,11,0.08)', borderRadius: 5, border: '1px solid rgba(245,158,11,0.2)' }}>
                    <div style={{ fontSize: 9, color: '#F59E0B', marginBottom: 4 }}>ORIGINAL TEXT</div>
                    <div style={{ fontSize: 11, color: '#666', wordBreak: 'break-word' }}>{selEl.content}</div>
                  </div>
                )}
              </Section>
            )}

            {selEl.type === 'video' && (
              <Section title="Video">
                <p style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
                  Replace with another file or remove from the page. Drag a video file onto this frame to replace it. Preview plays muted in a loop.
                </p>
                <input type="file" accept="video/*" style={{ display: 'none' }} id={`vid-rep-${selEl.id}`} onChange={e => { const f = e.target.files?.[0]; if (f) handleReplaceVideo(selEl, f); e.target.value = ''; }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button type="button" onClick={() => document.getElementById(`vid-rep-${selEl.id}`)?.click()} style={{ width: '100%', padding: '8px 10px', background: '#e8ecf0', color: '#334155', border: '1px solid #d1d9e0', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                    Replace video…
                  </button>
                  <button type="button" onClick={() => handleRemoveVideo(selEl)} style={{ width: '100%', padding: '8px 10px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                    Remove from page
                  </button>
                </div>
              </Section>
            )}

            {selEl.type === 'image' && (
              <Section title="Image">
                <p style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
                  Replace with another file, crop the bitmap, or remove. Drag an image file from your computer onto this image on the page to replace it. PDF images are covered with the page background when removed.
                </p>
                <input type="file" accept="image/*" style={{ display: 'none' }} id={`img-rep-${selEl.id}`} onChange={e => { const f = e.target.files?.[0]; if (f) handleReplaceImage(selEl, f); e.target.value = ''; }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button type="button" onClick={() => document.getElementById(`img-rep-${selEl.id}`)?.click()} style={{ width: '100%', padding: '8px 10px', background: '#e8ecf0', color: '#334155', border: '1px solid #d1d9e0', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                    Replace image…
                  </button>
                  <button type="button" onClick={() => openCropForImage(selEl)} style={{ width: '100%', padding: '8px 10px', background: 'rgba(42,172,184,0.12)', color: '#0f766e', border: '1px solid rgba(42,172,184,0.35)', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                    Crop…
                  </button>
                  <button type="button" onClick={() => handleRemoveImage(selEl)} style={{ width: '100%', padding: '8px 10px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                    {selEl._userAdded ? 'Remove from page' : 'Remove (fill with background)'}
                  </button>
                </div>
              </Section>
            )}

            {/* Typography */}
            {selEl.style && (
              <Section title="Typography">
                <Row label="Font" value={selEl.style.fontFamily} />
                <Row label="Size" value={selEl.style.fontSize ? `${selEl.style.fontSize}pt` : null} mono />
                <Row label="Weight" value={selEl.style.fontWeight} />
                <Row label="Style" value={selEl.style.fontStyle} />
              </Section>
            )}

            {/* Shape colors */}
            {(selEl.fill || selEl.stroke) && (
              <Section title="Colors">
                {[['Fill', selEl.fill], ['Stroke', selEl.stroke]].filter(([, v]) => v).map(([lbl, col]) => (
                  <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 5, background: col, border: '1px solid rgba(0,0,0,0.12)', flexShrink: 0 }} />
                    <div><div style={{ fontSize: 9, color: '#64748b' }}>{lbl}</div><div style={{ fontSize: 11, color: '#334155', fontFamily: 'monospace' }}>{col.toUpperCase()}</div></div>
                  </div>
                ))}
              </Section>
            )}
          </>
        ) : (
          <>
            {/* Edits summary */}
            {totalEdits > 0 && (
              <Section title={`Edits · ${totalEdits}`}>
                {Object.entries(edits).map(([pn, pEdits]) =>
                  Object.entries(pEdits).map(([elId, newText]) => {
                    const pgData = pages.find(p => p.pageNum === +pn);
                    const origEl = pgData?.textElements.find(e => e.id === elId);
                    return (
                      <div key={elId} style={{ padding: '7px 8px', background: '#f4f6fa', borderRadius: 5, marginBottom: 5, border: '1px solid #d1d9e0', cursor: 'pointer' }}
                        onClick={() => { const idx = pages.indexOf(pgData); if (idx >= 0) { setSelPage(idx); setSelEl(origEl); setShowOverlay(true); setOverlay('text'); } }}>
                        <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3 }}>Page {pn}</div>
                        <div style={{ fontSize: 10, color: '#888', marginBottom: 2 }}>Was: <span style={{ color: '#555' }}>{origEl?.content?.slice(0, 30) || '…'}</span></div>
                        <div style={{ fontSize: 10, color: '#2AACB8' }}>Now: <span style={{ color: '#334155' }}>{newText.slice(0, 30)}</span></div>
                      </div>
                    );
                  })
                )}
                <button onClick={() => { captureBeforeChange(); setEdits({}); }} style={{ width: '100%', marginTop: 4, padding: '5px 0', background: 'transparent', color: '#555', border: '1px solid #d1d9e0', borderRadius: 5, fontSize: 10, cursor: 'pointer' }}>Clear All Edits</button>
              </Section>
            )}
          </>
        )}
      </div>

      {cropModal && (
        <ImageCropModal
          sourceUrl={cropModal.sourceUrl}
          onApply={url => cropModal.resolve(url)}
          onCancel={() => setCropModal(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
