'use strict';

/* =========================================================
   鼎談 TEIDAN — 3つのAIが話し合って結論を出す
   APIキーはこの端末の中だけで扱う（合言葉で AES-GCM 暗号化）
   ========================================================= */

const VAULT_KEY = 'teidan.vault.v1';
const PREFS_KEY = 'teidan.prefs.v1';
const CALL_TIMEOUT_MS = 240000;

const PROVIDERS = {
  claude: { name: 'Claude', mark: 'C', fallbackModel: 'claude-opus-5-5' },
  openai: { name: 'ChatGPT', mark: 'G', fallbackModel: 'gpt-5' },
  gemini: { name: 'Gemini', mark: 'Gm', fallbackModel: 'gemini-pro-latest' },
};
const ORDER = ['claude', 'openai', 'gemini'];

const state = {
  keys: { claude: '', openai: '', gemini: '' },
  prefs: loadPrefs(),
  passphrase: null,      // 合言葉（保存する場合のみ、開いている間だけメモリに保持）
  saveLocal: true,
  running: null,         // AbortController
  log: null,             // 直近の話し合いの記録
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- 保存（設定・暗号化された鍵） ---------------- */

function loadPrefs() {
  const base = { models: {}, modelLists: {}, enabled: { claude: true, openai: true, gemini: true }, rounds: '2', moderator: 'claude' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return Object.assign(base, JSON.parse(raw));
  } catch (_) { /* 読めなくても既定値で動く */ }
  return base;
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (_) {}
}
function hasVault() {
  try { return !!localStorage.getItem(VAULT_KEY); } catch (_) { return false; }
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sealVault(keys, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(keys)));
  localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}
async function openVault(pass) {
  const box = JSON.parse(localStorage.getItem(VAULT_KEY));
  const k = await deriveKey(pass, unb64(box.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
function wipeVault() {
  try { localStorage.removeItem(VAULT_KEY); } catch (_) {}
}

/* ---------------- API 呼び出し ---------------- */

class ApiError extends Error {
  constructor(status, detail) { super(detail || `HTTP ${status}`); this.status = status; this.detail = detail; }
}

function withTimeout(outer, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const onAbort = () => ctrl.abort(outer.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); outer && outer.removeEventListener('abort', onAbort); } };
}

async function request(url, opts, signal) {
  const t = withTimeout(signal, CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: t.signal, referrerPolicy: 'no-referrer', credentials: 'omit' }));
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (!res.ok) {
      const detail = body && (body.error && (body.error.message || body.error.type)) || (body && body.message) || text.slice(0, 300);
      throw new ApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return body;
  } finally {
    t.done();
  }
}

const api = {
  claude: {
    headers(key) {
      return {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
    },
    async chat(key, model, system, user, signal) {
      const body = await request('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: this.headers(key),
        body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
      }, signal);
      return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    },
    async models(key) {
      const body = await request('https://api.anthropic.com/v1/models?limit=100', { headers: this.headers(key) });
      return (body.data || []).map((m) => m.id);
    },
    pick(ids) {
      return ids.find((id) => /opus/.test(id)) || ids.find((id) => /sonnet/.test(id)) || ids[0];
    },
  },

  openai: {
    headers(key) {
      return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    },
    async chat(key, model, system, user, signal) {
      const body = await request('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: this.headers(key),
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      }, signal);
      const c = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      return (Array.isArray(c) ? c.map((p) => p.text || '').join('') : (c || '')).trim();
    },
    async models(key) {
      const body = await request('https://api.openai.com/v1/models', { headers: this.headers(key) });
      const skip = /(audio|realtime|transcribe|tts|whisper|embedding|image|dall-e|moderation|search|codex|instruct|davinci|babbage|computer)/;
      return (body.data || []).map((m) => m.id)
        .filter((id) => /^(gpt|o\d|chat)/.test(id) && !skip.test(id))
        .sort(compareVersionDesc);
    },
    pick(ids) {
      const plain = ids.filter((id) => /^gpt-\d+(\.\d+)?$/.test(id)).sort(compareVersionDesc);
      return plain[0] || ids.find((id) => /^gpt-\d/.test(id)) || ids[0];
    },
  },

  gemini: {
    headers(key) {
      return { 'content-type': 'application/json', 'x-goog-api-key': key };
    },
    async chat(key, model, system, user, signal) {
      const id = encodeURIComponent(model.replace(/^models\//, ''));
      const body = await request(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
        method: 'POST', headers: this.headers(key),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
      }, signal);
      const cand = body.candidates && body.candidates[0];
      if (!cand || !cand.content) {
        const why = (body.promptFeedback && body.promptFeedback.blockReason) || (cand && cand.finishReason) || '空の応答';
        throw new ApiError(200, `応答がありませんでした（${why}）`);
      }
      return (cand.content.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('').trim();
    },
    async models(key) {
      const body = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: this.headers(key) });
      return (body.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => /^gemini/.test(id) && !/(embedding|image|tts|audio|live|robotics|computer)/.test(id))
        .sort(compareVersionDesc);
    },
    pick(ids) {
      if (ids.includes('gemini-pro-latest')) return 'gemini-pro-latest';
      return ids.find((id) => /-pro/.test(id)) || ids[0];
    },
  },
};

function compareVersionDesc(a, b) {
  const va = (a.match(/\d+(\.\d+)?/) || ['0'])[0];
  const vb = (b.match(/\d+(\.\d+)?/) || ['0'])[0];
  const d = parseFloat(vb) - parseFloat(va);
  if (d) return d;
  return a.length - b.length || a.localeCompare(b);
}

function explainError(err, pid) {
  const name = PROVIDERS[pid].name;
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err.name === 'TimeoutError' ? `${name} の返事が4分以上来なかったので、打ち切りました。` : '止めました。';
  }
  if (err instanceof ApiError) {
    const d = err.detail ? `（${err.detail}）` : '';
    if (err.status === 401 || err.status === 403) return `${name} のAPIキーが正しくないか、使う権限がありません。設定でキーを確かめてください。${d}`;
    if (err.status === 404) return `${name} のモデルが見つかりません。設定で「一覧を更新」してモデルを選び直してください。${d}`;
    if (err.status === 429) return `${name} の利用上限か残高不足です。少し待つか、${name} の支払い設定を確かめてください。${d}`;
    if (err.status === 400) return `${name} がリクエストを受け付けませんでした。別のモデルを選ぶと直ることがあります。${d}`;
    if (err.status >= 500) return `${name} 側が混み合っているか、不調です。少し待ってからもう一度お試しください。${d}`;
    return `${name} でエラーが起きました。${d}`;
  }
  return `${name} に接続できませんでした。ネットの接続を確かめてください。`;
}

/* ---------------- 話し合いの進め方 ---------------- */

function systemPrompt(pid, members) {
  const me = PROVIDERS[pid].name;
  const others = members.filter((m) => m !== pid).map((m) => PROVIDERS[m].name);
  return [
    `あなたは「${me}」です。${others.join('、')}と一緒に、ユーザーの問いに対する最良の結論を出すための話し合いに参加しています。`,
    '日本語で、専門用語はかみくだいて、平易に答えてください。',
    '見出しは使わず、短い段落と箇条書きで、600字程度までにまとめてください。',
    '相手に合わせるだけの同意は避け、根拠のある意見を述べてください。相手のほうが正しいと思ったら、素直に考えを改めてください。',
  ].join('\n');
}

function transcriptText(question, rounds) {
  return rounds.map((r, i) => {
    const head = i === 0 ? '■ 最初の考え' : `■ 意見交換 ${i}回目`;
    const body = r.filter((x) => x.text).map((x) => `[${PROVIDERS[x.pid].name}]\n${x.text}`).join('\n\n');
    return `${head}\n\n${body}`;
  }).join('\n\n');
}

function firstPrompt(question) {
  return `【問い】\n${question}\n\nまず、あなた自身の考えを述べてください。\n最後の行に「結論：」で始まる1〜2文で、あなたの立場をまとめてください。`;
}

function debatePrompt(question, rounds) {
  return [
    `【問い】\n${question}`,
    `【これまでの話し合い】\n${transcriptText(question, rounds)}`,
    'ほかの参加者の最新の意見を読んだうえで、次の3点を述べてください。',
    '1. 同意する点\n2. 反対する点・足りない点\n3. 考えを変えた点（あれば、その理由も）',
    '最後の行に「結論：」で始まる1〜2文で、今のあなたの立場をまとめてください。',
  ].join('\n\n');
}

function finalPrompt(question, rounds, members) {
  const names = members.map((m) => PROVIDERS[m].name);
  return [
    `【問い】\n${question}`,
    `【話し合いの記録】\n${transcriptText(question, rounds)}`,
    'あなたはこの話し合いのまとめ役です。自分の意見に寄せず、公平にまとめてください。',
    'ユーザーが読んですぐ行動に移せるよう、問いへの答えをはっきり言い切ってください。',
    '次の形式で、日本語で書いてください（見出しはこの4つだけ）。',
    [
      '## 結論',
      '（問いへの答えを2〜4文で）',
      '## 合意した点',
      '- （箇条書き）',
      '## 意見が分かれた点',
      '- （誰がどう考えたか。なければ「なし」）',
      '## それぞれの最終的な立場',
      ...names.map((n) => `- ${n}：（1文）`),
    ].join('\n'),
  ].join('\n\n');
}

async function runDiscussion(question, members, extraRounds, moderator) {
  const ctrl = new AbortController();
  state.running = ctrl;
  const log = { question, members: members.slice(), models: {}, rounds: [], final: null, startedAt: new Date() };
  members.forEach((m) => { log.models[m] = state.prefs.models[m]; });
  state.log = log;

  renderResultShell(question);
  let active = members.slice();
  const totalSteps = extraRounds + 2;

  try {
    for (let r = 0; r <= extraRounds; r++) {
      setProgress(`${r + 1} / ${totalSteps} 段階目`);
      const section = renderRound(r, active);
      const prompt = r === 0 ? firstPrompt(question) : debatePrompt(question, log.rounds);
      const results = await Promise.all(active.map((pid) => askOne(pid, systemPrompt(pid, members), prompt, ctrl.signal, section)));
      log.rounds.push(results);
      if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');

      const ok = results.filter((x) => x.text).map((x) => x.pid);
      if (ok.length < active.length) {
        const dropped = active.filter((p) => !ok.includes(p)).map((p) => PROVIDERS[p].name);
        addNotice(section, `${dropped.join('、')} はエラーのため、ここから先の話し合いには参加しません。`);
      }
      active = ok;
      if (active.length < 2) {
        addNotice(section, '話し合いに参加できるAIが2つ未満になったため、ここで止めました。設定を確かめてから、もう一度お試しください。');
        return;
      }
    }

    setProgress(`${totalSteps} / ${totalSteps} 段階目：まとめ`);
    const mod = active.includes(moderator) ? moderator : active[0];
    const box = renderConclusion(mod);
    const t0 = performance.now();
    try {
      const text = await api[mod].chat(state.keys[mod], state.prefs.models[mod],
        'あなたは公平な議事進行役です。日本語で、平易に書いてください。', finalPrompt(question, log.rounds, members), ctrl.signal);
      log.final = { pid: mod, text };
      fillConclusion(box, text, performance.now() - t0);
    } catch (err) {
      fillConclusion(box, null, 0, explainError(err, mod));
    }
  } catch (err) {
    if (!(err && err.name === 'AbortError')) console.error(err);
  } finally {
    state.running = null;
    setRunning(false);
    setProgress(ctrl.signal.aborted ? '途中で止めました' : '終わりました');
    $('btn-export').hidden = !log.rounds.length;
  }
}

async function askOne(pid, system, prompt, signal, section) {
  const card = renderCard(section, pid);
  const t0 = performance.now();
  try {
    const text = await api[pid].chat(state.keys[pid], state.prefs.models[pid], system, prompt, signal);
    if (!text) throw new ApiError(200, '空の応答');
    fillCard(card, text, performance.now() - t0);
    return { pid, text };
  } catch (err) {
    const msg = explainError(err, pid);
    fillCard(card, null, performance.now() - t0, msg);
    return { pid, text: null, error: msg };
  }
}

/* ---------------- 表示 ---------------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* AIの文章を安全に表示する：先に全部エスケープしてから、ごく一部の書式だけタグに置き換える */
function renderMarkdown(src, opts = {}) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; let para = []; let code = null; let firstAfterConclusion = false;
  const flushPara = () => {
    if (!para.length) return;
    const html = para.map(inline).join('<br>');
    const isStance = /^(\*\*)?結論[：:]/.test(para[0]);
    if (opts.conclusion && firstAfterConclusion) { out.push(`<p class="lead-answer">${html}</p>`); firstAfterConclusion = false; }
    else out.push(isStance && !opts.conclusion ? `<p class="stance">${html}</p>` : `<p>${html}</p>`);
    para = [];
  };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const ul = line.match(/^\s*(?:[-*・])\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      out.push(`<h3>${inline(h[1])}</h3>`);
      firstAfterConclusion = opts.conclusion && /結論/.test(h[1]);
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      if (/^(\*\*)?結論[：:]/.test(line) && para.length) flushPara();
      para.push(line);
    }
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return out.join('');
}

function renderResultShell(question) {
  $('result').hidden = false;
  $('result-q').textContent = question;
  $('rounds-out').replaceChildren();
  $('btn-export').hidden = true;
  $('result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function renderRound(r, active) {
  const sec = el('section', 'round');
  const head = el('div', 'round-head');
  head.append(el('span', 'round-no', `Step ${r + 1}`), el('h3', 'round-title', r === 0 ? 'それぞれの考え' : `意見交換 ${r}回目`));
  const cards = el('div', 'cards');
  sec.append(head, cards);
  $('rounds-out').append(sec);
  return sec;
}

function cardHead(pid) {
  const head = el('div', 'card-head');
  const mark = el('span', 'mark', PROVIDERS[pid].mark);
  mark.setAttribute('aria-hidden', 'true');
  const names = el('div');
  names.append(el('div', 'card-name', PROVIDERS[pid].name), el('div', 'card-model', state.prefs.models[pid] || ''));
  const time = el('span', 'card-time');
  head.append(mark, names, time);
  return { head, time };
}

function thinkingNode(label) {
  const t = el('div', 'thinking');
  const dots = el('span', 'dots');
  dots.setAttribute('aria-hidden', 'true');
  dots.append(el('i'), el('i'), el('i'));
  t.append(dots, el('span', null, label));
  return t;
}

function renderCard(section, pid) {
  const card = el('article', 'card');
  const { head, time } = cardHead(pid);
  const body = el('div', 'card-body');
  body.append(thinkingNode('考えています'));
  card.append(head, body);
  card._time = time; card._body = body;
  section.querySelector('.cards').append(card);
  return card;
}

const fmtSec = (ms) => (ms ? `${Math.max(1, Math.round(ms / 1000))}秒` : '');

function fillCard(card, text, ms, error) {
  card._time.textContent = fmtSec(ms);
  if (error) {
    card.classList.add('error');
    card._body.replaceChildren(el('p', null, error));
    return;
  }
  const md = el('div', 'md');
  md.innerHTML = renderMarkdown(text);
  card._body.replaceChildren(md);
}

function renderConclusion(pid) {
  const sec = el('section', 'conclusion');
  const head = el('div', 'round-head');
  head.append(el('span', 'round-no', 'Summary'), el('h3', 'round-title', 'まとめ'));
  const by = el('p', 'by', `まとめ役：${PROVIDERS[pid].name}（${state.prefs.models[pid]}）`);
  const body = el('div', 'card-body');
  body.append(thinkingNode('話し合いをまとめています'));
  sec.append(head, by, body);
  sec._body = body; sec._by = by;
  $('rounds-out').append(sec);
  sec.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  return sec;
}

function fillConclusion(sec, text, ms, error) {
  if (error) { sec._body.replaceChildren(el('p', 'field-error', error)); return; }
  sec._by.textContent += ` · ${fmtSec(ms)}`;
  const md = el('div', 'md');
  md.innerHTML = renderMarkdown(text, { conclusion: true });
  sec._body.replaceChildren(md);
}

function addNotice(section, msg) {
  section.append(el('p', 'notice', msg));
}

function setProgress(t) { $('progress').textContent = t; }

function setRunning(on) {
  $('btn-start').disabled = on;
  $('btn-start').textContent = on ? '話し合っています…' : '話し合いを始める';
  $('btn-stop').hidden = !on;
  $('btn-settings').disabled = on;
  $('btn-lock').disabled = on;
}

/* ---------------- 書き出し ---------------- */

function exportMarkdown() {
  const log = state.log;
  if (!log) return;
  const lines = [`# ${log.question.split('\n')[0]}`, '', `日時：${log.startedAt.toLocaleString('ja-JP')}`, ''];
  lines.push('参加：' + log.members.map((m) => `${PROVIDERS[m].name}（${log.models[m]}）`).join('、'), '');
  if (log.question.includes('\n')) lines.push('## 問い', '', log.question, '');
  if (log.final) lines.push(`## 結論（まとめ役：${PROVIDERS[log.final.pid].name}）`, '', log.final.text.replace(/^## /gm, '### '), '');
  log.rounds.forEach((r, i) => {
    lines.push(`## ${i === 0 ? 'それぞれの考え' : `意見交換 ${i}回目`}`, '');
    r.forEach((x) => lines.push(`### ${PROVIDERS[x.pid].name}`, '', x.text || `（エラー：${x.error}）`, ''));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  const d = log.startedAt;
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `teidan-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- 画面の切り替え ---------------- */

function show(view) {
  ['lock', 'setup', 'main'].forEach((v) => { $(`view-${v}`).hidden = v !== view; });
  const unlocked = view === 'main';
  $('btn-settings').hidden = !unlocked;
  $('btn-lock').hidden = !(unlocked && hasVault());
  if (view === 'lock') setTimeout(() => $('lock-pass').focus(), 0);
  if (view === 'main') renderMembers();
  window.scrollTo(0, 0);
}

function availableMembers() {
  return ORDER.filter((p) => state.keys[p]);
}

function renderMembers() {
  const list = $('member-list');
  list.replaceChildren();
  ORDER.forEach((pid) => {
    const has = !!state.keys[pid];
    const lab = el('label', 'member' + (has ? '' : ' disabled'));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = has && state.prefs.enabled[pid] !== false;
    cb.disabled = !has;
    cb.addEventListener('change', () => { state.prefs.enabled[pid] = cb.checked; savePrefs(); renderModerator(); });
    const mark = el('span', 'mark', PROVIDERS[pid].mark);
    mark.setAttribute('aria-hidden', 'true');
    const txt = el('span');
    txt.append(el('span', null, PROVIDERS[pid].name + ' '), el('span', 'model', has ? state.prefs.models[pid] : '（キー未設定）'));
    lab.append(cb, mark, txt);
    cb.dataset.pid = pid;
    list.append(lab);
  });
  renderModerator();
  $('rounds').value = state.prefs.rounds || '2';
}

function checkedMembers() {
  return [...document.querySelectorAll('#member-list input:checked')].map((c) => c.dataset.pid);
}

function renderModerator() {
  const sel = $('moderator');
  const members = checkedMembers();
  sel.replaceChildren(...members.map((p) => { const o = el('option', null, PROVIDERS[p].name); o.value = p; return o; }));
  if (members.includes(state.prefs.moderator)) sel.value = state.prefs.moderator;
}

/* ---------------- 設定画面 ---------------- */

function fillModelSelect(pid, ids, chosen) {
  const sel = $(`model-${pid}`);
  const list = ids && ids.length ? ids.slice() : [];
  if (chosen && !list.includes(chosen)) list.unshift(chosen);
  if (!list.length) list.push(PROVIDERS[pid].fallbackModel);
  sel.replaceChildren(...list.map((id) => { const o = el('option', null, id); o.value = id; return o; }));
  sel.value = chosen || list[0];
}

function setStatus(pid, text, kind) {
  const s = $(`status-${pid}`);
  s.textContent = text;
  s.className = 'help status' + (kind ? ` ${kind}` : '');
}

async function fetchModels(pid, { auto } = {}) {
  const key = $(`key-${pid}`).value.trim();
  if (!key) { if (!auto) setStatus(pid, '先にAPIキーを入れてください。', 'err'); return; }
  setStatus(pid, 'モデルの一覧を取得しています…');
  try {
    const ids = await api[pid].models(key);
    if (!ids.length) throw new ApiError(0, '使えるモデルが見つかりませんでした');
    state.prefs.modelLists[pid] = ids;
    const current = $(`model-${pid}`).value;
    const keep = state.prefs.models[pid] && ids.includes(current) ? current : api[pid].pick(ids);
    fillModelSelect(pid, ids, keep);
    savePrefs();
    setStatus(pid, `キーは有効です。${ids.length}個のモデルから「${keep}」を選びました（変更できます）。`, 'ok');
  } catch (err) {
    setStatus(pid, explainError(err, pid), 'err');
  }
}

function openSetup(fromMain) {
  ORDER.forEach((pid) => {
    $(`key-${pid}`).value = state.keys[pid] || '';
    fillModelSelect(pid, state.prefs.modelLists[pid], state.prefs.models[pid] || PROVIDERS[pid].fallbackModel);
    setStatus(pid, '');
  });
  const vault = hasVault();
  $('save-local').checked = fromMain ? (vault || state.saveLocal) : true;
  $('setup-pass').value = state.passphrase || '';
  $('setup-pass2').value = state.passphrase || '';
  $('setup-error').hidden = true;
  $('btn-cancel-setup').hidden = !fromMain;
  $('danger-zone').hidden = !vault;
  togglePassFields();
  show('setup');
}

function togglePassFields() {
  $('pass-fields').hidden = !$('save-local').checked;
}

function setupError(msg) {
  const e = $('setup-error');
  e.textContent = msg; e.hidden = !msg;
}

async function saveSetup() {
  const keys = {};
  ORDER.forEach((pid) => { keys[pid] = $(`key-${pid}`).value.trim(); });
  const count = ORDER.filter((p) => keys[p]).length;
  if (count < 2) return setupError('APIキーを2つ以上入れてください。話し合いには2つ以上のAIが必要です。');

  const save = $('save-local').checked;
  const p1 = $('setup-pass').value; const p2 = $('setup-pass2').value;
  if (save) {
    if (p1.length < 8) return setupError('合言葉は8文字以上にしてください。');
    if (p1 !== p2) return setupError('合言葉が2回とも同じになるように入れ直してください。');
  }
  setupError('');

  const btn = $('btn-save');
  btn.disabled = true; btn.textContent = '保存しています…';
  try {
    ORDER.forEach((pid) => { state.prefs.models[pid] = $(`model-${pid}`).value || PROVIDERS[pid].fallbackModel; });
    // まだ一覧を取っていないAIは、ここで一覧を取って最新モデルを自動で選ぶ
    await Promise.all(ORDER.filter((p) => keys[p] && !(state.prefs.modelLists[p] || []).length).map(async (pid) => {
      try {
        const ids = await api[pid].models(keys[pid]);
        if (ids.length) { state.prefs.modelLists[pid] = ids; state.prefs.models[pid] = api[pid].pick(ids); }
      } catch (_) { /* 失敗しても既定のモデル名で続ける。エラーは話し合いの時に表示される */ }
    }));
    ORDER.forEach((pid) => { if (keys[pid] && state.prefs.enabled[pid] === undefined) state.prefs.enabled[pid] = true; });
    savePrefs();

    state.keys = keys;
    state.saveLocal = save;
    if (save) {
      await sealVault(keys, p1);
      state.passphrase = p1;
    } else {
      wipeVault();
      state.passphrase = null;
    }
    show('main');
  } catch (err) {
    console.error(err);
    setupError('保存できませんでした。ブラウザのプライベートモードでは保存できないことがあります。「この端末に保存する」を外すと使えます。');
  } finally {
    btn.disabled = false; btn.textContent = '保存して始める';
  }
}

async function unlock() {
  const pass = $('lock-pass').value;
  const e = $('lock-error');
  if (!pass) { e.textContent = '合言葉を入れてください。'; e.hidden = false; return; }
  const btn = $('btn-unlock');
  btn.disabled = true; btn.textContent = '開いています…';
  try {
    state.keys = Object.assign({ claude: '', openai: '', gemini: '' }, await openVault(pass));
    state.passphrase = pass;
    state.saveLocal = true;
    $('lock-pass').value = '';
    e.hidden = true;
    show('main');
  } catch (_) {
    e.textContent = '合言葉が違います。もう一度入れてください。';
    e.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '開く';
  }
}

function lockNow() {
  state.keys = { claude: '', openai: '', gemini: '' };
  state.passphrase = null;
  $('result').hidden = true;
  $('rounds-out').replaceChildren();
  state.log = null;
  show('lock');
}

function forgetAll(fromSetup) {
  wipeVault();
  state.keys = { claude: '', openai: '', gemini: '' };
  state.passphrase = null;
  openSetup(false);
  if (fromSetup) setupError('');
}

/* ---------------- はじまり ---------------- */

function start() {
  const q = $('question').value.trim();
  const err = $('ask-error');
  const members = checkedMembers();
  if (!q) { err.textContent = '話し合ってほしいことを入れてください。'; err.hidden = false; $('question').focus(); return; }
  if (members.length < 2) { err.textContent = '参加するAIを2つ以上選んでください。'; err.hidden = false; return; }
  err.hidden = true;
  const rounds = parseInt($('rounds').value, 10) || 2;
  const moderator = $('moderator').value || members[0];
  state.prefs.rounds = String(rounds);
  state.prefs.moderator = moderator;
  savePrefs();
  setRunning(true);
  runDiscussion(q, members, rounds, moderator);
}

function init() {
  $('btn-unlock').addEventListener('click', unlock);
  $('lock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('btn-forget').addEventListener('click', () => {
    const b = $('btn-forget');
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '（もう一度押すと消えます）この端末の保存内容を消して'; return; }
    b.dataset.confirm = ''; b.textContent = 'この端末の保存内容を消して';
    forgetAll(false);
  });
  $('btn-save').addEventListener('click', saveSetup);
  $('btn-cancel-setup').addEventListener('click', () => show('main'));
  $('save-local').addEventListener('change', togglePassFields);
  $('btn-wipe').addEventListener('click', () => {
    const b = $('btn-wipe');
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'もう一度押すと消します'; return; }
    b.dataset.confirm = ''; b.textContent = 'この端末からキーを消す';
    forgetAll(true);
  });
  document.querySelectorAll('.btn-fetch').forEach((b) => b.addEventListener('click', () => fetchModels(b.dataset.p)));
  ORDER.forEach((pid) => {
    $(`key-${pid}`).addEventListener('change', () => fetchModels(pid, { auto: true }));
    $(`model-${pid}`).addEventListener('change', () => { state.prefs.models[pid] = $(`model-${pid}`).value; savePrefs(); });
  });
  $('btn-settings').addEventListener('click', () => openSetup(true));
  $('btn-lock').addEventListener('click', lockNow);
  $('btn-start').addEventListener('click', start);
  $('question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start(); });
  $('btn-stop').addEventListener('click', () => { if (state.running) state.running.abort(new DOMException('aborted', 'AbortError')); });
  $('btn-export').addEventListener('click', exportMarkdown);
  $('moderator').addEventListener('change', () => { state.prefs.moderator = $('moderator').value; savePrefs(); });

  if (!window.crypto || !crypto.subtle) {
    document.body.prepend(el('p', 'notice', 'このブラウザでは暗号化が使えません。最新のChrome・Safari・Edgeで開いてください。'));
  }
  if (hasVault()) show('lock'); else openSetup(false);
}

document.addEventListener('DOMContentLoaded', init);
