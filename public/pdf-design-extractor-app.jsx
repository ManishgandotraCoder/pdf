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
  if (args.length >= 3) return toHex(args[0]*255, args[1]*255, args[2]*255);
  return null;
}
function isWhiteish(hex) {
  if (!hex) return true;
  const h = hex.replace('#','').toLowerCase();
  return h === 'ffffff' || h === 'fff' || h.includes('NaN');
}
function concatTransform(a, b) {
  return [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
  ];
}
function layoutSig(els, pw, ph) {
  if (!els.length) return '';
  return els.map(e => {
    const col = Math.round((e.x/pw)*10), row = Math.round((e.y/ph)*10);
    const w = Math.max(1,Math.round((e.w/pw)*10)), h = Math.max(1,Math.round((e.h/ph)*10));
    return `${e.type[0]}:${col},${row},${w},${h}`;
  }).sort().join('|');
}
function jaccard(a, b) {
  if (!a && !b) return 1; if (!a || !b) return 0;
  const sa = new Set(a.split('|')), sb = new Set(b.split('|'));
  const inter = [...sa].filter(x => sb.has(x)).length;
  return inter / new Set([...sa,...sb]).size;
}
function clusterTemplates(pds) {
  const cs = [];
  pds.forEach(pd => {
    let found = false;
    for (const c of cs) { if (jaccard(c.sig, pd.signature) >= 0.62) { c.pageNums.push(pd.pageNum); found=true; break; } }
    if (!found) cs.push({ id:`T${cs.length+1}`, sig:pd.signature, pageNums:[pd.pageNum] });
  });
  return cs;
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

  const gsStack = [{ fill:'#333333', stroke:'#000000', ctm:[1,0,0,1,0,0] }];
  const gs = () => gsStack[gsStack.length-1];
  const docColors = new Set();
  const shapes = [], images = [];
  let pendingRect = null;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) {
      gsStack.push({ ...gs(), ctm:[...gs().ctm] });
    } else if (fn === OPS.restore) {
      if (gsStack.length > 1) gsStack.pop();
    } else if (fn === OPS.transform && args) {
      gs().ctm = concatTransform(gs().ctm, args);
    } else if (fn === OPS.setFillRGBColor && args) {
      const h = argsToHex(args); if (h) { gs().fill=h; if(!isWhiteish(h)) docColors.add(h); }
    } else if (fn === OPS.setFillGray && args) {
      const h = argsToHex(args, true); if (h) gs().fill = h;
    } else if ((fn===OPS.setFillColor||fn===OPS.setFillColorN) && args?.length >= 3) {
      const h = argsToHex(args); if (h && !isWhiteish(h)) { gs().fill=h; docColors.add(h); }
    } else if (fn === OPS.setStrokeRGBColor && args) {
      const h = argsToHex(args); if (h) { gs().stroke=h; if(!isWhiteish(h)) docColors.add(h); }
    } else if (fn === OPS.setStrokeGray && args) {
      const h = argsToHex(args, true); if (h) gs().stroke = h;
    } else if ((fn===OPS.setStrokeColor||fn===OPS.setStrokeColorN) && args?.length >= 3) {
      const h = argsToHex(args); if (h && !isWhiteish(h)) { gs().stroke=h; docColors.add(h); }
    } else if (fn === OPS.rectangle && args) {
      const [rx,ry,rw,rh] = args;
      if (Math.abs(rw)>1 && Math.abs(rh)>1) {
        const [x1,y1] = pdfjsLib.Util.applyTransform([rx,ry], vp.transform);
        const [x2,y2] = pdfjsLib.Util.applyTransform([rx+rw,ry+rh], vp.transform);
        pendingRect = { x:Math.min(x1,x2), y:Math.min(y1,y2), w:Math.abs(x2-x1), h:Math.abs(y2-y1) };
      }
    } else if (fn===OPS.fill||fn===OPS.eoFill||fn===OPS.fillStroke||fn===OPS.eoFillStroke) {
      if (pendingRect?.w > 2 && pendingRect?.h > 2) {
        const fill = gs().fill;
        if (!isWhiteish(fill)) { shapes.push({ id:`s_${pageNum}_${shapes.length}`, type:'shape', ...pendingRect, fill, stroke:null }); docColors.add(fill); }
      }
      pendingRect = null;
    } else if (fn===OPS.stroke||fn===OPS.closeStroke) {
      if (pendingRect?.w > 0 && pendingRect?.h > 0) {
        const stroke = gs().stroke;
        if (!isWhiteish(stroke)) shapes.push({ id:`s_${pageNum}_${shapes.length}`, type:'shape', ...pendingRect, fill:null, stroke });
      }
      pendingRect = null;
    } else if (fn===OPS.paintImageXObject||fn===OPS.paintJpegXObject||fn===OPS.paintInlineImageXObject) {
      const m = gs().ctm;
      const pts = [[m[4],m[5]],[m[4]+m[0],m[5]+m[1]],[m[4]+m[2],m[5]+m[3]],[m[4]+m[0]+m[2],m[5]+m[1]+m[3]]];
      const xs = pts.map(p => pdfjsLib.Util.applyTransform(p, vp.transform)[0]);
      const ys = pts.map(p => pdfjsLib.Util.applyTransform(p, vp.transform)[1]);
      const iw = Math.max(...xs)-Math.min(...xs), ih = Math.max(...ys)-Math.min(...ys);
      if (iw>20 && ih>20) images.push({ id:`i_${pageNum}_${images.length}`, type:'image', x:Math.min(...xs), y:Math.min(...ys), w:iw, h:ih });
    }
  }

  const textElements = [];
  textContent.items.forEach((item, idx) => {
    if (!item.str?.trim()) return;
    const [sx,sy] = pdfjsLib.Util.applyTransform([item.transform[4], item.transform[5]], vp.transform);
    const fontSize = Math.sqrt(item.transform[0]**2 + item.transform[1]**2) * SCALE;
    const info = styles[item.fontName] || {};
    const raw = info.fontFamily || 'sans-serif';
    const fontFamily = raw.replace(/,.*$/,'').trim();
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
        fontWeight: /bold/i.test(raw)||/bold/i.test(item.fontName) ? 'bold':'normal',
        fontStyle:  /italic|oblique/i.test(raw)||/italic|oblique/i.test(item.fontName) ? 'italic':'normal',
      }
    });
  });

  const allEls = [...textElements, ...shapes, ...images].filter(e => e.x>=0&&e.y>=0&&e.x<W&&e.y<H);

  return {
    pageNum, width:W, height:H, fullUrl, thumbUrl, bgColor,
    textElements, shapes, images, allElements:allEls,
    docColors:[...docColors].filter(c=>!c.includes('NaN')),
    signature: layoutSig(allEls, W, H),
    templateId: null,
  };
}

// ─── Small Components ─────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ fontSize:9, color:'#3a3d48', letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, marginBottom:8, paddingBottom:5, borderBottom:'1px solid #1a1c23' }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value, mono }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
      <span style={{ fontSize:11, color:'#555' }}>{label}</span>
      <span style={{ fontSize:11, color:'#ccc', fontFamily:mono?'monospace':'inherit', maxWidth:145, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'right' }}>{value??'—'}</span>
    </div>
  );
}
function ColorPill({ color }) {
  const [copied, setCopied] = useState(false);
  return (
    <div onClick={() => { navigator.clipboard?.writeText(color).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),1200); }} title={`Copy ${color}`} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, cursor:'pointer' }}>
      <div style={{ width:28, height:28, borderRadius:7, background:color, border:'1px solid rgba(255,255,255,0.08)', transition:'transform 0.1s' }}
        onMouseEnter={e=>e.currentTarget.style.transform='scale(1.18)'}
        onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}
      />
      <span style={{ fontSize:8, color:copied?'#2AACB8':'#3a3d48', fontFamily:'monospace' }}>{copied?'✓':color.slice(1).toUpperCase()}</span>
    </div>
  );
}
function TypeBadge({ type }) {
  const map = { text:'#2AACB8', shape:'#8B5CF6', image:'#F59E0B' };
  return <span style={{ background:map[type]||'#555', color:'#fff', fontSize:9, padding:'2px 7px', borderRadius:4, fontWeight:700, textTransform:'uppercase', letterSpacing:0.5 }}>{type}</span>;
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────
function UploadZone({ onUpload }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef(null);
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', background:'#0f1117', gap:28 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="#2AACB8" fillOpacity="0.15"/>
          <path d="M8 8h10a6 6 0 0 1 0 12H8V8z" stroke="#2AACB8" strokeWidth="2" fill="none"/>
          <line x1="8" y1="14" x2="18" y2="14" stroke="#2AACB8" strokeWidth="1.5"/>
        </svg>
        <span style={{ fontSize:20, fontWeight:700, letterSpacing:'-0.5px' }}>PDF Design Extractor</span>
      </div>
      <p style={{ color:'#555', fontSize:13, maxWidth:360, textAlign:'center', lineHeight:1.7 }}>
        Upload any PDF to extract colors, fonts, shapes and layout templates — then edit the text directly
      </p>
      <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f?.type==='application/pdf')onUpload(f);}}
        onClick={()=>ref.current.click()}
        style={{ border:`2px dashed ${drag?'#2AACB8':'#252830'}`, borderRadius:14, padding:'52px 88px', cursor:'pointer', background:drag?'rgba(42,172,184,0.06)':'#13151c', textAlign:'center', transition:'all 0.2s' }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={drag?'#2AACB8':'#444'} strokeWidth="1.5" style={{ display:'block', margin:'0 auto 14px' }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p style={{ color:drag?'#2AACB8':'#888', fontSize:14, marginBottom:6 }}>Drop PDF or <span style={{color:'#2AACB8'}}>browse</span></p>
        <p style={{ color:'#3a3d48', fontSize:11 }}>Proposals, reports, brochures — any PDF</p>
      </div>
      <input ref={ref} type="file" accept=".pdf" style={{display:'none'}} onChange={e=>e.target.files[0]&&onUpload(e.target.files[0])}/>
    </div>
  );
}

function LoadingScreen({ progress, done, total }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', background:'#0f1117', gap:18 }}>
      <div style={{ fontSize:11, color:'#555', letterSpacing:1.5, textTransform:'uppercase' }}>Extracting Design Data</div>
      <div style={{ width:300, height:4, background:'#1a1c23', borderRadius:2 }}>
        <div style={{ width:`${progress}%`, height:'100%', background:'#2AACB8', borderRadius:2, transition:'width 0.3s' }}/>
      </div>
      <div style={{ fontSize:30, fontWeight:700, color:'#2AACB8', fontVariantNumeric:'tabular-nums' }}>{progress}%</div>
      <div style={{ fontSize:11, color:'#3a3d48' }}>Page {done} of {total}</div>
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
        top:  el.y - 1,
        width:  el.w + 8,
        minHeight: el.h + 4,
        fontSize: el.style.fontSizePx || el.h * 0.72,
        fontFamily: el.style.fontFamily || 'sans-serif',
        fontWeight: el.style.fontWeight,
        fontStyle:  el.style.fontStyle,
        background: bgColor || '#ffffff',
      }}
    />
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [pages, setPages]           = useState([]);
  const [fileName, setFileName]     = useState('');
  const [loading, setLoading]       = useState(false);
  const [progress, setProgress]     = useState(0);
  const [doneCount, setDoneCount]   = useState(0);
  const [totalPgs, setTotalPgs]     = useState(0);
  const [selPage, setSelPage]       = useState(0);
  const [selEl, setSelEl]           = useState(null);
  const [editingId, setEditingId]   = useState(null);  // id of element being inline-edited
  const [edits, setEdits]           = useState({});    // { [pageNum]: { [elId]: newText } }
  const [templates, setTemplates]   = useState([]);
  const [tokens, setTokens]         = useState({ colors:[], fonts:[], sizes:[] });
  const [overlay, setOverlay]       = useState('text');
  const [showOverlay, setShowOverlay] = useState(true);
  const [zoom, setZoom]             = useState(1);
  const canvasRef = useRef(null);

  // helper: get/set edits for a page
  const getEdit = (pageNum, elId) => edits[pageNum]?.[elId];
  const setEdit = (pageNum, elId, val) => setEdits(prev => ({
    ...prev,
    [pageNum]: { ...(prev[pageNum]||{}), [elId]: val }
  }));
  const clearEdit = (pageNum, elId) => setEdits(prev => {
    const pg = { ...(prev[pageNum]||{}) };
    delete pg[elId];
    return { ...prev, [pageNum]: pg };
  });
  const pageHasEdits = pn => Object.keys(edits[pn]||{}).length > 0;
  const totalEdits = Object.values(edits).reduce((s,pg)=>s+Object.keys(pg).length,0);

  // ── Upload ──
  const handleUpload = useCallback(async file => {
    setLoading(true); setProgress(0); setDoneCount(0);
    setFileName(file.name); setPages([]); setSelPage(0); setSelEl(null); setEdits({}); setEditingId(null);
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const n = pdf.numPages; setTotalPgs(n);
      const all = [];
      for (let i = 1; i <= n; i++) {
        const pg = await pdf.getPage(i);
        const data = await extractPage(pg, i);
        all.push(data);
        setDoneCount(i); setProgress(Math.round(i/n*100));
        setPages(p => [...p, data]);
      }
      const clusters = clusterTemplates(all);
      all.forEach(pd => { const c = clusters.find(cl=>cl.pageNums.includes(pd.pageNum)); if(c) pd.templateId=c.id; });
      setTemplates(clusters); setPages([...all]);
      const ac=new Set(), af=new Set(), as_=new Set();
      all.forEach(pd => {
        pd.docColors.forEach(c=>ac.add(c));
        pd.textElements.forEach(e=>{ if(e.style.fontFamily&&e.style.fontFamily!=='Unknown') af.add(e.style.fontFamily); if(e.style.fontSize>0) as_.add(e.style.fontSize); });
      });
      setTokens({ colors:[...ac].filter(c=>!c.includes('NaN')).slice(0,40), fonts:[...af].slice(0,12), sizes:[...as_].sort((a,b)=>a-b).slice(0,20) });
    } catch(err) { console.error(err); alert('Error: '+err.message); }
    setLoading(false);
  }, []);

  // ── Render page canvas ──
  useEffect(() => {
    const pg = pages[selPage];
    if (!pg || !canvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current; if (!c) return;
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = pg.fullUrl;
  }, [selPage, pages]);

  if (loading) return <LoadingScreen progress={progress} done={doneCount} total={totalPgs}/>;
  if (!pages.length) return <UploadZone onUpload={handleUpload}/>;

  const pg = pages[selPage];
  const tmpl = templates.find(t => t.id === pg?.templateId);
  const pageEdits = edits[pg?.pageNum] || {};

  // Which elements to show in overlay
  const overlayEls = pg ? [
    ...(overlay==='text'||overlay==='all' ? pg.textElements : []),
    ...(overlay==='shapes'||overlay==='all' ? pg.shapes : []),
    ...(overlay==='images'||overlay==='all' ? pg.images : []),
  ] : [];

  // Text elements that have been edited on this page
  const editedTexts = pg ? pg.textElements.filter(e => pageEdits[e.id] !== undefined) : [];

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'#0f1117' }}>

      {/* ══ LEFT SIDEBAR ══ */}
      <div style={{ width:188, minWidth:188, background:'#13151c', borderRight:'1px solid #1a1c23', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'13px 12px 11px', borderBottom:'1px solid #1a1c23' }}>
          <div style={{ fontSize:9, color:'#2AACB8', fontWeight:700, letterSpacing:1.3, textTransform:'uppercase', marginBottom:4 }}>Design Extractor</div>
          <div style={{ fontSize:11, color:'#666', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }} title={fileName}>{fileName}</div>
          <div style={{ display:'flex', gap:8, marginTop:4 }}>
            <span style={{ fontSize:10, color:'#3a3d48' }}>{pages.length} pages</span>
            <span style={{ fontSize:10, color:'#3a3d48' }}>·</span>
            <span style={{ fontSize:10, color:'#3a3d48' }}>{templates.length} layouts</span>
            {totalEdits > 0 && <span style={{ fontSize:10, color:'#F59E0B' }}>· {totalEdits} edit{totalEdits>1?'s':''}</span>}
          </div>
        </div>

        {templates.length > 0 && (
          <div style={{ padding:'9px 10px 7px', borderBottom:'1px solid #1a1c23', flexShrink:0 }}>
            <div style={{ fontSize:9, color:'#3a3d48', letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, marginBottom:7 }}>Layouts</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
              {templates.map(t => (
                <div key={t.id} onClick={() => { const f=pages.find(p=>p.templateId===t.id); if(f){setSelPage(pages.indexOf(f));setSelEl(null);setEditingId(null);} }}
                  style={{ padding:'3px 9px', borderRadius:12, fontSize:10, cursor:'pointer', background:tmpl?.id===t.id?'rgba(42,172,184,0.2)':'#1a1c23', color:tmpl?.id===t.id?'#2AACB8':'#666', border:`1px solid ${tmpl?.id===t.id?'rgba(42,172,184,0.4)':'#1e2028'}`, transition:'all 0.15s' }}>
                  {t.id} <span style={{opacity:0.6}}>·{t.pageNums.length}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ flex:1, overflowY:'auto', padding:'8px 8px 16px' }}>
          <div style={{ fontSize:9, color:'#3a3d48', letterSpacing:1.5, textTransform:'uppercase', fontWeight:700, padding:'5px 2px 7px' }}>Pages</div>
          {pages.map((p, idx) => (
            <div key={idx} onClick={() => { setSelPage(idx); setSelEl(null); setEditingId(null); }}
              style={{ marginBottom:8, cursor:'pointer', borderRadius:6, overflow:'hidden', border:`2px solid ${idx===selPage?'#2AACB8':'transparent'}`, position:'relative', transition:'border-color 0.15s' }}>
              <img src={p.thumbUrl} style={{ width:'100%', display:'block' }} alt={`p${p.pageNum}`}/>
              <div style={{ position:'absolute', bottom:4, right:4, background:'rgba(0,0,0,0.75)', color:'#fff', fontSize:9, padding:'1px 5px', borderRadius:3, fontWeight:600 }}>{p.pageNum}</div>
              {p.templateId && <div style={{ position:'absolute', top:4, left:4, background:'rgba(42,172,184,0.88)', color:'#fff', fontSize:8, padding:'1px 5px', borderRadius:3, fontWeight:700 }}>{p.templateId}</div>}
              {pageHasEdits(p.pageNum) && <div style={{ position:'absolute', top:4, right:4, background:'#F59E0B', width:8, height:8, borderRadius:'50%' }}/>}
            </div>
          ))}
        </div>
      </div>

      {/* ══ CENTER ══ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {/* Toolbar */}
        <div style={{ height:46, background:'#13151c', borderBottom:'1px solid #1a1c23', display:'flex', alignItems:'center', padding:'0 12px', gap:7, flexShrink:0 }}>
          <span style={{ fontSize:11, color:'#555' }}>Page {pg?.pageNum}/{pages.length}</span>
          {tmpl && <span style={{ fontSize:10, background:'rgba(42,172,184,0.12)', color:'#2AACB8', padding:'2px 7px', borderRadius:10, border:'1px solid rgba(42,172,184,0.25)' }}>Layout {tmpl.id}</span>}
          {totalEdits > 0 && <span style={{ fontSize:10, background:'rgba(245,158,11,0.15)', color:'#F59E0B', padding:'2px 7px', borderRadius:10, border:'1px solid rgba(245,158,11,0.3)' }}>{totalEdits} edit{totalEdits>1?'s':''}</span>}

          <div style={{ flex:1 }}/>

          {/* Hint */}
          <span style={{ fontSize:10, color:'#3a3d48', fontStyle:'italic' }}>Double-click text to edit</span>
          <div style={{ width:1, height:18, background:'#1e2028' }}/>

          {/* Overlay */}
          <span style={{ fontSize:10, color:'#3a3d48' }}>Show</span>
          {[['off','None'],['text','Text'],['shapes','Shapes'],['images','Images'],['all','All']].map(([v,l]) => (
            <button key={v} onClick={() => { if(v==='off'){setShowOverlay(false);}else{setShowOverlay(true);setOverlay(v);} }} style={{ padding:'3px 8px', borderRadius:4, fontSize:10, cursor:'pointer', border:'none', background:(v==='off'?!showOverlay:(showOverlay&&overlay===v))?'#2AACB8':'#1a1c23', color:(v==='off'?!showOverlay:(showOverlay&&overlay===v))?'#fff':'#555', transition:'all 0.15s' }}>{l}</button>
          ))}

          <div style={{ width:1, height:18, background:'#1e2028' }}/>
          {[0.5,0.75,1,1.25].map(z => (
            <button key={z} onClick={() => setZoom(z)} style={{ padding:'3px 7px', borderRadius:4, fontSize:10, cursor:'pointer', border:'none', background:zoom===z?'#1e2028':'transparent', color:zoom===z?'#ccc':'#444' }}>{z===1?'100%':z*100+'%'}</button>
          ))}

          <div style={{ width:1, height:18, background:'#1e2028' }}/>
          <button onClick={() => {
            const blob = new Blob([JSON.stringify({ fileName, pages:pages.map(p=>({ pageNum:p.pageNum, bgColor:p.bgColor, templateId:p.templateId, textElements:p.textElements, shapes:p.shapes, images:p.images, docColors:p.docColors, edits:edits[p.pageNum]||{} })), templates, designTokens:tokens, allEdits:edits }, null, 2)], {type:'application/json'});
            const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=fileName.replace(/\.pdf$/i,'')+'-design.json'; a.click();
          }} style={{ padding:'5px 12px', background:'#2AACB8', color:'#fff', border:'none', borderRadius:5, fontSize:11, cursor:'pointer', fontWeight:600 }}>Export JSON</button>
          <button onClick={()=>{setPages([]);setTemplates([]);setTokens({colors:[],fonts:[],sizes:[]});setEdits({});}} style={{ padding:'5px 9px', background:'#1a1c23', color:'#666', border:'1px solid #1e2028', borderRadius:5, fontSize:11, cursor:'pointer' }}>New</button>
        </div>

        {/* Page canvas + overlays */}
        <div style={{ flex:1, overflow:'auto', padding:20, display:'flex', justifyContent:'center', alignItems:'flex-start' }}
          onClick={() => { if (!editingId) setSelEl(null); }}>
          <div style={{ position:'relative', display:'inline-block', boxShadow:'0 10px 44px rgba(0,0,0,0.55)', transform:`scale(${zoom})`, transformOrigin:'top center' }}>
            <canvas ref={canvasRef} style={{ display:'block' }}/>

            {/* ── Edited text overlays (cover original, always shown) ── */}
            {editedTexts.map(el => {
              const newText = pageEdits[el.id];
              if (newText === undefined || editingId === el.id) return null;
              return (
                <div key={el.id} className="edited-overlay" style={{
                  left: el.x - 2, top: el.y - 1,
                  width: el.w + 12, minHeight: el.h + 4,
                  background: pg.bgColor || '#ffffff',
                  fontSize: el.style.fontSizePx || el.h*0.72,
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
                  onSave={val => { setEdit(pg.pageNum, el.id, val); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              );
            })()}

            {/* ── Element overlay boxes ── */}
            {showOverlay && pg && (
              <div style={{ position:'absolute', top:0, left:0, width:pg.width, height:pg.height, pointerEvents:'none' }}>
                {overlayEls.map((el, idx) => {
                  const bord = el.type==='text'?'#2AACB8':el.type==='image'?'#F59E0B':'#8B5CF6';
                  const bg   = el.type==='text'?'rgba(42,172,184,0.1)':el.type==='image'?'rgba(245,158,11,0.1)':'rgba(139,92,246,0.1)';
                  const active = selEl?.id === el.id;
                  const hasEdit = el.type==='text' && pageEdits[el.id] !== undefined;
                  return (
                    <div key={el.id||idx}
                      onClick={e => { e.stopPropagation(); if(editingId) return; setSelEl(active?null:el); }}
                      onDoubleClick={e => { e.stopPropagation(); if(el.type==='text') { setSelEl(el); setEditingId(el.id); } }}
                      style={{
                        position:'absolute', pointerEvents:'auto', cursor: el.type==='text'?'text':'pointer',
                        left:el.x, top:el.y, width:Math.max(el.w,2), height:Math.max(el.h,2),
                        border:`1px solid ${active?bord:bord+'66'}`,
                        background: active ? bg : 'transparent',
                        boxSizing:'border-box',
                        outline: hasEdit ? '1.5px solid #F59E0B' : 'none',
                        outlineOffset: 1,
                      }}
                      onMouseEnter={e=>{ if(!active&&!editingId) e.currentTarget.style.background=bg; }}
                      onMouseLeave={e=>{ if(!active) e.currentTarget.style.background='transparent'; }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══ RIGHT INSPECTOR ══ */}
      <div style={{ width:270, minWidth:270, background:'#13151c', borderLeft:'1px solid #1a1c23', overflow:'auto', padding:'14px 13px 24px' }}>
        {selEl ? (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16 }}>
              <TypeBadge type={selEl.type}/>
              <span style={{ fontSize:12, color:'#888', fontWeight:600 }}>Inspector</span>
              {pageEdits[selEl.id] !== undefined && <span style={{ fontSize:9, background:'rgba(245,158,11,0.15)', color:'#F59E0B', padding:'2px 6px', borderRadius:4, border:'1px solid rgba(245,158,11,0.3)' }}>EDITED</span>}
              <button onClick={()=>setSelEl(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'#444', cursor:'pointer', fontSize:20, lineHeight:1 }}>×</button>
            </div>

            {/* ── TEXT EDITING ── */}
            {selEl.type === 'text' && (
              <Section title="Edit Text">
                <textarea
                  value={pageEdits[selEl.id] ?? selEl.content}
                  onChange={e => setEdit(pg.pageNum, selEl.id, e.target.value)}
                  placeholder="Edit text content..."
                  style={{
                    width:'100%', minHeight:72, background:'#0f1117', border:'1px solid #2AACB8',
                    borderRadius:6, color:'#fff', fontSize:12, padding:'8px 10px',
                    resize:'vertical', fontFamily: selEl.style.fontFamily || 'inherit',
                    lineHeight:1.5, outline:'none',
                  }}
                />
                <div style={{ display:'flex', gap:6, marginTop:8 }}>
                  <button onClick={() => { setEdit(pg.pageNum, selEl.id, selEl.content); }} style={{ flex:1, padding:'5px 0', background:'#1a1c23', color:'#888', border:'1px solid #1e2028', borderRadius:5, fontSize:10, cursor:'pointer' }}>
                    Reset
                  </button>
                  <button onClick={() => { setEditingId(selEl.id); }} style={{ flex:1, padding:'5px 0', background:'rgba(42,172,184,0.15)', color:'#2AACB8', border:'1px solid rgba(42,172,184,0.3)', borderRadius:5, fontSize:10, cursor:'pointer' }}>
                    Edit on Page
                  </button>
                </div>
                {pageEdits[selEl.id] !== undefined && pageEdits[selEl.id] !== selEl.content && (
                  <div style={{ marginTop:8, padding:'6px 8px', background:'rgba(245,158,11,0.08)', borderRadius:5, border:'1px solid rgba(245,158,11,0.2)' }}>
                    <div style={{ fontSize:9, color:'#F59E0B', marginBottom:4 }}>ORIGINAL TEXT</div>
                    <div style={{ fontSize:11, color:'#666', wordBreak:'break-word' }}>{selEl.content}</div>
                  </div>
                )}
              </Section>
            )}

            {/* Position */}
            <Section title="Position & Size">
              <Row label="X" value={`${Math.round(selEl.x)}px`} mono/>
              <Row label="Y" value={`${Math.round(selEl.y)}px`} mono/>
              <Row label="Width" value={`${Math.round(selEl.w)}px`} mono/>
              <Row label="Height" value={`${Math.round(selEl.h)}px`} mono/>
            </Section>

            {/* Typography */}
            {selEl.style && (
              <Section title="Typography">
                <Row label="Font" value={selEl.style.fontFamily}/>
                <Row label="Size" value={selEl.style.fontSize?`${selEl.style.fontSize}pt`:null} mono/>
                <Row label="Weight" value={selEl.style.fontWeight}/>
                <Row label="Style" value={selEl.style.fontStyle}/>
              </Section>
            )}

            {/* Shape colors */}
            {(selEl.fill || selEl.stroke) && (
              <Section title="Colors">
                {[['Fill',selEl.fill],['Stroke',selEl.stroke]].filter(([,v])=>v).map(([lbl,col])=>(
                  <div key={lbl} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                    <div style={{ width:22, height:22, borderRadius:5, background:col, border:'1px solid rgba(255,255,255,0.1)', flexShrink:0 }}/>
                    <div><div style={{ fontSize:9, color:'#3a3d48' }}>{lbl}</div><div style={{ fontSize:11, color:'#ccc', fontFamily:'monospace' }}>{col.toUpperCase()}</div></div>
                  </div>
                ))}
              </Section>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize:12, color:'#888', fontWeight:700, marginBottom:16 }}>Design Tokens</div>

            {/* Page info */}
            <Section title="Page Info">
              <Row label="Layout" value={pg?.templateId||'Unique'}/>
              <Row label="Size" value={pg?`${Math.round(pg.width/1.5)} × ${Math.round(pg.height/1.5)}`:null} mono/>
              <Row label="Text blocks" value={pg?.textElements.length}/>
              <Row label="Shapes" value={pg?.shapes.length}/>
              <Row label="Images" value={pg?.images.length}/>
              <Row label="Edits this page" value={Object.keys(pageEdits).length||'None'}/>
              {pg?.bgColor && (
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
                  <div style={{ width:20, height:20, borderRadius:4, background:pg.bgColor, border:'1px solid rgba(255,255,255,0.1)', flexShrink:0 }}/>
                  <div><div style={{ fontSize:9, color:'#3a3d48' }}>Background</div><div style={{ fontSize:11, color:'#888', fontFamily:'monospace' }}>{pg.bgColor.toUpperCase()}</div></div>
                </div>
              )}
            </Section>

            {/* Edits summary */}
            {totalEdits > 0 && (
              <Section title={`Edits · ${totalEdits}`}>
                {Object.entries(edits).map(([pn, pEdits]) =>
                  Object.entries(pEdits).map(([elId, newText]) => {
                    const pgData = pages.find(p=>p.pageNum===+pn);
                    const origEl = pgData?.textElements.find(e=>e.id===elId);
                    return (
                      <div key={elId} style={{ padding:'7px 8px', background:'#0f1117', borderRadius:5, marginBottom:5, border:'1px solid #1e2028', cursor:'pointer' }}
                        onClick={() => { const idx=pages.indexOf(pgData); if(idx>=0){setSelPage(idx);setSelEl(origEl);setShowOverlay(true);setOverlay('text');} }}>
                        <div style={{ fontSize:9, color:'#3a3d48', marginBottom:3 }}>Page {pn}</div>
                        <div style={{ fontSize:10, color:'#888', marginBottom:2 }}>Was: <span style={{color:'#555'}}>{origEl?.content?.slice(0,30)||'…'}</span></div>
                        <div style={{ fontSize:10, color:'#2AACB8' }}>Now: <span style={{color:'#ccc'}}>{newText.slice(0,30)}</span></div>
                      </div>
                    );
                  })
                )}
                <button onClick={()=>setEdits({})} style={{ width:'100%', marginTop:4, padding:'5px 0', background:'transparent', color:'#555', border:'1px solid #1e2028', borderRadius:5, fontSize:10, cursor:'pointer' }}>Clear All Edits</button>
              </Section>
            )}

            {/* Colors */}
            {tokens.colors.length > 0 && (
              <Section title={`Colors · ${tokens.colors.length}`}>
                <div style={{ display:'flex', flexWrap:'wrap', gap:7 }}>
                  {tokens.colors.map((c,i)=><ColorPill key={i} color={c}/>)}
                </div>
                <p style={{ fontSize:10, color:'#3a3d48', marginTop:8 }}>Click swatch to copy hex</p>
              </Section>
            )}

            {/* Page colors */}
            {pg?.docColors.length > 0 && (
              <Section title={`This Page · ${pg.docColors.length}`}>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {pg.docColors.map((c,i)=><ColorPill key={i} color={c}/>)}
                </div>
              </Section>
            )}

            {/* Fonts */}
            {tokens.fonts.length > 0 && (
              <Section title={`Fonts · ${tokens.fonts.length}`}>
                {tokens.fonts.map((f,i)=>(
                  <div key={i} style={{ padding:'7px 0', borderBottom:'1px solid #1a1c23' }}>
                    <div style={{ fontSize:13, color:'#ccc', fontFamily:f, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f}</div>
                    <div style={{ fontSize:10, color:'#3a3d48', marginTop:2 }}>Aa Bb 1234</div>
                  </div>
                ))}
              </Section>
            )}

            {/* Type scale */}
            {tokens.sizes.length > 0 && (
              <Section title="Type Scale">
                <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                  {tokens.sizes.map((s,i)=><span key={i} style={{ background:'#0f1117', padding:'3px 7px', borderRadius:4, fontSize:10, color:'#666', fontFamily:'monospace', border:'1px solid #1a1c23' }}>{s}pt</span>)}
                </div>
              </Section>
            )}

            {/* Layouts */}
            {templates.length > 0 && (
              <Section title="Layouts">
                {templates.map(t=>(
                  <div key={t.id} style={{ padding:'7px 9px', background:'#0f1117', borderRadius:5, marginBottom:5, border:'1px solid #1a1c23' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span style={{ fontSize:11, color:'#2AACB8', fontWeight:600 }}>Layout {t.id}</span>
                      <span style={{ fontSize:10, color:'#555' }}>{t.pageNums.length} pages</span>
                    </div>
                    <div style={{ fontSize:10, color:'#3a3d48' }}>Pages: {t.pageNums.slice(0,8).join(', ')}{t.pageNums.length>8?'…':''}</div>
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
