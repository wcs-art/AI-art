/* app.js - STAR 法则简历优化（母版 + 多岗位定制架构）
 * 架构原则：
 *   ① 母版简历（master）导入后只读——所有优化都在内存副本上做，绝不写回母版
 *   ② 岗位（job）可添加多个，每个岗位保存自己的 JD，独立生成一份定制简历
 *   ③ 一键直出：点「生成定制简历 PDF」→ AI 按该岗位 JD 出建议 → 自动全部套用到母版副本
 *      （原文原位替换，行序/空行/缩进不变）→ 直接下载 PDF
 */
(function () {
  const App = window.App;
  const U = App.util;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    master: null,        // { text, resume, name, importedAt } —— 只读母版
    masterPdfBytes: null,// 母版原始 PDF 文件字节（用于"原版式重写"，同样只读）
    jobs: [],            // [{ id, title, jdText, createdAt, lastResult }]
    ocrJobId: null,      // 当前等待 JD 截图识别结果的岗位 id
    blobCache: {}        // jobId -> 本次会话生成的 PDF Blob（刷新后用文本版重建）
  };

  /* ================= 初始化 ================= */
  function init() {
    App.store.migrateOldDraft();               // 旧版草稿一次性迁移
    state.master = App.store.getMaster();
    state.masterPdfBytes = App.store.getMasterPdf();   // 恢复母版原始 PDF（若存过）
    state.jobs = App.store.getJobs();
    if (!state.jobs.length) addJob(false);     // 默认给一个空岗位
    bind();
    renderMaster();
    renderJobs();
    renderAiSetting();
  }

  function persistJobs() { App.store.saveJobs(state.jobs); }

  /* ================= 母版导入（唯一允许写母版的入口） ================= */

  function isPdfFile(f) { return /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name || ''); }
  function isImageFile(f) { return /^image\//i.test(f.type) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name || ''); }

  async function handleResumePdf(f) {
    const tip = $('#resumeTip');
    tip.textContent = '正在解析 PDF…';
    try {
      const buf = await U.readFileAsArrayBuffer(f);
      const bytes = new Uint8Array(buf);
      const text = await App.pdfParse.extractText(bytes);
      if (!text || text.trim().length < 20) throw new Error('未能提取到文字（若是扫描件请用图片方式或「粘贴文字」）');
      tip.textContent = '';
      confirmImport(text, (f.name || '简历').replace(/\.pdf$/i, ''), 'PDF 解析完成，母版已导入', bytes);
    } catch (err) { U.toast('解析失败：' + err.message, 3500); tip.textContent = ''; }
  }

  async function handleResumeImage(f) {
    const tip = $('#resumeTip');
    tip.textContent = '正在识别图片文字…（首次需联网加载识别引擎，稍等）';
    try {
      const { text } = await App.ocr.ocrImageText(f, (p, label) => tip.textContent = '识别中（' + (label || '') + '）… ' + p + '%');
      tip.textContent = '';
      confirmImport(text, '图片导入的简历', '图片识别完成，母版已导入');
    } catch (err) {
      U.toast(err.message, 4000);
    } finally { renderMaster(); }
  }

  function handleResumeFile(f) {
    if (!f) return;
    if (isPdfFile(f)) return handleResumePdf(f);
    if (isImageFile(f)) return handleResumeImage(f);
    U.toast('不支持的文件类型：请拖入 PDF 或图片', 3000);
  }

  /* 识别/解析完成 → 弹核对框（可修正错字）→ 确认后设为母版 */
  function confirmImport(text, name, okMsg, pdfBytes) {
    const doImport = (fixed) => {
      if (fixed.trim().length < 20) { U.toast('内容太短，请补充完整简历'); return false; }
      setMaster(fixed, name, pdfBytes || null);
      U.toast(okMsg || '母版简历已导入');
      return true;
    };
    if (state.master) {
      // 已有母版：明确提示将整体替换（而不是修改）
      showPasteModal('核对识别结果 — 确认后将【整体替换】当前母版（原母版不会被部分修改）', text.trim(), doImport);
    } else {
      showPasteModal('核对识别结果（识别难免有错字，可直接修改后导入）', text.trim(), doImport);
    }
  }

  function setMaster(text, name, pdfBytes) {
    const resume = App.pdfParse.structureResume(text.trim());
    resume.name = name || resume.name;
    // 结构化太弱时（没切出任何经历），把全文塞进一条经历，保证 AI 仍能优化
    if (!resume.experiences.length && !resume.summary) {
      resume.experiences = [{ role: '', company: '', period: '', description: text.trim().slice(0, 2000) }];
    }
    state.master = { text: text.trim(), resume, name: name || '我的简历', importedAt: Date.now() };
    App.store.setMaster(state.master);
    // 母版原始 PDF：PDF 导入则保存（原版式重写用）；其他来源则清除
    state.masterPdfBytes = pdfBytes || null;
    if (pdfBytes) {
      const persisted = App.store.setMasterPdf(pdfBytes);
      if (!persisted) U.toast('原 PDF 文件较大，仅本次会话可用原版式导出（刷新后需重新导入）', 4500);
    } else {
      App.store.clearMasterPdf();
    }
    // 母版换了，旧的生成结果全部失效
    state.jobs.forEach(j => j.lastResult = null);
    state.blobCache = {};
    persistJobs();
    $('#result').innerHTML = '';
    renderMaster(); renderJobs();
  }

  function renderMaster() {
    const box = $('#resumeStatus'), tip = $('#resumeTip');
    if (!state.master) {
      box.innerHTML = '<span class="muted">尚未导入简历 — 支持 PDF、截图/照片、直接粘贴文字</span>';
      tip.textContent = '';
      $('#clearResume').style.display = 'none';
      return;
    }
    const r = state.master.resume || {};
    const parts = [];
    if (r.basic && r.basic.name) parts.push('👤 ' + U.escapeHtml(r.basic.name));
    if (r.basic && r.basic.target) parts.push('🎯 ' + U.escapeHtml(r.basic.target));
    parts.push('📄 经历 ' + ((r.experiences || []).length) + ' 段');
    if (r.skills) parts.push('🛠 技能已识别');
    if (r.summary) parts.push('💬 自我评价已识别');
    box.innerHTML =
      '<div class="resume-ok">✅ 母版已导入（' + parts.join(' · ') + '）</div>' +
      '<div class="master-lock">🔒 母版受保护：生成定制简历时只在副本上替换内容，<b>这份原文永远不会被改动</b></div>' +
      (state.masterPdfBytes ?
        '<div class="master-lock" style="margin-top:6px">🎨 已保留原 PDF 文件：生成定制简历时将<b>保持原版式不变</b>，只替换岗位相关内容</div>' :
        '<div class="muted" style="margin-top:6px;font-size:12px">💡 提示：用 PDF 文件导入可在生成时保持原版式不变（当前来源无原 PDF，将按纯文本排版导出）</div>') +
      '<details class="mt"><summary>查看母版原文（只读）</summary><pre class="pre">' +
      U.escapeHtml(state.master.text.slice(0, 3000)) + (state.master.text.length > 3000 ? '\n…' : '') +
      '</pre></details>';
    tip.textContent = '';
    $('#clearResume').style.display = '';
  }

  /* ================= 岗位管理 ================= */

  function addJob(toast) {
    const n = state.jobs.length + 1;
    state.jobs.push({
      id: U.uid('job'), title: '目标岗位 ' + n, jdText: '',
      createdAt: Date.now(), lastResult: null
    });
    persistJobs();
    if (toast !== false) { renderJobs(); U.toast('已添加岗位，粘贴该岗位的 JD 即可'); }
  }

  function removeJob(id) {
    state.jobs = state.jobs.filter(j => j.id !== id);
    if (!state.jobs.length) addJob(false);
    persistJobs(); renderJobs();
  }

  function jobById(id) { return state.jobs.find(j => j.id === id); }

  function renderJobs() {
    const el = $('#jobList');
    el.innerHTML = state.jobs.map(j => {
      const res = j.lastResult;
      return (
        '<div class="job-card" data-job="' + j.id + '">' +
        '  <div class="job-head">' +
        '    <input class="job-title-input" data-act="title" value="' + U.escapeHtml(j.title) + '" ' +
        '           style="font-weight:700;font-size:15px;border:none;background:transparent;flex:1;min-width:120px;outline:none" />' +
        '    <button class="btn sm danger" data-act="del">删除</button>' +
        '  </div>' +
        '  <textarea data-act="jd" rows="5" placeholder="把该岗位的 JD（职位描述）粘贴到这里，或把 JD 截图拖到下方识别">' + U.escapeHtml(j.jdText || '') + '</textarea>' +
        '  <div class="dropzone small" data-act="jddrop">📷 把该岗位的 <b>JD 截图</b> 拖到这里识别（或点击选图 / 在上方输入框 Ctrl+V）</div>' +
        '  <div class="job-actions">' +
        '    <button class="btn lg" data-act="gen" style="flex:1">⚡ 生成该岗位定制简历 PDF</button>' +
        '  </div>' +
        (res ?
        '  <div class="job-result">' +
        '    <span class="muted">上次生成：' + new Date(res.at).toLocaleString() + ' · 套用 ' + res.applied + ' 条优化' +
             (res.missed ? '（' + res.missed + ' 条未定位，保留原文）' : '') + (res.mock ? ' · 本地演示' : '') + '</span> ' +
        '    <button class="btn sm ghost" data-act="preview">👁 预览</button> ' +
        '    <button class="btn sm ghost" data-act="redl">⬇️ 下载 PDF</button>' +
        '  </div>' : '') +
        '</div>'
      );
    }).join('');

    // 事件绑定
    el.querySelectorAll('.job-card').forEach(card => {
      const id = card.dataset.job;
      card.querySelector('[data-act="title"]').onchange = (e) => {
        const j = jobById(id); if (j) { j.title = e.target.value.trim() || j.title; persistJobs(); }
      };
      card.querySelector('[data-act="jd"]').oninput = U.debounce((e) => {
        const j = jobById(id); if (j) { j.jdText = e.target.value; persistJobs(); }
      }, 400);
      card.querySelector('[data-act="del"]').onclick = () => {
        const j = jobById(id);
        if (j && (j.jdText || j.lastResult)) {
          if (!confirm('删除岗位「' + j.title + '」？其 JD 与生成记录将一并移除（母版不受影响）')) return;
        }
        removeJob(id);
      };
      card.querySelector('[data-act="gen"]').onclick = () => generateForJob(id);
      const pv = card.querySelector('[data-act="preview"]');
      if (pv) pv.onclick = () => showResult(jobById(id), null, false);
      const rd = card.querySelector('[data-act="redl"]');
      if (rd) rd.onclick = () => {
        const j = jobById(id);
        if (j && j.lastResult) {
          try {
            const cached = state.blobCache[j.id];
            if (cached) { U.download(cached, pdfName(j)); }          // 原版式版本（本次会话）
            else { App.pdfExport.exportTextPdf(j.lastResult.text, pdfName(j)); }  // 刷新后回退文本版
            U.toast('已下载');
          }
          catch (e) { U.toast('下载失败：' + e.message, 3500); }
        }
      };
      // JD 截图拖拽区
      const dz = card.querySelector('[data-act="jddrop"]');
      bindDropzone(dz, (f) => handleJdImage(f, id), null);
      dz.addEventListener('click', () => { state.ocrJobId = id; $('#jdImgFile').click(); });
    });
  }

  /* JD 截图识别（归属到指定岗位） */
  async function handleJdImage(f, jobId) {
    if (!f) return;
    if (!isImageFile(f)) { U.toast('请拖入 JD 截图（图片文件）', 3000); return; }
    const j = jobById(jobId);
    if (!j) return;
    U.toast('正在识别 JD 截图…');
    try {
      const { text } = await App.ocr.ocrImageText(f, (p, label) => U.toast('JD 识别中（' + (label || '') + '）… ' + p + '%', 900));
      showPasteModal('核对 JD 识别结果（可直接修改）— ' + j.title, text.trim(), (fixed) => {
        if (fixed.trim().length < 5) { U.toast('内容太短'); return false; }
        j.jdText = (j.jdText.trim() ? j.jdText.trim() + '\n' : '') + fixed.trim();
        persistJobs(); renderJobs();
        U.toast('JD 已填入「' + j.title + '」');
        return true;
      });
    } catch (err) { U.toast(err.message, 4000); }
  }

  /* ================= 一键生成：母版副本 + 该岗位 JD → 定制 PDF ================= */

  /* 宽松替换：先精确匹配；失败则忽略空白差异匹配。找不到返回 null（该条跳过，原文保留）。 */
  function replaceLoose(text, orig, sugg) {
    if (!orig || !sugg) return null;
    const idx = text.indexOf(orig);
    if (idx >= 0) return text.slice(0, idx) + sugg + text.slice(idx + orig.length);
    const target = orig.replace(/\s+/g, '');
    if (!target) return null;
    const map = []; let acc = '';
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i])) { map.push(i); acc += text[i]; }
    }
    const at = acc.indexOf(target);
    if (at < 0) return null;
    const s0 = map[at], e0 = map[at + target.length - 1];
    return text.slice(0, s0) + sugg + text.slice(e0 + 1);
  }

  function pdfName(job) {
    const nm = (state.master && state.master.resume && state.master.resume.basic && state.master.resume.basic.name) || '';
    return (nm ? nm + '-' : '') + (job.title || '定制') + '-定制简历.pdf';
  }

  async function generateForJob(jobId) {
    const j = jobById(jobId);
    if (!j) return;
    if (!state.master) { U.toast('请先导入母版简历（PDF / 图片 / 粘贴）'); return; }
    if ((j.jdText || '').trim().length < 10) { U.toast('请先给「' + j.title + '」粘贴 JD 或上传 JD 截图'); return; }

    const card = document.querySelector('.job-card[data-job="' + jobId + '"]');
    const btn = card && card.querySelector('[data-act="gen"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在按该岗位优化…'; }

    try {
      // ① AI 按该岗位 JD 出建议（输入是母版的结构化副本，母版本体不动）
      const res = await App.ai.optimizeStart(JSON.parse(JSON.stringify(state.master.resume)), j.jdText.trim());
      const items = res.items || [];
      if (!items.length) throw new Error('AI 未返回优化建议');

      // ② 同步维护"文本版结果"（刷新后重新下载用；母版 text 永不改动）
      let text = state.master.text;
      let tApplied = 0, tMissed = 0;
      items.forEach(it => {
        const r = replaceLoose(text, (it.original || '').trim(), (it.suggestion || '').trim());
        if (r !== null) { text = r; tApplied++; } else tMissed++;
      });

      // ③ 生成 PDF：有原 PDF 文件 → 原版式重写（格式不变，只改内容）；否则 → 文本版排版
      let blob = null, applied = 0, missed = 0, mode = 'text';
      if (state.masterPdfBytes) {
        try {
          if (btn) btn.textContent = '正在按原版式重写 PDF…';
          const out = await App.pdfRewrite.rewritePdf(state.masterPdfBytes, items,
            (p, total) => { if (btn) btn.textContent = '原版式重写中… ' + p + '/' + total + ' 页'; });
          if (out.applied > 0) { blob = out.blob; applied = out.applied; missed = out.missed; mode = 'rewrite'; }
        } catch (e2) {
          console.warn('[rewrite] 原版式重写失败，回退文本版：', e2.message);
        }
      }
      if (!blob) {
        if (!tApplied) throw new Error('没有可套用的优化建议（' + (tMissed ? tMissed + ' 条未能在原文定位' : 'AI 未返回建议') + '）');
        blob = App.pdfExport.buildPdf(App.pdfExport.drawRawText(text));
        applied = tApplied; missed = tMissed; mode = 'text';
      }
      U.download(blob, pdfName(j));

      // ④ 记录该岗位的生成结果（与母版、其他岗位互不影响）
      j.lastResult = { text, applied, missed, mock: !!res._mock, at: Date.now(), mode };
      state.blobCache[j.id] = blob;
      persistJobs(); renderJobs();

      U.toast('「' + j.title + '」定制简历 PDF 已生成并开始下载' +
        (mode === 'rewrite' ? '（原版式保持不变）' : '') +
        (missed ? '（' + missed + ' 条建议未定位，保留原文）' : ''), missed ? 4500 : 2500);
      showResult(j, blob, true);
    } catch (e) {
      U.toast('生成失败：' + e.message, 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ 生成该岗位定制简历 PDF'; }
    }
  }

  /* 结果预览卡片（不弹下载时仅预览） */
  function showResult(job, blob, justDownloaded) {
    if (!job || !job.lastResult) return;
    const res = job.lastResult;
    const el = $('#result');
    el.innerHTML =
      (res.mock ? '<div class="card warn">⚠️ 当前为<b>本地演示结果</b>（规则生成）。在「AI 设置」接入本地 AI 服务（server/local-ai-server.js + Ollama）可获得真实优化文案。</div>' : '') +
      '<div class="card"><h2>✅ ' + U.escapeHtml(job.title) + ' — 定制简历 PDF</h2>' +
      '  <div class="muted" style="margin:6px 0 10px">' +
      (justDownloaded ? '已在<b>母版副本</b>上套用 ' + res.applied + ' 条针对该岗位的优化（母版原文未改动），并自动下载。' :
        '这是该岗位上次生成的定制版（母版原文未改动）。') +
      (res.mode === 'rewrite' ? ' <b>已保持原 PDF 版式不变，只替换了岗位相关内容。</b>' : '') +
      '下方为预览：</div>' +
      '  <iframe id="pdfPreview" style="width:100%;height:560px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc"></iframe>' +
      '  <div class="row mt">' +
      '    <button class="btn" id="dlPdfBtn">⬇️ 下载 PDF</button>' +
      '  </div></div>';
    try {
      const b = blob || state.blobCache[job.id] || App.pdfExport.buildPdf(App.pdfExport.drawRawText(res.text));
      $('#pdfPreview').src = URL.createObjectURL(b);
    } catch (e) { $('#pdfPreview').style.display = 'none'; }
    $('#dlPdfBtn').onclick = () => {
      try {
        const cached = blob || state.blobCache[job.id];
        if (cached) U.download(cached, pdfName(job));
        else App.pdfExport.exportTextPdf(res.text, pdfName(job));
        U.toast('已下载');
      }
      catch (e) { U.toast('下载失败：' + e.message, 3500); }
    };
    el.scrollIntoView({ behavior: 'smooth' });
  }

  App._replaceLoose = replaceLoose;   // 供测试

  /* ================= 拖拽绑定 ================= */
  function bindDropzone(el, onFile, clickInput) {
    if (!el) return;
    ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('dragover');
    }));
    el.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) onFile(files[0]);
    });
    if (clickInput) el.addEventListener('click', () => clickInput.click());
  }

  /* ================= 全局绑定 ================= */
  function bind() {
    $('#pdfFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleResumePdf(f); };
    $('#imgFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleResumeImage(f); };
    $('#resumeAnyFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleResumeFile(f); };
    bindDropzone($('#resumeDrop'), handleResumeFile, $('#resumeAnyFile'));

    // 岗位 JD 截图的公共文件选择器（点击某岗位拖拽区时记录归属岗位）
    $('#jdImgFile').onchange = (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (f && state.ocrJobId) handleJdImage(f, state.ocrJobId);
    };

    // 阻止文件拖到页面空白处被浏览器直接打开
    ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, (e) => {
      if (e.target.closest && e.target.closest('.dropzone')) return;
      e.preventDefault();
    }));

    // Ctrl+V 粘贴截图：焦点在某岗位卡片内 → 该岗位 JD；否则 → 母版简历
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file' && /^image\//i.test(it.type)) {
          const f = it.getAsFile();
          if (!f) continue;
          e.preventDefault();
          const jobCard = (e.target.closest && e.target.closest('.job-card')) ||
            (document.activeElement && document.activeElement.closest && document.activeElement.closest('.job-card'));
          if (jobCard) handleJdImage(f, jobCard.dataset.job);
          else handleResumeFile(f);
          return;
        }
      }
    });

    // 粘贴文字导入母版
    $('#pasteBtn').onclick = () => {
      showPasteModal('粘贴简历全文（将作为母版，导入后只读）', state.master ? state.master.text : '', (text) => {
        if (text.trim().length < 20) { U.toast('内容太短，请粘贴完整简历'); return false; }
        setMaster(text, '粘贴的简历');
        U.toast('母版简历已导入');
        return true;
      });
    };

    // 清除母版（显式操作，需确认）
    $('#clearResume').onclick = () => {
      if (!confirm('清除母版简历？各岗位已生成的定制版记录也将失效。')) return;
      state.master = null;
      state.masterPdfBytes = null;
      state.blobCache = {};
      App.store.clearMaster();
      state.jobs.forEach(j => j.lastResult = null);
      persistJobs();
      $('#result').innerHTML = '';
      renderMaster(); renderJobs();
    };

    // 添加岗位
    $('#addJobBtn').onclick = () => addJob(true);

    // AI 设置
    $('#aiMode').onchange = (e) => { App.store.setAiMode(e.target.value); renderAiSetting(); };
    $('#aiEndpoint').onchange = (e) => App.store.setEndpoint(e.target.value.trim());
  }

  /* ================= 粘贴弹窗 ================= */
  function showPasteModal(title, def, onOk) {
    const root = document.getElementById('modalRoot');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal wide"><h3>' + U.escapeHtml(title) + '</h3>' +
      '<textarea id="pasteArea" rows="14" placeholder="把内容粘贴到这里…"></textarea>' +
      '<div class="modal-actions">' +
      '<button class="btn gray" data-act="cancel">取消</button>' +
      '<button class="btn" data-act="ok">确定</button>' +
      '</div></div>';
    root.appendChild(mask);
    const ta = mask.querySelector('#pasteArea');
    ta.value = def || '';
    setTimeout(() => ta.focus(), 30);
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.dataset.act === 'cancel') root.removeChild(mask);
      else if (e.target.dataset.act === 'ok') { if (onOk(ta.value) !== false) root.removeChild(mask); }
    });
  }

  /* ================= AI 设置 ================= */
  function renderAiSetting() {
    const mode = App.store.getAiMode();
    $('#aiMode').value = mode;
    $('#aiEndpoint').value = App.store.getEndpoint() || '';
    $('#endpointRow').style.display = mode === 'custom' ? '' : 'none';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
