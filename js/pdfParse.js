/* pdfParse.js - PDF 解析（挂载到 window.App.pdfParse）
 * 文本提取（质量优先）：
 *   ① pdf.js（CDN，成熟引擎）优先——等待加载最多 4 秒
 *      版面重建参考两个开源项目的做法：
 *      · open-resume（xitanggg/open-resume）：行内相邻碎片按「典型字符宽度」合并，
 *        避免一个词被 pdf.js 拆成多个 item 后乱插空格；
 *      · XY-Cut 递归切割（OpenDataLoader / edgeparse 等 PDF 解析器的标准算法）：
 *        自动检测双栏/侧边栏简历的「栏间空白沟」，先输出整条左栏、再输出右栏，
 *        全宽的标题行（如居中的姓名、跨栏的章节标题）按原位置穿插，
 *        彻底解决“左右两栏文字被逐行混在一起 / 阅读顺序从上往下乱串”的问题。
 *   ② 内置 pdfLite（零依赖）兜底
 *   ③ 两者都有结果时取质量分更高的（pdf.js 因带版面信息享受加权）
 * 结构化：本地正则启发式，生成可编辑简历对象。 */
(function () {
  window.App = window.App || {};

  /* 等待 pdf.js CDN 异步加载完成（最多 waitMs） */
  function waitPdfjs(waitMs) {
    return new Promise(function (resolve) {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      if (window.__pdfjsFailed) return resolve(null);   // CDN 已全部失败，立即回退
      var waited = 0, timer = setInterval(function () {
        waited += 200;
        if (window.pdfjsLib || window.__pdfjsFailed || waited >= waitMs) {
          clearInterval(timer); resolve(window.pdfjsLib || null);
        }
      }, 200);
    });
  }

  /* ===================== 版面重建（open-resume + XY-Cut） ===================== */

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /* 典型字符宽度（open-resume 思路：总宽度/总字符数），用于合并碎片与补空格判断 */
  function typicalCharWidth(frags) {
    let w = 0, n = 0;
    for (const f of frags) {
      const t = (f.str || '').trim();
      if (t) { w += f.w || 0; n += t.length; }
    }
    return n ? Math.max(2, w / n) : 8;
  }

  /* 按 y 坐标把碎片聚成行（容差 = 半个字高） */
  function clusterLines(items, medH) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const f of sorted) {
      const tol = Math.max(3, (f.h || medH) * 0.5, medH * 0.45);
      const row = rows.length ? rows[rows.length - 1] : null;
      if (!row || Math.abs(row.y - f.y) > tol) rows.push({ y: f.y, frags: [f] });
      else row.frags.push(f);
    }
    return rows;
  }

  /* 一行内：x 排序 + 按间隙决定「直接拼 / 补空格」（中文小间隙不拆词） */
  function rowText(row, tcw) {
    row.frags.sort((a, b) => a.x - b.x);
    let line = '', lastEnd = null;
    for (const f of row.frags) {
      if (lastEnd !== null) {
        const gap = f.x - lastEnd;
        if (gap > Math.max(2, tcw * 0.35)) line += (gap > tcw * 2.5 ? '  ' : ' ');
      }
      line += f.str;
      lastEnd = f.x + (f.w || 0);
    }
    return line.replace(/\s+$/,'');
  }

  /* 在区域内寻找纵向「空白沟」（栏间距）：x 覆盖直方图中一段几乎无覆盖的连续区间 */
  function findGutter(items, medH, rowCount) {
    let minX = Infinity, maxX = -Infinity;
    for (const f of items) { if (f.x < minX) minX = f.x; const e = f.x + (f.w || 0); if (e > maxX) maxX = e; }
    const W = maxX - minX;
    if (!(W > 120)) return null;
    const NB = 256, cov = new Array(NB).fill(0);
    for (const f of items) {
      const s = Math.max(0, Math.floor((f.x - minX) / W * NB));
      const e = Math.min(NB - 1, Math.ceil((f.x + (f.w || 0) - minX) / W * NB));
      for (let i = s; i <= e; i++) cov[i]++;
    }
    const crossLimit = Math.max(1, Math.round(rowCount * 0.12)); // 允许少量全宽行（居中姓名/章节标题）穿过
    const minGutter = Math.max(9, medH * 0.7);
    let best = null, i = 0;
    while (i < NB) {
      if (cov[i] <= crossLimit) {
        let j = i;
        while (j < NB && cov[j] <= crossLimit) j++;
        const x0 = minX + i / NB * W, x1 = minX + j / NB * W;
        const posOk = (x0 - minX) > W * 0.15 && (maxX - x1) > W * 0.15; // 沟必须在版心中部
        if (posOk && (x1 - x0) >= minGutter && (!best || (x1 - x0) > best.w))
          best = { x0: x0, x1: x1, w: x1 - x0 };
        i = j;
      } else i++;
    }
    return best;
  }

  /* XY-Cut：递归把碎片切成按阅读顺序排列的区域列表（全宽行 → 左栏 → 右栏） */
  function layoutRegions(items, medH, depth) {
    if (items.length < 8 || depth > 3) return [items];
    const rows = clusterLines(items, medH);
    const g = findGutter(items, medH, rows.length);
    if (!g) return [items];
    // 全宽行判定：行内有碎片「落在栏沟内部」或「横穿栏沟」才算（居中标题/跨栏章节标题）。
    // 不能按整行范围判——双栏的每对左右行合起来必然横跨栏沟，会全部误判。
    const isFullRow = r => r.frags.some(f => {
      const e = f.x + (f.w || 0), c = f.x + (f.w || 0) / 2;
      return (f.x < g.x0 - 1 && e > g.x1 + 1) || (c > g.x0 && c < g.x1);
    });
    const fullCnt = rows.filter(isFullRow).length;
    // 穿过沟的行太多 → 不是真正的双栏，放弃切割
    if (rows.length - fullCnt < 4 || fullCnt > rows.length * 0.45) return [items];
    // 左右都要有实际内容
    const gc = (g.x0 + g.x1) / 2;
    let nl = 0, nr = 0;
    for (const r of rows) { if (isFullRow(r)) continue; for (const f of r.frags) ((f.x + (f.w || 0) / 2) <= gc ? nl++ : nr++); }
    if (nl < 3 || nr < 3) return [items];

    const regions = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const L = [], R = [];
      for (const r of buf) for (const f of r.frags) ((f.x + (f.w || 0) / 2) <= gc ? L : R).push(f);
      if (L.length) regions.push.apply(regions, layoutRegions(L, medH, depth + 1));
      if (R.length) regions.push.apply(regions, layoutRegions(R, medH, depth + 1));
      buf = [];
    };
    for (const r of rows) {
      if (isFullRow(r)) { flush(); regions.push(r.frags.slice()); } // 全宽行（姓名/章节标题）按原位输出
      else buf.push(r);
    }
    flush();
    return regions;
  }

  /* 整页重建：XY-Cut 分区 → 每区聚行 → 行内合并碎片 */
  function rebuildPage(frags) {
    if (!frags.length) return '';
    const medH = median(frags.map(f => f.h || 10)) || 10;
    const tcw = typicalCharWidth(frags);
    const regions = layoutRegions(frags, medH, 0);
    const out = [];
    for (const items of regions)
      for (const row of clusterLines(items, medH)) {
        const t = rowText(row, tcw);
        if (t.trim()) out.push(t);
      }
    return out.join('\n');
  }

  /* pdf.js 提取：整页碎片 → rebuildPage 还原真实阅读顺序 */
  async function extractByPdfjs(uint8) {
    const lib = await waitPdfjs(4000);
    if (!lib) return '';
    if (!lib.GlobalWorkerOptions.workerSrc)
      lib.GlobalWorkerOptions.workerSrc = window.__pdfjsWorkerSrc || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    const doc = await lib.getDocument({ data: uint8.slice() }).promise;
    let txt = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      const frags = c.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width || 0,
          h: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10
        }));
      txt += rebuildPage(frags) + '\n\n';
    }
    try { doc.destroy && doc.destroy(); } catch (e) {}
    return txt.replace(/\n{3,}/g, '\n\n').trim();
  }

  function quality(t) {
    if (!t) return 0;
    if (App.ocr && App.ocr.textScore) return App.ocr.textScore(t);
    return (t.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
  }

  async function extractText(uint8) {
    let byPdfjs = '', byLite = '';
    // ① pdf.js 优先（质量最好，且带版面重建）
    try { byPdfjs = await extractByPdfjs(uint8); } catch (e) { console.warn('[pdf] pdf.js 提取失败：', e.message); }
    // ② pdfLite 兜底 / 对照
    try { byLite = App.pdfLite.extractPdfText(uint8) || ''; } catch (e) { console.warn('[pdf] pdfLite 提取失败：', e.message); }
    if (byPdfjs.trim().length > 20 && byLite.trim().length > 20)
      return quality(byPdfjs) * 1.2 >= quality(byLite) ? byPdfjs : byLite; // pdf.js 有版面信息，加权优先
    if (byPdfjs.trim().length > 20) return byPdfjs;
    if (byLite.trim().length > 20) return byLite;
    return byPdfjs || byLite || '';
  }

  // 结构化：把纯文本切成简历字段
  function structureResume(text) {
    const r = App.store.blankResume('导入的简历');
    const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);

    // 姓名/电话/邮箱/意向
    for (const l of lines) {
      if (!r.basic.phone && /1[3-9]\d{9}/.test(l)) r.basic.phone = (l.match(/1[3-9]\d{9}/) || [])[0];
      if (!r.basic.email && /[\w.+-]+@[\w-]+\.[\w.-]+/.test(l)) r.basic.email = (l.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
      if (!r.basic.target && /(求职意向|期望职位|目标岗位|意向岗位)\s*[:：]?\s*(.+)/.test(l)) r.basic.target = l.match(/(求职意向|期望职位|目标岗位|意向岗位)\s*[:：]?\s*(.+)/)[2];
    }
    // 姓名：特征打分法（参考 open-resume 的 feature scoring）
    // 对文档前几行的候选词打分：位置越靠前越像姓名；命中职位/章节/联系方式等特征则扣分
    if (!r.basic.name) {
      const NEG = /简历|履历|电话|邮箱|地址|微信|求职|意向|经理|工程师|专员|主管|总监|设计师|分析师|顾问|运营|开发|经历|教育|技能|评价|男|女|岁|届|@|\d{3,}/;
      let best = null;
      lines.slice(0, 6).forEach((l, li) => {
        // 行内按分隔符拆词（应对“张三 | 产品经理 | 13800000000”这类头部行）
        l.split(/[\s|｜·,，/]+/).forEach(tok => {
          tok = tok.trim();
          if (!tok) return;
          let score = 0;
          if (/^[\u4e00-\u9fa5]{2,4}$/.test(tok)) score += 3;                       // 2~4字中文
          else if (/^[A-Z][a-z]+( [A-Z][a-z]+){1,2}$/.test(tok)) score += 2;        // 英文名
          else return;
          if (NEG.test(tok)) score -= 4;                                            // 命中职位/字段词
          score += Math.max(0, 3 - li);                                             // 越靠前越像姓名
          if (tok === l.trim()) score += 1;                                         // 独占一行加分
          if (!best || score > best.score) best = { tok, score };
        });
      });
      if (best && best.score >= 3) r.basic.name = best.tok;
    }

    // 分块
    const blocks = splitBlocks(lines);
    r.experiences = blocks.exp.map(b => ({ role: b.title || '', company: b.sub || '', period: b.period || '', description: b.body }));
    r.projects = blocks.proj.map(b => ({ name: b.title || '', role: b.sub || '', period: b.period || '', description: b.body }));
    r.education = blocks.edu.map(b => ({ school: b.title || '', major: b.sub || '', degree: b.degree || '', period: b.period || '' }));
    r.skills = blocks.skills;
    r.summary = blocks.summary;
    return r;
  }

  function splitBlocks(lines) {
    const res = { exp: [], proj: [], edu: [], skills: '', summary: '' };
    let cur = null, mode = '';
    const isHead = l => /(20\d\d|19\d\d)\s*[-~至]\s*(20\d\d|19\d\d|至今)/.test(l) || /^\d{4}\.\d{1,2}\s*[-~]\s*\d{4}/.test(l);
    for (const l of lines) {
      const low = l.toLowerCase();
      if (/教育|学历|毕业院校|学校/.test(l) && !mode) { mode = 'edu'; cur = { lines: [] }; res.edu.push(cur); continue; }
      if (/项目经历|项目经验|projects?/i.test(l)) { mode = 'proj'; cur = { lines: [] }; res.proj.push(cur); continue; }
      if (/工作经历|工作经验|实习|employment/i.test(l) && !mode) { mode = 'exp'; cur = { lines: [] }; res.exp.push(cur); continue; }
      if (/技能|特长|skills/i.test(l)) { mode = 'skills'; continue; }
      if (/自我评价|个人评价|summary|about/i.test(l)) { mode = 'summary'; continue; }
      if (mode === 'skills') res.skills += l + ' ';
      else if (mode === 'summary') res.summary += l + ' ';
      else if (cur) cur.lines.push(l);
    }
    // 把每个块的 lines 整理成 title/sub/period/body
    ['exp', 'proj', 'edu'].forEach(k => {
      res[k] = res[k].map(b => {
        const ls = b.lines || [];
        const head = ls.find(isHead);
        const title = ls[0] && ls[0] !== head ? ls[0] : (ls[1] || '');
        const sub = ls.find(l => l !== title && l !== head && l.length > 1) || '';
        const body = ls.filter(l => l !== title && l !== sub && l !== head).join('\n');
        const degree = (ls.find(l => /本科|硕士|博士|大专|专科/.test(l)) || '');
        return { title, sub, period: head || '', body, degree };
      });
    });
    return res;
  }

  App.pdfParse = { extractText, structureResume, _rebuildPage: rebuildPage };
})();
