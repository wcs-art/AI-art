/* store.js - 本地存储（母版 + 多岗位定制架构）
 * 核心原则：母版简历（MASTER）一经导入即只读，任何优化都不写回母版；
 * 每个岗位（JOB）保存自己的 JD 与最近一次生成结果，互不影响。 */
(function () {
  window.App = window.App || {};
  const KEY = {
    AIMODE: 'AI_MODE',
    ENDPOINT: 'AI_ENDPOINT',
    MASTER: 'MASTER_RESUME',   // { text, resume, name, importedAt }
    JOBS: 'JOB_LIST',          // [{ id, title, jdText, createdAt, lastResult:{text,applied,missed,mock,at} }]
    DRAFT: 'START_DRAFT'       // 旧版草稿（仅用于一次性迁移）
  };

  function get(k, def) {
    try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  const store = {};

  /* ---------- AI 模式 ---------- */
  store.getAiMode = () => get(KEY.AIMODE, 'local'); // local / custom
  store.setAiMode = (m) => set(KEY.AIMODE, m);
  store.getEndpoint = () => get(KEY.ENDPOINT, '');
  store.setEndpoint = (e) => set(KEY.ENDPOINT, e);

  /* ---------- 母版简历（只读原则：只有显式重新导入才会整体替换） ---------- */
  store.getMaster = () => get(KEY.MASTER, null);
  store.setMaster = (m) => set(KEY.MASTER, m);
  store.clearMaster = () => { localStorage.removeItem(KEY.MASTER); store.clearMasterPdf(); };

  /* ---------- 母版原始 PDF 文件（用于"原版式重写"导出；base64 存储，超限时仅本次会话可用） ---------- */
  const PDF_KEY = 'MASTER_PDF_B64';
  store.setMasterPdf = function (uint8) {
    let b64 = '';
    try {
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < uint8.length; i += CH)
        s += String.fromCharCode.apply(null, uint8.subarray(i, i + CH));
      b64 = btoa(s);
    } catch (e) { return false; }
    try { localStorage.setItem(PDF_KEY, b64); return true; }
    catch (e) {                        // 超出 localStorage 容量：清掉旧值，仅内存保留
      try { localStorage.removeItem(PDF_KEY); } catch (e2) { }
      return false;
    }
  };
  store.getMasterPdf = function () {
    try {
      const b64 = localStorage.getItem(PDF_KEY);
      if (!b64) return null;
      const s = atob(b64);
      const u = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return u;
    } catch (e) { return null; }
  };
  store.clearMasterPdf = function () { try { localStorage.removeItem(PDF_KEY); } catch (e) { } };

  /* ---------- 岗位列表 ---------- */
  store.getJobs = () => get(KEY.JOBS, []);
  store.saveJobs = (list) => set(KEY.JOBS, list || []);

  /* ---------- 旧版草稿迁移（一次性）：把旧的简历/JD 迁到新结构 ---------- */
  store.migrateOldDraft = function () {
    const old = get(KEY.DRAFT, null);
    if (!old) return;
    if (!store.getMaster() && old.resumeText && old.resumeText.trim().length >= 20) {
      store.setMaster({
        text: old.resumeText,
        resume: old.resume || null,
        name: (old.resume && old.resume.name) || '我的简历',
        importedAt: Date.now()
      });
    }
    if (!store.getJobs().length && old.jdText && old.jdText.trim().length >= 10) {
      store.saveJobs([{
        id: App.util.uid('job'), title: '目标岗位 1',
        jdText: old.jdText, createdAt: Date.now(), lastResult: null
      }]);
    }
    localStorage.removeItem(KEY.DRAFT);
  };

  /* ---------- 空简历模板（pdfParse.structureResume 依赖） ---------- */
  store.blankResume = function (name) {
    return {
      id: App.util.uid('res'), name: name || '未命名简历',
      basic: { name: '', phone: '', email: '', target: '' },
      education: [], experiences: [], projects: [], skills: '', summary: '',
      createdAt: App.util.now(), updatedAt: App.util.now(),
      tailored: null
    };
  };

  App.store = store;
})();
