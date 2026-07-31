/* util.js - 全局工具（挂载到 window.App.util） */
(function () {
  window.App = window.App || {};
  const util = {};

  util.uid = function (prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  util.now = function () { return new Date().toISOString(); };

  util.fmtDate = function (d) {
    d = d ? new Date(d) : new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  util.escapeHtml = function (s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  let toastTimer = null;
  util.toast = function (msg, ms) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  };

  // 确认弹窗，返回 Promise<boolean>
  util.confirm = function (title, body, okText, cancelText) {
    return new Promise(resolve => {
      const root = document.getElementById('modalRoot');
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal"><h3>' + util.escapeHtml(title || '确认') + '</h3>' +
        (body ? '<div style="color:var(--ink-2)">' + body + '</div>' : '') +
        '<div class="modal-actions">' +
        '<button class="btn gray" data-act="cancel">' + (cancelText || '取消') + '</button>' +
        '<button class="btn" data-act="ok">' + (okText || '确定') + '</button>' +
        '</div></div>';
      root.appendChild(mask);
      mask.addEventListener('click', e => {
        if (e.target === mask || e.target.dataset.act === 'cancel') { root.removeChild(mask); resolve(false); }
        else if (e.target.dataset.act === 'ok') { root.removeChild(mask); resolve(true); }
      });
    });
  };

  // 输入弹窗，返回 Promise<string|null>
  util.prompt = function (title, placeholder, def) {
    return new Promise(resolve => {
      const root = document.getElementById('modalRoot');
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML =
        '<div class="modal"><h3>' + util.escapeHtml(title || '输入') + '</h3>' +
        '<input id="promptInput" placeholder="' + util.escapeHtml(placeholder || '') + '" value="' + util.escapeHtml(def || '') + '" />' +
        '<div class="modal-actions">' +
        '<button class="btn gray" data-act="cancel">取消</button>' +
        '<button class="btn" data-act="ok">确定</button>' +
        '</div></div>';
      root.appendChild(mask);
      const inp = mask.querySelector('#promptInput');
      setTimeout(() => inp && inp.focus(), 30);
      mask.addEventListener('click', e => {
        if (e.target === mask || e.target.dataset.act === 'cancel') { root.removeChild(mask); resolve(null); }
        else if (e.target.dataset.act === 'ok') { root.removeChild(mask); resolve(inp.value.trim()); }
      });
    });
  };

  // 文件读取
  util.readFileAsArrayBuffer = function (file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
  };
  util.readFileAsDataURL = function (file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  };
  util.readFileAsText = function (file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });
  };

  // 下载
  util.download = function (blobOrUrl, filename) {
    const a = document.createElement('a');
    a.href = (blobOrUrl instanceof Blob) ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    if (blobOrUrl instanceof Blob) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // 防抖
  util.debounce = function (fn, ms) {
    let t; return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms || 300); };
  };

  // 简易 markdown 文本渲染（用于 AI 结果展示）
  util.pretty = function (s) {
    return util.escapeHtml(s || '').replace(/\n/g, '<br/>');
  };

  App.util = util;
})();
