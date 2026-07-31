/* pdfLite.js - 零依赖 PDF 文本提取（挂载到 window.App.pdfLite）
 * ----------------------------------------------------------------
 * 移植自小程序版（经 Node 真实 PDF 用例测试通过）：
 *   1. inflate：纯 JS 实现 DEFLATE 解压（stored / fixed / dynamic Huffman），自动跳过 zlib 头
 *   2. 流提取：indexOf 扫描 stream...endstream（不用正则，避免二进制误伤）
 *   3. ToUnicode CMap：beginbfchar / beginbfrange（含数组形式）
 *   4. 内容流 tokenizer：Tj / TJ / ' / " 操作符；literal 与 hex 字符串都支持
 *   5. 按字体字典判别单/双字节编码（Type0/Identity-H/UniGB/CIDFont → 双字节）
 * 适用：Word / WPS / 招聘平台导出的文字型 PDF；扫描件（图片型）无文字层，请走图片识别。 */
(function () {
  window.App = window.App || {};

  /* ==================== 1. inflate（RFC 1951） ==================== */
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function BitReader(buf) { this.buf = buf; this.pos = 0; this.bit = 0; }
  BitReader.prototype.readBits = function (n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error('inflate: 数据越界');
      var b = (this.buf[this.pos] >> this.bit) & 1;
      v |= b << i;
      this.bit++;
      if (this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  };
  BitReader.prototype.align = function () { if (this.bit !== 0) { this.bit = 0; this.pos++; } };

  function buildHuffman(lengths) {
    var maxLen = Math.max.apply(null, lengths.concat([0]));
    var blCount = new Array(maxLen + 1).fill(0);
    for (var i = 0; i < lengths.length; i++) if (lengths[i]) blCount[lengths[i]]++;
    var nextCode = new Array(maxLen + 1).fill(0);
    var code = 0;
    for (var len = 1; len <= maxLen; len++) { code = (code + blCount[len - 1]) << 1; nextCode[len] = code; }
    var map = {};
    for (var sym = 0; sym < lengths.length; sym++) {
      var l = lengths[sym];
      if (!l) continue;
      var c = nextCode[l]++;
      if (!map[l]) map[l] = {};
      map[l][c] = sym;
    }
    return { map: map, maxLen: maxLen };
  }

  function huffDecode(reader, table) {
    var code = 0, len = 0;
    while (len < table.maxLen) {
      code = (code << 1) | reader.readBits(1);
      len++;
      var row = table.map[len];
      if (row && row[code] !== undefined) return row[code];
    }
    throw new Error('inflate: Huffman 解码失败');
  }

  var FIXED_LIT = null, FIXED_DIST = null;
  function getFixedTables() {
    if (FIXED_LIT) return { lit: FIXED_LIT, dist: FIXED_DIST };
    var litLen = new Array(288);
    for (var i = 0; i <= 143; i++) litLen[i] = 8;
    for (i = 144; i <= 255; i++) litLen[i] = 9;
    for (i = 256; i <= 279; i++) litLen[i] = 7;
    for (i = 280; i <= 287; i++) litLen[i] = 8;
    FIXED_LIT = buildHuffman(litLen);
    FIXED_DIST = buildHuffman(new Array(30).fill(5));
    return { lit: FIXED_LIT, dist: FIXED_DIST };
  }

  function inflate(data) {
    var offset = 0;
    // zlib 头（CMF/FLG 校验）：FlateDecode 流普遍带 2 字节 zlib 头，必须跳过
    if (data.length > 2 && (data[0] & 0x0F) === 8 && ((data[0] << 8 | data[1]) % 31) === 0) offset = 2;
    var r0 = tryInflate(data, offset);
    if (r0.ok) return r0.out;
    if (offset === 2) {
      var r1 = tryInflate(data, 0); // 兼容裸 deflate
      if (r1.ok) return r1.out;
    }
    throw new Error('inflate: 解压失败');
  }

  function tryInflate(data, offset) {
    try {
      var reader = new BitReader(data);
      reader.pos = offset;
      var out = [];
      var lastBlock = false;
      while (!lastBlock) {
        lastBlock = reader.readBits(1) === 1;
        var btype = reader.readBits(2);
        if (btype === 0) {
          reader.align();
          var slen = data[reader.pos] | (data[reader.pos + 1] << 8);
          reader.pos += 4;
          for (var i = 0; i < slen; i++) out.push(data[reader.pos++]);
        } else if (btype === 1 || btype === 2) {
          var litTable, distTable;
          if (btype === 1) {
            var t = getFixedTables();
            litTable = t.lit; distTable = t.dist;
          } else {
            var hlit = reader.readBits(5) + 257;
            var hdist = reader.readBits(5) + 1;
            var hclen = reader.readBits(4) + 4;
            var clenLen = new Array(19).fill(0);
            for (i = 0; i < hclen; i++) clenLen[CLEN_ORDER[i]] = reader.readBits(3);
            var clenTable = buildHuffman(clenLen);
            var allLen = new Array(hlit + hdist).fill(0);
            var idx = 0;
            while (idx < hlit + hdist) {
              var sym = huffDecode(reader, clenTable);
              if (sym <= 15) allLen[idx++] = sym;
              else if (sym === 16) { var rep = reader.readBits(2) + 3; var prev = allLen[idx - 1]; for (i = 0; i < rep; i++) allLen[idx++] = prev; }
              else if (sym === 17) { rep = reader.readBits(3) + 3; for (i = 0; i < rep; i++) allLen[idx++] = 0; }
              else { rep = reader.readBits(7) + 11; for (i = 0; i < rep; i++) allLen[idx++] = 0; }
            }
            litTable = buildHuffman(allLen.slice(0, hlit));
            distTable = buildHuffman(allLen.slice(hlit));
          }
          for (;;) {
            var s2 = huffDecode(reader, litTable);
            if (s2 === 256) break;
            if (s2 < 256) out.push(s2);
            else {
              var li = s2 - 257;
              var mlen = LEN_BASE[li] + reader.readBits(LEN_EXTRA[li]);
              var dsym = huffDecode(reader, distTable);
              var dist = DIST_BASE[dsym] + reader.readBits(DIST_EXTRA[dsym]);
              var start = out.length - dist;
              for (i = 0; i < mlen; i++) out.push(out[start + i]);
            }
          }
        } else throw new Error('inflate: 非法块类型');
      }
      return { ok: true, out: Uint8Array.from(out) };
    } catch (e) { return { ok: false, out: null }; }
  }

  /* ==================== 2. PDF 流提取 ==================== */
  function bytesToLatin1(bytes) {
    var s = '';
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return s;
  }

  function extractStreams(buf) {
    var raw = bytesToLatin1(buf);
    var streams = [];
    var idx = 0;
    for (;;) {
      var sPos = raw.indexOf('stream', idx);
      if (sPos < 0) break;
      var dStart = sPos + 6;
      if (raw[dStart] === '\r' && raw[dStart + 1] === '\n') dStart += 2;
      else if (raw[dStart] === '\n' || raw[dStart] === '\r') dStart += 1;
      var ePos = raw.indexOf('endstream', dStart);
      if (ePos < 0) break;
      var dEnd = ePos;
      while (dEnd > dStart && (raw[dEnd - 1] === '\r' || raw[dEnd - 1] === '\n')) dEnd--;
      var dictStart = raw.lastIndexOf('obj', sPos);
      var dictText = dictStart >= 0 ? raw.slice(dictStart, sPos) : raw.slice(Math.max(0, sPos - 500), sPos);
      streams.push({ dictText: dictText, data: buf.subarray(dStart, dEnd), flate: /FlateDecode/.test(dictText) });
      idx = ePos + 9;
    }
    return streams;
  }

  /* ==================== 3. ToUnicode CMap ==================== */
  function hexToBytes(hex) {
    var out = [];
    var h = hex.replace(/\s+/g, '');
    for (var i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }

  function utf16beToString(bytes) {
    var s = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1]);
    return s;
  }

  function parseToUnicode(cmapText) {
    var map = new Map();
    var bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    var m, p;
    while ((m = bfcharRe.exec(cmapText)) !== null) {
      var pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      while ((p = pairRe.exec(m[1])) !== null) {
        map.set(parseInt(p[1], 16), utf16beToString(hexToBytes(p[2])));
      }
    }
    var bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrangeRe.exec(cmapText)) !== null) {
      var simpleRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      while ((p = simpleRe.exec(m[1])) !== null) {
        var start = parseInt(p[1], 16), end = parseInt(p[2], 16);
        var dstBytes = hexToBytes(p[3]);
        for (var c = start; c <= end; c++) {
          var b = dstBytes.slice();
          if (b.length >= 2) {
            var v = ((b[b.length - 2] << 8) | b[b.length - 1]) + (c - start);
            b[b.length - 2] = (v >> 8) & 0xFF;
            b[b.length - 1] = v & 0xFF;
          } else if (b.length === 1) b[0] = (b[0] + (c - start)) & 0xFF;
          map.set(c, utf16beToString(b));
        }
      }
      var arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
      while ((p = arrRe.exec(m[1])) !== null) {
        var st2 = parseInt(p[1], 16);
        var itemRe = /<([0-9A-Fa-f]+)>/g;
        var q, i2 = 0;
        while ((q = itemRe.exec(p[3])) !== null) { map.set(st2 + i2, utf16beToString(hexToBytes(q[1]))); i2++; }
      }
    }
    return map;
  }

  /* ==================== 4. 内容流文字提取 ==================== */
  function extractTextFromContent(content, cmap, fontIsCid) {
    var out = '';
    var i = 0;
    var n = content.length;
    var operands = [];
    var curFont = '';

    function isWs(c) { return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\x00'; }

    function decodeStringBytes(bytes) {
      if (!bytes || !bytes.length) return '';
      var cid = fontIsCid[curFont];
      if (cid === undefined) {
        var zeros = 0;
        var pairs = Math.max(1, Math.floor(bytes.length / 2));
        for (var k = 0; k + 1 < bytes.length; k += 2) if (bytes[k] === 0) zeros++;
        cid = pairs > 0 && zeros / pairs > 0.25;
      }
      var s = '';
      if (cid) {
        for (k = 0; k + 1 < bytes.length; k += 2) {
          var code = (bytes[k] << 8) | bytes[k + 1];
          if (cmap.has(code)) { s += cmap.get(code); continue; }
          if (code === 0) continue;
          s += String.fromCharCode(code);
        }
        return s;
      }
      for (var j = 0; j < bytes.length; j++) {
        var b = bytes[j];
        if (cmap.has(b)) { s += cmap.get(b); continue; }
        if (b >= 0x20 && b <= 0x7E) s += String.fromCharCode(b);
      }
      return s;
    }

    function readLiteral() {
      var bytes = [];
      var depth = 1;
      i++;
      while (i < n && depth > 0) {
        var c = content[i];
        if (c === '\\') {
          var nc = content[i + 1];
          if (nc === 'n') { bytes.push(10); i += 2; }
          else if (nc === 'r') { bytes.push(13); i += 2; }
          else if (nc === 't') { bytes.push(9); i += 2; }
          else if (nc === '(') { bytes.push(40); i += 2; }
          else if (nc === ')') { bytes.push(41); i += 2; }
          else if (nc === '\\') { bytes.push(92); i += 2; }
          else if (nc >= '0' && nc <= '7') {
            var oct = nc; var k = i + 2;
            while (k < i + 4 && k < n && content[k] >= '0' && content[k] <= '7') { oct += content[k]; k++; }
            bytes.push(parseInt(oct, 8) & 0xFF); i = k;
          } else if (nc === '\r' || nc === '\n') {
            i += 2;
            if (nc === '\r' && content[i] === '\n') i++;
          } else { bytes.push(nc.charCodeAt(0) & 0xFF); i += 2; }
        } else if (c === '(') { depth++; bytes.push(40); i++; }
        else if (c === ')') { depth--; if (depth > 0) bytes.push(41); i++; }
        else { bytes.push(c.charCodeAt(0) & 0xFF); i++; }
      }
      return bytes;
    }

    function readHex() {
      var hex = '';
      i++;
      while (i < n && content[i] !== '>') {
        if (!isWs(content[i])) hex += content[i];
        i++;
      }
      i++;
      if (hex.length % 2 === 1) hex += '0';
      return hexToBytes(hex);
    }

    function readArray() {
      var strings = [];
      i++;
      while (i < n && content[i] !== ']') {
        var c = content[i];
        if (c === '(') strings.push(readLiteral());
        else if (c === '<' && content[i + 1] !== '<') strings.push(readHex());
        else i++;
      }
      i++;
      return strings;
    }

    while (i < n) {
      var c2 = content[i];
      if (isWs(c2)) { i++; continue; }
      if (c2 === '%') { while (i < n && content[i] !== '\n') i++; continue; }
      if (c2 === '(') { operands.push({ type: 'str', bytes: readLiteral() }); continue; }
      if (c2 === '<' && content[i + 1] !== '<') { operands.push({ type: 'str', bytes: readHex() }); continue; }
      if (c2 === '[') { operands.push({ type: 'arr', strings: readArray() }); continue; }
      if (c2 === '/') {
        var name = '';
        i++;
        while (i < n && !isWs(content[i]) && content[i] !== '/' && content[i] !== '[' && content[i] !== '(' && content[i] !== '<') { name += content[i]; i++; }
        operands.push({ type: 'name', name: name });
        continue;
      }
      var tok = '';
      while (i < n && !isWs(content[i]) && content[i] !== '(' && content[i] !== '[' && content[i] !== '<' && content[i] !== '%' && content[i] !== '/') { tok += content[i]; i++; }
      if (!tok) { i++; continue; }
      if (/^[+-]?[\d.]+$/.test(tok)) { operands.push({ type: 'num' }); continue; }
      if (tok === 'Tf') {
        var nameOp = operands.filter(function (o) { return o.type === 'name'; }).pop();
        if (nameOp) curFont = nameOp.name;
        operands.length = 0;
      } else if (tok === 'Tj' || tok === "'" || tok === '"') {
        var op = operands[operands.length - 1];
        if (op && op.type === 'str') out += decodeStringBytes(op.bytes);
        operands.length = 0;
      } else if (tok === 'TJ') {
        op = operands[operands.length - 1];
        if (op && op.type === 'arr') {
          for (var si = 0; si < op.strings.length; si++) out += decodeStringBytes(op.strings[si]);
        }
        operands.length = 0;
      } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
        out += '\n';
        operands.length = 0;
      } else operands.length = 0;
    }
    return out;
  }

  /* ==================== 5. 主入口 ==================== */
  function extractPdfText(data) {
    var buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    var streams = extractStreams(buf);

    var decoded = [];
    for (var si = 0; si < streams.length; si++) {
      var st = streams[si];
      var d = st.data;
      if (st.flate) {
        try { d = inflate(st.data); } catch (e) { continue; }
      }
      decoded.push({ dictText: st.dictText, text: bytesToLatin1(d) });
    }

    // 汇总 ToUnicode 映射
    var cmap = new Map();
    for (var di = 0; di < decoded.length; di++) {
      if (/beginbfchar|beginbfrange/.test(decoded[di].text)) {
        parseToUnicode(decoded[di].text).forEach(function (v, k) { cmap.set(k, v); });
      }
    }

    // 字体资源名 → 是否双字节(CID)
    var raw = bytesToLatin1(buf);
    var fontIsCid = {};
    var refRe = /\/(F[\w\d]+)\s+(\d+)\s+0\s+R/g;
    var fm;
    while ((fm = refRe.exec(raw)) !== null) {
      if (fontIsCid[fm[1]] !== undefined) continue;
      var objRe = new RegExp('\\b' + fm[2] + '\\s+0\\s+obj([\\s\\S]*?)endobj');
      var om = raw.match(objRe);
      if (om) fontIsCid[fm[1]] = /\/Subtype\s*\/Type0|\/Identity-H|\/UniGB|\/CIDFont/i.test(om[1]);
    }

    // 内容流提取
    var text = '';
    for (di = 0; di < decoded.length; di++) {
      var t = decoded[di].text;
      if (/beginbfchar|beginbfrange|begincmap/.test(t)) continue;
      if (!/BT|Tj|TJ/.test(t)) continue;
      text += extractTextFromContent(t, cmap, fontIsCid) + '\n';
    }
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  App.pdfLite = { extractPdfText: extractPdfText, inflate: inflate };
})();
