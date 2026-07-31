/* ocr.js - 图片文字识别（挂载到 window.App.ocr）
 * 识别质量增强版：
 *   ① 图片预处理：自动放大（小截图放大到 ~1600px）+ 灰度 + 对比度拉伸 + Otsu 二值化
 *   ② 多轮识别选优：二值图 → 灰度图 → 原图，逐轮识别打分，置信度够高提前结束
 *   ③ 中文后处理：去掉 tesseract 在汉字间乱插的空格、修复手机号 O/0 误识别、压缩空行
 *
 * 降级链（2026-07-31 最终版）：
 *   移动端：原生 TextDetector API → Tesseract.js → endpoint → 粘贴文字
 *   桌面端：Tesseract.js → 原生 TextDetector → endpoint → 粘贴文字
 */
(function () {
  window.App = window.App || {};

  var CJK_RANGE = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff01-\\uff5e';

  /* ================= 文本后处理 ================= */
  function cleanOcrText(raw) {
    if (!raw) return '';
    var t = String(raw).replace(/\r/g, '');
    var re = new RegExp('([' + CJK_RANGE + '])[ \\t]+(?=[' + CJK_RANGE + '])', 'g');
    var prev;
    do { prev = t; t = t.replace(re, '$1'); } while (t !== prev);
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.replace(/1[3-9][\dOo]{9}/g, function (s) { return s.replace(/[Oo]/g, '0'); });
    t = t.replace(/[|｜丨]{2,}/g, '');
    t = t.split('\n').map(function (l) { return l.trim(); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  function textScore(t) {
    if (!t) return 0;
    var valid = (t.match(/[\u4e00-\u9fffA-Za-z0-9]/g) || []).length;
    var junk = (t.match(/[^\u4e00-\u9fffA-Za-z0-9\s，。：；、！？（）()【】《》\/\\\-+._@%#:;,'"""''·~*&=＋－]/g) || []).length;
    return valid - junk * 2;
  }

  /* ================= 图片预处理 ================= */
  function loadImage(fileOrUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = null, revoke = false;
      if (typeof fileOrUrl === 'string') url = fileOrUrl;
      else { url = URL.createObjectURL(fileOrUrl); revoke = true; }
      img.onload = function () { if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 5000); resolve(img); };
      img.onerror = function () { reject(new Error('图片加载失败')); };
      img.src = url;
    });
  }

  function preprocess(img, mode) {
    var MIN_SIDE = 1600, MAX_SIDE = 2600;
    var w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    var maxSide = Math.max(w0, h0);
    var scale = 1;
    if (maxSide < MIN_SIDE) scale = Math.min(3, MIN_SIDE / maxSide);
    else if (maxSide > MAX_SIDE) scale = MAX_SIDE / maxSide;
    var w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    var im = ctx.getImageData(0, 0, w, h);
    var d = im.data, n = d.length;
    var hist = new Array(256).fill(0);
    var i, g;
    for (i = 0; i < n; i += 4) {
      g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      hist[g]++;
    }
    var total = n / 4;
    var lo = 0, hi = 255, acc = 0, p2 = total * 0.02, p98 = total * 0.98;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= p2) { lo = i; break; } }
    acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= p98) { hi = i; break; } }
    if (hi <= lo) { lo = 0; hi = 255; }
    var range = hi - lo;
    var th = 128;
    if (mode === 'bw') th = otsu(hist, total);
    for (i = 0; i < n; i += 4) {
      g = d[i];
      if (mode === 'bw') { g = g > th ? 255 : 0; }
      else { g = (g - lo) * 255 / range; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; }
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, maxVar = 0, th = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; th = i; }
    }
    return th;
  }

  /* ================= 移动端检测与原生 OCR 降级 ================= */
  /*
   * 根因（2026-07-31 最终定位）：
   *   控制台日志链路：所有资源 HEAD 200 -> Worker 创建成功 ->
   *   [tesseract] loading tesseract core 0% 永久卡住
   *
   *   结论：Tesseract.js 的 ~4.5MB WebAssembly 模块在移动端浏览器编译时
   *         因内存限制（WASM 需要连续内存块）或编译超时而永久挂起。
   *         这不是网络/路径/CORS 问题，是设备能力问题。
   */

  var _isMobile = (function () {
    var ua = navigator.userAgent || '';
    var isAndroid = /android/i.test(ua);
    var isIOS = /iPad|iPhone|iPod/i.test(ua);
    var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var isSmallScreen = window.innerWidth < 768 || screen.width < 768;
    return (isTouch && isSmallScreen) || isAndroid || isIOS;
  })();

  /* TextDetector: Chrome 94+/Edge 94+, Android Chrome 支持, iOS Safari 不支持 */
  var _hasNativeOCR = typeof TextDetector === 'function';

  console.log('[ocr] 设备检测: isMobile=' + _isMobile + ', hasNativeOCR=' + _hasNativeOCR +
    ', UA=' + (navigator.userAgent || '').substring(0, 80));

  /* 原生 TextDetector OCR（零依赖，毫秒级，支持中英文） */
  async function _nativeOcr(image) {
    try {
      var imgEl;
      if (typeof image === 'string') {
        imgEl = await loadImage(image);
      } else if (image instanceof Blob || image instanceof File) {
        var bmp = await createImageBitmap(image);
        imgEl = bmp;
      } else {
        imgEl = image;
      }
      var detector = new TextDetector();
      var results = await detector.detect(imgEl);
      if (!results || results.length === 0) return null;
      // 按 y+x 排序还原阅读顺序
      results.sort(function (a, b) {
        var dy = a.boundingBox.y - b.boundingBox.y;
        if (Math.abs(dy) > 10) return dy;
        return a.boundingBox.x - b.boundingBox.x;
      });
      var text = results.map(function (r) { return r.rawValue; }).join('\n');
      return text.trim() || null;
    } catch (e) {
      console.warn('[ocr] 原生 TextDetector 失败:', e.message);
      return null;
    }
  }

  /* ================= tesseract worker（缓存复用） ================= */
  var _workerPromise = null;
  var _progressCb = null;

  var _basePath = (function () {
    var p = location.pathname || '/';
    var lastSlash = p.lastIndexOf('/');
    return p.substring(0, lastSlash + 1);
  })();
  function _abs(p) { return location.origin + _basePath + p.replace(/^\/+/, ''); }

  var TESS_OPTS = {
    workerPath: _abs('vendor/tesseract/worker.min.js'),
    corePath: _abs('vendor/tesseract/tesseract-core.wasm.js'),
    langPath: _abs('vendor/tesseract'),
    logger: function (m) {
      if (_progressCb && m && m.status === 'recognizing text') _progressCb(Math.round(m.progress * 100));
      else if (m && m.status) console.log('[tesseract]', m.status, m.progress != null ? Math.round(m.progress * 100) + '%' : '');
    }
  };

  var _initError = null;

  function _withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(msg || '操作超时')); }, ms);
      })
    ]);
  }

  function getWorker() {
    if (!window.Tesseract || !Tesseract.createWorker) return Promise.resolve(null);
    if (!_workerPromise) {
      _workerPromise = (function () {
        console.log('[ocr] 开始初始化 Tesseract worker...');
        console.log('[ocr] workerPath:', TESS_OPTS.workerPath);
        console.log('[ocr] corePath:', TESS_OPTS.corePath);
        console.log('[ocr] langPath:', TESS_OPTS.langPath);

        // 非阻塞诊断：预检资源可达性
        [TESS_OPTS.workerPath, TESS_OPTS.corePath,
         TESS_OPTS.langPath + '/chi_sim.traineddata.gz',
         TESS_OPTS.langPath + '/eng.traineddata.gz'
        ].forEach(function (u) {
          fetch(u, { method: 'HEAD', mode: 'same-origin', cache: 'no-cache' }).then(function (r) {
            console.log('[ocr] HEAD', r.status, u.split('/').pop());
          }).catch(function (e) {
            console.warn('[ocr] HEAD 失败:', u.split('/').pop(), e.message || e);
          });
        });

        // 尝试 chi_sim+eng（90s 超时）
        return _withTimeout(
          Tesseract.createWorker('chi_sim+eng', 1, TESS_OPTS),
          90000,
          'Tesseract 初始化超时(chi_sim+eng, 90s)'
        ).then(function (w) {
          console.log('[ocr] Worker 创建成功 (chi_sim+eng)');
          if (w && w.setParameters) {
            return w.setParameters({ preserve_interword_spaces: '1' }).then(function () { return w; }, function () { return w; });
          }
          return w;
        }).catch(function (e) {
          _initError = e;
          console.warn('[ocr] chi_sim+eng 失败:', e && e.message ? e.message : e);
          // 降级：仅 eng（60s 超时）
          console.log('[ocr] 降级尝试: eng only ...');
          return _withTimeout(
            Tesseract.createWorker('eng', 1, TESS_OPTS),
            60000,
            'Tesseract 初始化超时(eng, 60s)'
          ).then(function (w2) {
            console.log('[ocr] Worker 创建成功 (eng-only)');
            _initError = null;
            if (w2 && w2.setParameters) {
              return w2.setParameters({ preserve_interword_spaces: '1' }).then(function () { return w2; }, function () { return w2; });
            }
            return w2;
          }).catch(function (e2) {
            _initError = e2;
            console.error('[ocr] eng 也失败:', e2 && e2.message ? e2.message : e2);
            return null;
          });
        });
      })();
      _workerPromise.then(function (w) { if (!w) _workerPromise = null; });
    }
    return _workerPromise;
  }

  function recognizeOnce(image, onProgress) {
    _progressCb = onProgress || null;
    return getWorker().then(function (worker) {
      if (worker) return worker.recognize(image).then(function (r) { return r.data; });
      return Tesseract.recognize(image, 'chi_sim+eng', {
        logger: function (m) { if (onProgress && m.status === 'recognizing text') onProgress(Math.round(m.progress * 100)); }
      }).then(function (r) { return r.data; });
    });
  }

  /* ================= 主流程：多轮识别选优（含移动端降级） ================= */
  async function ocrImageText(fileOrUrl, onProgress) {
    var report = function (p, label) { if (onProgress) { try { onProgress(p, label); } catch (e) {} } };

    // ── 策略 1：移动端优先使用原生 TextDetector API ──
    if (_isMobile && _hasNativeOCR) {
      console.log('[ocr] 移动端 + 原生 OCR 可用，跳过 Tesseract WASM');
      report(10, '使用浏览器原生识别...');
      try {
        var nativeText = await _nativeOcr(fileOrUrl);
        if (nativeText && nativeText.length >= 2) {
          var cleaned = cleanOcrText(nativeText);
          if (textScore(cleaned) >= 3) {
            report(100, '识别完成');
            return { text: cleaned, via: 'native' };
          }
        }
      } catch (e) {
        console.warn('[ocr] 原生 OCR 结果不理想，继续尝试:', e.message);
      }
    }

    // ── 策略 2：Tesseract.js（桌面端主力）──
    if (window.Tesseract) {
      try {
        report(0, '预处理图片');
        var img = await loadImage(fileOrUrl);
        var passes = [];
        try { passes.push({ label: '二值增强', image: preprocess(img, 'bw') }); } catch (e) {}
        try { passes.push({ label: '灰度增强', image: preprocess(img, 'gray') }); } catch (e) {}
        passes.push({ label: '原图', image: fileOrUrl });

        var best = null;
        for (var i = 0; i < passes.length; i++) {
          var pass = passes[i];
          var data;
          try {
            data = await recognizeOnce(pass.image, function (p) { report(p, pass.label); });
          } catch (e) { continue; }
          var clean = cleanOcrText(data.text || '');
          var s = textScore(clean);
          var conf = data.confidence || 0;
          if (!best || s > best.score) best = { text: clean, score: s, conf: conf };
          if (conf >= 80 && s >= 20) break;
          if (s >= 120 && conf >= 70) break;
        }
        if (best && best.text.length >= 4) return { text: best.text, via: 'tesseract' };
        throw new Error('未识别到有效文字，请确认图片清晰、为正向文字截图');
      } catch (e) {
        console.warn('[ocr] tesseract 失败:', e.message);
      }
    }

    // ── 策略 3：非移动端也试试原生 API 兜底 ──
    if (!_isMobile && _hasNativeOCR) {
      try {
        report(50, '尝试原生识别...');
        var fbNative = await _nativeOcr(fileOrUrl);
        if (fbNative && fbNative.length >= 4) {
          return { text: cleanOcrText(fbNative), via: 'native-fallback' };
        }
      } catch (e) { /* ignore */ }
    }

    // ── 策略 4：自定义 endpoint ──
    var ep = App.store.getEndpoint();
    if (ep) {
      try {
        var dataUrl = typeof fileOrUrl === 'string' ? fileOrUrl : await App.util.readFileAsDataURL(fileOrUrl);
        var base64 = dataUrl.split(',')[1];
        var r = await fetch(ep, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'ocrText', payload: { imageBase64: base64 } })
        }).then(function (x) { return x.json(); });
        if (r && r.success && r.data && r.data.text) return { text: cleanOcrText(r.data.text), via: 'custom' };
      } catch (e2) { console.warn('[ocr] endpoint失败:', e2.message); }
    }

    // ── 全部失败 ──
    var errMsg = '图片识别当前不可用';
    if (_initError) {
      errMsg += '（' + (_initError.message || _initError) + '）';
    } else if (!window.Tesseract) {
      errMsg += '（Tesseract 库未加载，请检查网络后刷新页面）';
    } else if (_isMobile) {
      errMsg += '（手机端 WebAssembly 引擎受限）';
    } else {
      errMsg += '（引擎初始化失败）';
    }
    if (_isMobile) {
      errMsg += '\n\n手机端提示:';
      errMsg += '\n  推荐 Chrome 浏览器（支持原生识别，秒开）';
      errMsg += '\n  或直接用「粘贴文字」导入简历';
    } else {
      errMsg += '\n提示: 首次需下载 ~30MB 引擎文件，网络慢可能超时。建议 WiFi 下刷新重试。';
    }
    errMsg += '\n备选: 可直接使用「粘贴文字」功能导入简历内容。';
    throw new Error(errMsg);
  }

  async function recognizeResumeImage(fileOrUrl, onProgress) {
    var res = await ocrImageText(fileOrUrl, onProgress);
    var structured = App.pdfParse.structureResume(res.text);
    return { structured, text: res.text, via: res.via };
  }

  App.ocr = { ocrImageText, recognizeResumeImage, cleanOcrText, textScore };
})();
