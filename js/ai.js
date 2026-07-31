/* ai.js - AI 调用封装（挂载到 window.App.ai）
 * 模式：local（内置规则 Mock，开箱即用）/ custom（你自己的 aiProxy 协议服务器）
 * 协议（custom）：POST {action, payload} -> {success:true, data:{...}} */
(function () {
  window.App = window.App || {};
  const store = () => App.store;

  function call(action, payload) {
    const mode = store().getAiMode();
    if (mode === 'local') return mock(action, payload);
    // custom
    const ep = store().getEndpoint();
    if (!ep) return Promise.reject(new Error('未配置自定义 AI 服务器，请在「AI 设置」填写服务器地址，或切回本地演示'));
    return fetch(ep, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, payload })
    }).then(r => r.json()).then(d => {
      if (d && d.success) return d.data;
      throw new Error((d && d.error) || '自定义服务器返回异常');
    });
  }

  /* ---------------- Mock 实现 ---------------- */
  const SKILL_DB = ['python', 'java', 'javascript', 'react', 'vue', 'node', 'sql', 'mysql', 'linux', 'docker', 'kubernetes', 'aws', 'excel', 'ppt', '数据分析', '产品', '运营', '项目管理', 'prd', 'axure', 'figma', 'go', 'c++', 'java', '机器学习', '深度学习', 'nlp', 'java', 'spring', 'redis', 'kafka', '沟通', '团队', 'leader', '增长', '用户', '增长黑客', 'sql', 'tableau', 'powerbi', 'go'];

  function tokenize(s) {
    s = (s || '').toLowerCase();
    const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const en = s.match(/[a-z]{2,}/g) || [];
    return cjk.concat(en);
  }

  function mockParseJD(text) {
    const t = text || '';
    const toks = tokenize(t);
    const skills = SKILL_DB.filter(s => t.toLowerCase().includes(s.toLowerCase()));
    const uniq = Array.from(new Set(skills.map(s => s.toLowerCase()))).map(s => s.toUpperCase().slice(0, 0) + s);
    // 硬性要求：含"本科/硕士/年/经验/证书"等
    const hard = [];
    if (/本科|大专|硕士|博士/.test(t)) hard.push('学历要求：' + (t.match(/本科|大专|硕士|博士/)[0]));
    const yExp = t.match(/(\d+)\s*年/); if (yExp) hard.push('经验要求：' + yExp[0] + '以上相关经验');
    ['证书', '资格证', '驾照', '英语'].forEach(k => { if (t.includes(k)) hard.push('硬性条件：' + k); });
    // 软性能力
    const soft = [];
    ['沟通', '协作', '抗压', '学习', '主动', '责任心', '团队', 'leadership', '领导'].forEach(k => { if (t.includes(k)) soft.push(k + '能力'); });
    // 关键词（取高频中文词）
    const freq = {}; toks.forEach(w => { if (w.length >= 2) freq[w] = (freq[w] || 0) + 1; });
    const keywords = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 12);
    // 淘汰红线
    const red = [];
    ['不符', '不满足', '一票否决', '必须', '红线', '优先'].forEach(k => { if (t.includes(k)) red.push('红线关键词：' + k); });
    if (!red.length) red.push('未在 JD 中明确红线，建议突出与岗位强相关的量化成果');
    return {
      summary: t.slice(0, 80) + (t.length > 80 ? '…' : ''),
      hardSkills: hard.length ? hard : ['（本地模型未能识别硬性要求，建议手动补充）'],
      softSkills: soft.length ? soft : ['（建议补充沟通/协作等软性能力）'],
      painPoints: ['解决业务痛点：' + (keywords[0] || '核心业务')],
      keywords, redlines: red,
      _mock: true
    };
  }

  function mockOptimize(resume, jdText) {
    const exps = (resume && resume.experiences) || [];
    const items = [];
    exps.slice(0, 5).forEach((e, i) => {
      const desc = (e.description || '').trim();
      const org = e.company || e.role || ('经历' + (i + 1));
      const suggestion = buildStartSuggestion(e, jdText);
      items.push({
        id: 'opt_' + i, section: '经历', ref: org,
        original: desc || '（该项暂无描述）',
        suggestion, framework: 'STAR', dimension: '经历优化', adopted: false
      });
    });
    if (resume && resume.summary && resume.summary.trim()) {
      items.push({
        id: 'opt_sum', section: '自我评价', ref: '自我评价',
        original: resume.summary.trim(),
        suggestion: '围绕目标岗位核心关键词重写：突出' + (tokenize(jdText).slice(0, 3).join('/') || '岗位能力') + '，并以量化成果收尾。',
        framework: 'STAR', dimension: '摘要优化', adopted: false
      });
    }
    if (!items.length) {
      items.push({
        id: 'opt_gen', section: '通用', ref: '整体',
        original: '（暂无经历内容）',
        suggestion: '建议先补充工作经历，再针对 JD 关键词逐条做 STAR 改写。',
        framework: 'STAR', dimension: '提示', adopted: false
      });
    }
    return { items, _mock: true };
  }

  function buildStartSuggestion(e, jdText) {
    const kws = tokenize(jdText).slice(0, 3);
    const kwStr = kws.length ? kws.join('、') : '岗位核心能力';
    return [
      '【情境 S】在' + (e.company || '所在团队') + '负责' + (e.role || '相关工作') + '期间，面临' + kwStr + '相关的业务需求；',
      '【任务 T】需要在有限资源下交付可衡量的结果；',
      '【行动 A】主导/参与具体方案落地，运用' + kwStr + '等方法推进；',
      '【结果 R】建议补充量化指标（如效率提升 X%、成本下降 Y、用户增长 Z）。'
    ].join('\n');
  }

  function mockMatch(resume, jdText) {
    const rText = resumeText(resume);
    const rToks = tokenize(rText), jToks = tokenize(jdText);
    const rSet = new Set(rToks), jSet = new Set(jToks);
    let hit = 0; jSet.forEach(w => { if (rSet.has(w)) hit++; });
    const coverage = jSet.size ? Math.round(hit / jSet.size * 100) : 0;
    const skillHit = SKILL_DB.filter(s => jdText.toLowerCase().includes(s.toLowerCase()) && rText.toLowerCase().includes(s.toLowerCase())).length;
    const skillTotal = SKILL_DB.filter(s => jdText.toLowerCase().includes(s.toLowerCase())).length || 1;
    const skillScore = Math.min(100, Math.round(skillHit / skillTotal * 100));
    const expScore = Math.min(100, 50 + (resume && resume.experiences ? resume.experiences.length * 12 : 0));
    const eduScore = /本科|硕士|博士/.test(rText) ? 80 : 60;
    const potential = Math.round((coverage + skillScore) / 2 * 0.7 + 30 * 0.3 > 100 ? 100 : (coverage + skillScore) / 2 * 0.7 + 30 * 0.3);
    const scores = {
      skill: skillScore, exp: expScore, edu: eduScore,
      keyword: coverage, potential: potential
    };
    const overall = Math.round((scores.skill + scores.exp + scores.edu + scores.keyword + scores.potential) / 5);
    // 缺口
    const gaps = Array.from(jSet).filter(w => !rSet.has(w)).slice(0, 8);
    return {
      scores, overall,
      gaps: gaps.length ? gaps : ['无明显关键词缺口'],
      advice: [
        '提升关键词覆盖率至 70%+：在经历中自然嵌入 JD 高频词。',
        '为每条经历补齐量化结果（R），这是面试官最关注的。',
        '自我评价段直接呼应岗位核心能力。'
      ],
      _mock: true
    };
  }

  function resumeText(r) {
    if (!r) return '';
    return [r.basic && r.basic.target, r.skills, r.summary,
      (r.experiences || []).map(e => e.role + e.company + e.description).join(' '),
      (r.projects || []).map(p => p.name + p.description).join(' ')].join(' ');
  }

  function mock(action, payload) {
    if (action === 'parseJD') return Promise.resolve(mockParseJD(payload.text));
    if (action === 'optimizeStart') return Promise.resolve(mockOptimize(payload.resume, payload.jdText));
    if (action === 'analyzeMatch') return Promise.resolve(mockMatch(payload.resume, payload.jdText));
    if (action === 'ocrText') return Promise.resolve({ text: payload.fallback || '' });
    return Promise.reject(new Error('未知 action: ' + action));
  }

  App.ai = {
    call,
    parseJD: (text) => call('parseJD', { text }),
    optimizeStart: (resume, jdText) => call('optimizeStart', { resume, jdText }),
    analyzeMatch: (resume, jdText) => call('analyzeMatch', { resume, jdText }),
    ocrText: (payload) => call('ocrText', payload)
  };
})();
