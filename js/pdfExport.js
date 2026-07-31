/* pdfExport.js - 纯前端简历导出（挂载到 window.App.pdfExport）
 * 零依赖：Canvas 绘制 → JPEG → 按 PDF 规范 /DCTDecode 拼装多页 PDF。
 * 同时支持导出长图 PNG。无任何 npm 依赖、不请求服务端。 */
(function () {
  window.App = window.App || {};
  const W = 794;        // A4 宽 @96dpi (css px)
  const SCALE = 2;      // 内部分辨率倍率
  const PAGE_CSS_H = 1123; // A4 高 @96dpi (css px)
  const PX_TO_PT = 0.75;   // css px -> point (72/96)

  function wrap(ctx, text, maxW) {
    const out = []; let line = '';
    for (const ch of (text || '')) {
      if (ch === '\n') { out.push(line); line = ''; continue; }
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = ch; }
      else line = test;
    }
    if (line) out.push(line);
    return out;
  }

  function drawResume(resume) {
    const tmp = document.createElement('canvas');
    tmp.width = W * SCALE; tmp.height = 4000 * SCALE;
    const ctx = tmp.getContext('2d');
    ctx.scale(SCALE, SCALE);
    const pad = 48; let y = pad;
    const maxW = W - pad * 2;

    function section(title) {
      y += 14; ctx.fillStyle = '#2563eb'; ctx.font = 'bold 16px sans-serif';
      ctx.fillText(title, pad, y); y += 6;
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); y += 16;
    }
    function line(t, color, size, bold) {
      ctx.fillStyle = color || '#1e293b'; ctx.font = (bold ? 'bold ' : '') + (size || 13) + 'px sans-serif';
      wrap(ctx, t, maxW).forEach(l => { ctx.fillText(l, pad, y); y += (size || 13) + 8; });
    }
    function block(title, sub, period, body) {
      ctx.fillStyle = '#0f172a'; ctx.font = 'bold 14px sans-serif';
      ctx.fillText(title || '', pad, y);
      if (period) { ctx.fillStyle = '#94a3b8'; ctx.font = '12px sans-serif'; const pw = ctx.measureText(period).width; ctx.fillText(period, W - pad - pw, y); }
      y += 20;
      if (sub) { ctx.fillStyle = '#475569'; ctx.font = '13px sans-serif'; ctx.fillText(sub, pad, y); y += 19; }
      if (body) line(body, '#334155', 13, false);
      y += 6;
    }

    const b = resume.basic || {};
    ctx.fillStyle = '#0f172a'; ctx.font = 'bold 24px sans-serif';
    ctx.fillText(b.name || resume.name || '简历', pad, y + 18); y += 40;
    const contact = [b.phone, b.email, b.target].filter(Boolean).join('   |   ');
    if (contact) line(contact, '#475569', 13, false);
    if (b.target) { section('求职意向'); line(b.target, '#334155', 13); }
    if (resume.education && resume.education.length) {
      section('教育经历');
      resume.education.forEach(e => block(e.school, [e.major, e.degree].filter(Boolean).join(' · '), e.period, ''));
    }
    const exps = (resume.tailored && resume.tailored.experiences) || resume.experiences || [];
    if (exps.length) {
      section('工作经历');
      exps.forEach(e => block(e.role || e.company, [e.company, e.period].filter(Boolean).join('   '), '', e.description));
    }
    if (resume.projects && resume.projects.length) {
      section('项目经历');
      resume.projects.forEach(p => block(p.name, [p.role, p.period].filter(Boolean).join('   '), '', p.description));
    }
    if (resume.skills) { section('技能特长'); line(resume.skills, '#334155', 13); }
    const sum = (resume.tailored && resume.tailored.summary) || resume.summary;
    if (sum) { section('自我评价'); line(sum, '#334155', 13); }

    const finalY = y;
    const h = Math.max(600, finalY + pad);
    const out = document.createElement('canvas');
    out.width = W * SCALE; out.height = h * SCALE;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff'; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(tmp, 0, 0, out.width, out.height);
    return out;
  }

  function sliceJpeg(canvas, idx, cssH) {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = cssH * SCALE;
    const t = tmp.getContext('2d');
    t.fillStyle = '#fff'; t.fillRect(0, 0, tmp.width, tmp.height);
    t.drawImage(canvas, 0, idx * PAGE_CSS_H * SCALE, canvas.width, cssH * SCALE, 0, 0, canvas.width, cssH * SCALE);
    return tmp.toDataURL('image/jpeg', 0.92);
  }

  function dataUrlToBytes(url) {
    const b = atob(url.split(',')[1]);
    const a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }

  function buildPdf(canvas) {
    const ptW = 595; // A4 宽(pt)
    const totalCssH = canvas.height / SCALE;
    const pages = [];
    for (let y = 0; y < totalCssH; y += PAGE_CSS_H) {
      const cssH = Math.min(PAGE_CSS_H, totalCssH - y);
      pages.push({ jpeg: sliceJpeg(canvas, y / PAGE_CSS_H, cssH), cssH });
    }
    const chunks = []; let len = 0; const offsets = [];
    function pushStr(s) { chunks.push(s); len += s.length; }
    function pushBytes(b) { chunks.push(b); len += b.length; }

    pushStr('%PDF-1.4\n');
    offsets.push(len); pushStr('1 0 obj<< /Type /Catalog /Pages 2 0 R >>\n');
    const pnums = []; let n = 3;
    pages.forEach(p => { const pageNum = n++; const contentNum = n++; const imgNum = n++; pnums.push({ pageNum, contentNum, imgNum, cssH: p.cssH }); });
    const kids = pnums.map(p => p.pageNum + ' 0 R').join(' ');
    offsets.push(len); pushStr('2 0 obj<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>\n');
    pnums.forEach((p, i) => {
      const hPt = (p.cssH * PX_TO_PT).toFixed(2);
      const jbytes = dataUrlToBytes(pages[i].jpeg);
      offsets.push(len); pushStr(p.pageNum + ' 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + ptW + ' ' + hPt + '] /Resources << /XObject << /Im0 ' + p.imgNum + ' 0 R >> >> /Contents ' + p.contentNum + ' 0 R >>\n');
      const content = 'q ' + ptW + ' 0 0 ' + hPt + ' 0 0 cm /Im0 Do Q';
      offsets.push(len); pushStr(p.contentNum + ' 0 obj<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\n');
      const imgHead = p.imgNum + ' 0 obj<< /Type /XObject /Subtype /Image /Width ' + (W * SCALE) + ' /Height ' + Math.round(p.cssH * SCALE) + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jbytes.length + ' >>\nstream\n';
      offsets.push(len); pushStr(imgHead); pushBytes(jbytes); pushStr('\nendstream\n');
    });
    const xrefPos = len;
    let xref = 'xref\n0 ' + n + '\n0000000000 65535 f \n';
    offsets.forEach(o => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    pushStr(xref);
    pushStr('trailer\n<< /Size ' + n + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');

    let total = 0; chunks.forEach(c => total += (c instanceof Uint8Array ? c.length : c.length));
    const out = new Uint8Array(total); let off = 0;
    chunks.forEach(c => {
      if (c instanceof Uint8Array) { out.set(c, off); off += c.length; }
      else { for (let i = 0; i < c.length; i++) out[off++] = c.charCodeAt(i) & 0xff; }
    });
    return new Blob([out], { type: 'application/pdf' });
  }

  /* 每页一张画布 → 多页 PDF（页面尺寸跟随各画布宽高比，供"原版式重写"使用）。
   * 画布已是渲染倍率后的位图（RENDER_SCALE=2），按 canvas.width/2*0.75 换算回 pt。 */
  function buildPdfFromPages(canvases, renderScale) {
    const RS = renderScale || 2;
    const chunks = []; let len = 0; const offsets = [];
    function pushStr(s) { chunks.push(s); len += s.length; }
    function pushBytes(b) { chunks.push(b); len += b.length; }

    pushStr('%PDF-1.4\n');
    offsets.push(len); pushStr('1 0 obj<< /Type /Catalog /Pages 2 0 R >>\n');
    const pnums = []; let n = 3;
    canvases.forEach(() => { const pageNum = n++; const contentNum = n++; const imgNum = n++; pnums.push({ pageNum, contentNum, imgNum }); });
    const kids = pnums.map(p => p.pageNum + ' 0 R').join(' ');
    offsets.push(len); pushStr('2 0 obj<< /Type /Pages /Kids [' + kids + '] /Count ' + canvases.length + ' >>\n');
    pnums.forEach((p, i) => {
      const c = canvases[i];
      const wPt = (c.width / RS * PX_TO_PT).toFixed(2);
      const hPt = (c.height / RS * PX_TO_PT).toFixed(2);
      const jbytes = dataUrlToBytes(c.toDataURL('image/jpeg', 0.92));
      offsets.push(len); pushStr(p.pageNum + ' 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wPt + ' ' + hPt + '] /Resources << /XObject << /Im0 ' + p.imgNum + ' 0 R >> >> /Contents ' + p.contentNum + ' 0 R >>\n');
      const content = 'q ' + wPt + ' 0 0 ' + hPt + ' 0 0 cm /Im0 Do Q';
      offsets.push(len); pushStr(p.contentNum + ' 0 obj<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\n');
      const imgHead = p.imgNum + ' 0 obj<< /Type /XObject /Subtype /Image /Width ' + c.width + ' /Height ' + c.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jbytes.length + ' >>\nstream\n';
      offsets.push(len); pushStr(imgHead); pushBytes(jbytes); pushStr('\nendstream\n');
    });
    const xrefPos = len;
    let xref = 'xref\n0 ' + n + '\n0000000000 65535 f \n';
    offsets.forEach(o => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    pushStr(xref);
    pushStr('trailer\n<< /Size ' + n + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');

    let total = 0; chunks.forEach(c => total += c.length);
    const out = new Uint8Array(total); let off = 0;
    chunks.forEach(c => {
      if (c instanceof Uint8Array) { out.set(c, off); off += c.length; }
      else { for (let i = 0; i < c.length; i++) out[off++] = c.charCodeAt(i) & 0xff; }
    });
    return new Blob([out], { type: 'application/pdf' });
  }

  /* 按原始文本逐行绘制：保留原文的行序、空行、缩进，不套模板样式。
   * 仅在单行超宽时折行（续行沿用原行缩进）。 */
  function drawRawText(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const tmp = document.createElement('canvas');
    tmp.width = W * SCALE; tmp.height = 16000 * SCALE;
    const ctx = tmp.getContext('2d');
    ctx.scale(SCALE, SCALE);
    const pad = 48, size = 13, lh = size + 8;
    const maxW = W - pad * 2;
    ctx.fillStyle = '#1e293b'; ctx.font = size + 'px sans-serif';
    ctx.textBaseline = 'alphabetic';
    let y = pad + size;
    for (const raw of lines) {
      if (!raw.trim()) { y += lh; continue; }                 // 空行原样保留
      const indent = (raw.match(/^[ \t\u3000]*/) || [''])[0];
      const indentW = ctx.measureText(indent.replace(/\t/g, '    ')).width;
      const body = raw.slice(indent.length);
      const wrapped = wrap(ctx, body, maxW - indentW);
      for (const l of wrapped) { ctx.fillText(l, pad + indentW, y); y += lh; }
      if (!wrapped.length) y += lh;
    }
    const h = Math.max(600, y - size + pad);
    const out = document.createElement('canvas');
    out.width = W * SCALE; out.height = h * SCALE;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff'; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(tmp, 0, 0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  /* 原文文本 → PDF（保持原格式），返回 Blob 并触发下载 */
  function exportTextPdf(text, filename) {
    const canvas = drawRawText(text);
    const blob = buildPdf(canvas);
    App.util.download(blob, filename || '简历.pdf');
    return blob;
  }

  function exportPdf(resume, filename) {
    const canvas = drawResume(resume);
    const blob = buildPdf(canvas);
    App.util.download(blob, filename || ((resume.name || '简历') + '.pdf'));
    return blob;
  }
  function exportPng(resume, filename) {
    const canvas = drawResume(resume);
    canvas.toBlob(b => App.util.download(b, filename || ((resume.name || '简历') + '.png')), 'image/png');
  }

  App.pdfExport = { drawResume, drawRawText, exportPdf, exportTextPdf, exportPng, buildPdf, buildPdfFromPages };
})();
