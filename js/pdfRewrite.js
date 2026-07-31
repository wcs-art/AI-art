/* pdfRewrite.js - 保留原版式的 PDF 内容替换引擎（挂载到 window.App.pdfRewrite）
 *
 * 原理（用户核心诉求：格式不变，只改岗位对应的职责/内容）：
 *   ① 用 pdf.js 把原 PDF 每一页【原样】渲染成高清位图 —— 字体/颜色/版式/图标 100% 保留
 *   ② 用 pdf.js 的文字坐标定位到"被优化的那几段文字"的矩形区域
 *   ③ 只在该区域内：取样背景色盖掉旧文字 → 按区域自动适配字号写入新文字（取样原文字颜色）
 *   ④ 把改好的页面位图拼装回一个多页 PDF（复用 pdfExport.buildPdfFromPages，零额外依赖）
 *
 * 页面上没被优化命中的所有内容，一个像素都不会变。
 * 依赖：window.pdfjsLib（index.html CDN 多镜像加载）；无 pdf.js 时抛错由调用方回退文本版。
 */
(function () {
  window.App = window.App || {};

  const RENDER_SCALE = 2;          // 渲染倍率（清晰度）
  const norm = s => String(s || '').replace(/\s+/g, '');

  function waitPdfjs(waitMs) {
    return new Promise(function (resolve) {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      if (window.__pdfjsFailed) return resolve(null);
      let waited = 0;
      const timer = setInterval(function () {
        waited += 200;
        if (window.pdfjsLib || window.__pdfjsFailed || waited >= waitMs) {
          clearInterval(timer); resolve(window.pdfjsLib || null);
        }
      }, 200);
    });
  }

  /* ---------- 行分组（视口坐标，y 向下） ---------- */
  function groupLines(frags) {
    const fs = frags.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const f of fs) {
      const tol = Math.max(3, f.h * 0.45);
      let line = lines.length ? lines[lines.length - 1] : null;
      if (!line || Math.abs(line.y - f.y) > tol) { line = { y: f.y, frags: [] }; lines.push(line); }
      line.frags.push(f);
    }
    for (const ln of lines) {
      ln.frags.sort((a, b) => a.x - b.x);
      ln.text = ln.frags.map(f => f.str).join('');
      ln.h = ln.frags.reduce((m, f) => Math.max(m, f.h), 0);
    }
    return lines;
  }

  /* ---------- 在行序列中定位 original 文本，返回覆盖区域与前后缀 ---------- */
  function findMatch(lines, original) {
    const target = norm(original);
    if (target.length < 6) return null;

    let concat = '';
    const lineOfChar = [];              // 归一化后每个字符属于哪一行
    const normLineText = [];
    lines.forEach((ln, li) => {
      const t = norm(ln.text);
      normLineText.push(t);
      for (let k = 0; k < t.length; k++) lineOfChar.push(li);
      concat += t;
    });

    const at = concat.indexOf(target);
    if (at < 0) return null;
    const end = at + target.length - 1;
    const liStart = lineOfChar[at], liEnd = lineOfChar[end];

    // 首行匹配起点之前 / 末行匹配终点之后的残余文本（通常为空，防止误盖同段其他内容）
    let beforeStart = 0;
    for (let i = 0; i < liStart; i++) beforeStart += normLineText[i].length;
    const prefix = normLineText[liStart].slice(0, at - beforeStart);
    let beforeEnd = 0;
    for (let i = 0; i < liEnd; i++) beforeEnd += normLineText[i].length;
    const suffix = normLineText[liEnd].slice(end - beforeEnd + 1);

    // 覆盖区域 = 匹配行的外接矩形
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const hs = [];
    for (let i = liStart; i <= liEnd; i++) {
      for (const f of lines[i].frags) {
        x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y);
        x1 = Math.max(x1, f.x + f.w); y1 = Math.max(y1, f.y + f.h);
      }
      hs.push(lines[i].h);
    }
    hs.sort((a, b) => a - b);
    const lineH = hs[Math.floor(hs.length / 2)] || 20;
    return { liStart, liEnd, bbox: { x0, y0, x1, y1 }, prefix, suffix, lineH };
  }

  /* ---------- 取样：背景色（区域四周边框像素众数）与文字色（区域内最深像素） ---------- */
  function sampleColors(ctx, x0, y0, x1, y1, canvas) {
    let bg = '#ffffff', fg = '#1e293b';
    try {
      const sx = Math.max(0, Math.floor(x0) - 6), sy = Math.max(0, Math.floor(y0) - 6);
      const sw = Math.min(canvas.width - sx, Math.ceil(x1 - x0) + 12);
      const sh = Math.min(canvas.height - sy, Math.ceil(y1 - y0) + 12);
      if (sw < 4 || sh < 4) return { bg, fg };
      const img = ctx.getImageData(sx, sy, sw, sh).data;
      const count = {};
      let darkest = null, darkLum = 256;
      const step = 4 * 2;   // 隔像素采样提速
      for (let p = 0; p < img.length; p += step) {
        const r = img[p], g = img[p + 1], b = img[p + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        // 边框带（外扩区域最外 4px）视作背景候选
        const px = (p / 4) % sw, py = Math.floor((p / 4) / sw);
        if (px < 4 || py < 4 || px > sw - 5 || py > sh - 5) {
          const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
          count[key] = (count[key] || 0) + 1;
        }
        if (lum < darkLum) { darkLum = lum; darkest = [r, g, b]; }
      }
      let bestKey = null, bestN = 0;
      for (const k in count) if (count[k] > bestN) { bestN = count[k]; bestKey = k; }
      if (bestKey) {
        const [r, g, b] = bestKey.split(',').map(v => (parseInt(v, 10) << 4) + 8);
        bg = 'rgb(' + r + ',' + g + ',' + b + ')';
      }
      if (darkest && darkLum < 160) fg = 'rgb(' + darkest[0] + ',' + darkest[1] + ',' + darkest[2] + ')';
    } catch (e) { /* getImageData 失败则用默认色 */ }
    return { bg, fg };
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const seg of String(text || '').split('\n')) {
      let line = '';
      for (const ch of seg) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = ch; }
        else line = test;
      }
      out.push(line);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  /* ---------- 覆盖重写一个匹配区域 ---------- */
  function paintReplace(ctx, canvas, m, newBody) {
    const x0 = Math.max(0, m.bbox.x0 - 3), y0 = Math.max(0, m.bbox.y0 - 3);
    const x1 = Math.min(canvas.width, m.bbox.x1 + 3), y1 = Math.min(canvas.height, m.bbox.y1 + 3);
    const { bg, fg } = sampleColors(ctx, x0, y0, x1, y1, canvas);

    ctx.save();
    ctx.fillStyle = bg;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    const newText = (m.prefix || '') + newBody + (m.suffix || '');
    const maxW = Math.max(20, x1 - x0 - 4);
    const maxH = y1 - y0 - 2;
    // 初始字号≈原行高的 78%，放不下逐步缩小（下限 9px）
    let size = Math.max(10, Math.min(Math.round(m.lineH * 0.78), 34));
    let lines, lh;
    for (;;) {
      ctx.font = size + 'px "Microsoft YaHei","PingFang SC",sans-serif';
      lines = wrapText(ctx, newText, maxW);
      lh = Math.max(size * 1.3, (m.liEnd > m.liStart) ? maxH / Math.max(lines.length, 1) : size * 1.3);
      lh = Math.min(lh, size * 1.6);
      if (lines.length * lh <= maxH + 2 || size <= 9) break;
      size -= 1;
    }
    ctx.fillStyle = fg;
    ctx.textBaseline = 'top';
    let yy = y0 + Math.max(1, (maxH - lines.length * lh) / 2);
    for (const l of lines) {
      if (yy + size > y1 + 2) break;      // 溢出保护：绝不画出区域外
      ctx.fillText(l, x0 + 2, yy);
      yy += lh;
    }
    ctx.restore();
  }

  /* ---------- 主流程 ---------- */
  async function rewritePdf(uint8, items, onProgress) {
    const lib = await waitPdfjs(5000);
    if (!lib) throw new Error('PDF 引擎未加载（需联网加载 pdf.js）');
    if (!lib.GlobalWorkerOptions.workerSrc)
      lib.GlobalWorkerOptions.workerSrc = window.__pdfjsWorkerSrc ||
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    const doc = await lib.getDocument({ data: uint8.slice() }).promise;
    const pending = (items || [])
      .map(it => ({ orig: (it.original || '').trim(), sugg: (it.suggestion || '').trim(), done: false }))
      .filter(r => r.orig && r.sugg);

    const canvases = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;   // ← 原页面原样渲染

      // 文字坐标（转为视口坐标：y 向下、含渲染倍率）
      const tc = await page.getTextContent();
      const pageHpdf = viewport.height / RENDER_SCALE;
      const frags = tc.items
        .filter(i => i.str && i.str.trim())
        .map(i => {
          const h = Math.abs(i.transform[3]) || Math.abs(i.transform[0]) || 10;
          return {
            str: i.str,
            x: i.transform[4] * RENDER_SCALE,
            y: (pageHpdf - i.transform[5] - h) * RENDER_SCALE,
            w: (i.width || 0) * RENDER_SCALE,
            h: h * RENDER_SCALE
          };
        });

      const lines = groupLines(frags);
      for (const rep of pending) {
        if (rep.done) continue;
        const m = findMatch(lines, rep.orig);
        if (!m) continue;
        paintReplace(ctx, canvas, m, rep.sugg);
        rep.done = true;
      }
      canvases.push(canvas);
      if (onProgress) onProgress(p, doc.numPages);
    }
    try { doc.destroy && doc.destroy(); } catch (e) { }

    const applied = pending.filter(r => r.done).length;
    const missed = pending.length - applied;
    const blob = App.pdfExport.buildPdfFromPages(canvases);
    return { blob, applied, missed };
  }

  App.pdfRewrite = {
    rewritePdf,
    _groupLines: groupLines,   // 供测试
    _findMatch: findMatch      // 供测试
  };
})();
