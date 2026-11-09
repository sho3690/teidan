// 鼎談 TEIDAN — サブスク版（このMacの中だけで動くサーバー）
//
// Claude（claude -p）・ChatGPT（codex exec）・Gemini（gemini -p）を、
// それぞれのサブスクでログイン済みのCLIとして呼び出す。APIキーは使わない。
//
// 安全のための決まりごと:
// - 127.0.0.1 だけで待ち受ける（ほかのパソコンやスマホからは届かない）
// - Host / Origin / 専用ヘッダーを確かめ、ほかのWebサイトからの呼び出しを断る
// - AIには道具（ファイル読み書き・コマンド・Web・外部連携）を持たせず、文章を返すだけにする
// - 毎回、空の一時フォルダで動かし、終わったら消す
// - APIキーの環境変数は子に渡さない（従量課金に切り替わらないように）

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEIDAN_PORT || 8796);
const HOST = '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.homedir(), '.teidan');
export const GEMINI_HOME = path.join(STATE_DIR, 'gemini-home');
const CALL_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_BODY = 400 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PARALLEL = 4;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

/* ---------------- CLIを探す ---------------- */

const EXTRA_DIRS = [
  path.join(os.homedir(), '.npm-global/bin'),
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

// ~/.agents/bin の codex はエージェント間メッセージ用の中継なので使わない
const SKIP_DIRS = [path.join(os.homedir(), '.agents/bin')];

export function findExe(name) {
  const dirs = [...(process.env.PATH || '').split(':'), ...EXTRA_DIRS];
  for (const dir of dirs) {
    if (!dir || SKIP_DIRS.some((s) => path.resolve(dir) === s)) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 次を探す */ }
  }
  return null;
}

/* ---------------- 子プロセスの環境 ---------------- */

const DROP_ENV = /^(ANTHROPIC_|OPENAI_|AZURE_OPENAI|CODEX_API_KEY|CODEX_COMPANION|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_|GOOGLE_CLOUD_|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_|CLAUDECODE$|CLAUDE_PID$|AGMSG_|GEMINI_CLI_HOME$|GEMINI_SYSTEM_MD$)/;

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN') { env[k] = v; continue; }
    if (DROP_ENV.test(k) || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...EXTRA_DIRS])]
    .filter((d) => d && !SKIP_DIRS.includes(path.resolve(d))).join(':');
  env.NO_COLOR = '1';
  return Object.assign(env, extra);
}

function run(exe, args, { input = '', cwd, env, signal }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); } };
    const kill = () => { try { child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000); } catch {} };
    const timer = setTimeout(() => { kill(); finish({ code: -1, out, err, timedOut: true }); }, CALL_TIMEOUT_MS);
    const onAbort = () => { kill(); finish({ code: -1, out, err, aborted: true }); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', (e) => finish({ code: -1, out, err: String(e.message || e) }));
    child.on('close', (code) => finish({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/* ---------------- エラーの言い換え ---------------- */

export function explain(name, text) {
  const t = (text || '').toLowerCase();
  if (/(not logged in|please log ?in|\/login|unauthori[sz]ed|authenticat|oauth|credential|expired|401|sign in|login required)/.test(t)) {
    return { kind: 'login', message: `${name} にログインできていません。設定画面の手順でログインし直してください。` };
  }
  if (/(usage limit|rate limit|hit your limit|limit reached|quota|429|resource_exhausted|too many requests)/.test(t)) {
    return { kind: 'limit', message: `${name} のサブスクの利用上限に達しました。時間をおくと使えるようになります。` };
  }
  if (/(model_not_found|model .* not (found|supported)|unknown model|invalid model|not supported)/.test(t)) {
    return { kind: 'model', message: `${name} では、そのモデルは使えません。設定でモデルを空欄（標準）に戻してください。` };
  }
  const short = (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { kind: 'other', message: `${name} が応答に失敗しました。${short ? `（${short}）` : ''}` };
}

/* ---------------- 3つのAI ---------------- */

export const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent',
  'plugins', 'remote_plugin', 'hooks', 'goals', 'code_mode_host', 'tool_suggest', 'memories',
  'skill_mcp_dependency_install', 'workspace_dependencies',
];

export const GEMINI_SETTINGS = {
  security: { auth: { selectedType: 'oauth-personal' }, folderTrust: { enabled: false } },
  tools: {
    core: ['__no_tools__'],
    exclude: [
      'read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content', 'grep_search',
      'run_shell_command', 'write_file', 'replace', 'edit', 'web_fetch', 'google_web_search',
      'save_memory', 'write_todos', 'activate_skill', 'codebase_investigator', 'delegate_to_agent',
    ],
  },
  general: { disableAutoUpdate: true, disableUpdateNag: true, checkpointing: { enabled: false } },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  experimental: { extensionManagement: false },
};

export function ensureGeminiHome() {
  const dir = path.join(GEMINI_HOME, '.gemini');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(GEMINI_SETTINGS, null, 2), { mode: 0o600 });
  return file;
}

export const PROVIDERS = {
  claude: {
    name: 'Claude',
    exe: 'claude',
    args({ system, model }) {
      return ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
        '--system-prompt', system, '--no-session-persistence', '--output-format', 'json',
        ...(model ? ['--model', model] : [])];
    },
    input: ({ prompt }) => prompt,
    env: () => ({}),
    async parse(r) {
      let data = null;
      try { data = JSON.parse(r.out); } catch {}
      if (data && r.code === 0 && !data.is_error) return { text: String(data.result || '').trim() };
      return { fail: (data && data.result) || r.err || r.out };
    },
  },

  openai: {
    name: 'ChatGPT',
    exe: 'codex',
    args({ model, dir }) {
      return ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral',
        '-s', 'read-only', '-C', dir, '--color', 'never',
        '-c', 'web_search=disabled', '-c', 'project_doc_max_bytes=0',
        ...CODEX_DISABLE.flatMap((f) => ['--disable', f]),
        ...(model ? ['-m', model] : []),
        '-o', path.join(dir, 'answer.txt'), '-'];
    },
    input: ({ system, prompt }) => `${system}\n\n---\n\n${prompt}`,
    env: () => ({}),
    async parse(r, dir) {
      let text = '';
      try { text = (await fsp.readFile(path.join(dir, 'answer.txt'), 'utf8')).trim(); } catch {}
      if (r.code === 0 && text) return { text };
      const errLines = (r.err + '\n' + r.out).split('\n').filter((l) => /error/i.test(l));
      let msg = errLines.join(' ');
      const m = msg.match(/"message"\s*:\s*"([^"]+)"/);
      if (m) msg = m[1] + ' ' + msg;
      return { fail: msg || r.err || r.out };
    },
  },

  gemini: {
    name: 'Gemini',
    exe: 'gemini',
    args({ model }) {
      return ['-p', '上の依頼に答えてください。', '-o', 'json', '-e', 'none', ...(model ? ['-m', model] : [])];
    },
    input: ({ prompt }) => prompt,
    env: ({ dir }) => ({ GEMINI_CLI_HOME: GEMINI_HOME, GEMINI_SYSTEM_MD: path.join(dir, 'system.md') }),
    async prepare({ dir, system }) {
      ensureGeminiHome();
      await fsp.writeFile(path.join(dir, 'system.md'), system);
    },
    async parse(r) {
      let data = null;
      const start = r.out.indexOf('{');
      try { data = JSON.parse(start >= 0 ? r.out.slice(start) : r.out); } catch {}
      if (data && data.response && !data.error) return { text: String(data.response).trim() };
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || r.err || r.out;
      return { fail: msg };
    },
  },
};

let running = 0;

export async function ask(pid, { system, prompt, model }, signal) {
  const p = PROVIDERS[pid];
  if (!p) return { error: '知らないAIです。', kind: 'other' };
  const exe = findExe(p.exe);
  if (!exe) return { error: `${p.name} のコマンド（${p.exe}）がこのMacに見つかりません。`, kind: 'missing' };
  if (running >= MAX_PARALLEL) return { error: '同時に動かせる数を超えました。少し待ってください。', kind: 'busy' };

  running++;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `teidan-${pid}-`));
  try {
    const ctx = { system, prompt, model: sanitizeModel(model), dir };
    if (p.prepare) await p.prepare(ctx);
    const r = await run(exe, p.args(ctx), { input: p.input(ctx), cwd: dir, env: childEnv(p.env(ctx)), signal });
    if (r.aborted) return { error: '止めました。', kind: 'aborted' };
    if (r.timedOut) return { error: `${p.name} の返事が6分以上来なかったので、打ち切りました。`, kind: 'timeout' };
    const res = await p.parse(r, dir);
    if (res.text) return { text: res.text };
    const e = explain(p.name, String(res.fail || ''));
    return { error: e.message, kind: e.kind };
  } finally {
    running--;
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sanitizeModel(m) {
  if (!m) return '';
  const s = String(m).trim();
  return /^[A-Za-z0-9._:\-\/\[\]]{1,80}$/.test(s) ? s : '';
}

export async function status() {
  const out = {};
  for (const [pid, p] of Object.entries(PROVIDERS)) {
    const exe = findExe(p.exe);
    out[pid] = { name: p.name, installed: !!exe, login: 'unknown' };
  }
  if (out.claude.installed) {
    const r = await run(findExe('claude'), ['auth', 'status'], { cwd: os.tmpdir(), env: childEnv() });
    try { const d = JSON.parse(r.out); out.claude.login = d.loggedIn && d.authMethod !== 'api_key' ? 'yes' : 'no'; } catch {}
  }
  if (out.openai.installed) {
    const r = await run(findExe('codex'), ['login', 'status'], { cwd: os.tmpdir(), env: childEnv() });
    const t = (r.out + r.err).toLowerCase();
    out.openai.login = /chatgpt/.test(t) && /logged in/.test(t) ? 'yes' : (/api key/.test(t) ? 'apikey' : 'no');
  }
  return out;
}

/* ---------------- Webサーバー ---------------- */

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    // DNSリバインディング対策：自分宛て以外の Host は断る
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      // ほかのサイトからの呼び出しを断る：Origin が自分であること＋専用ヘッダー（付けると事前確認が必要になり、それには応じない）
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, { error: 'bad origin' });
      if (req.headers['x-teidan'] !== '1') return send(res, 403, { error: 'missing header' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: 'cross site' });

      if (url.pathname === '/api/status' && req.method === 'GET') return send(res, 200, { ok: true, providers: await status() });

      if (url.pathname === '/api/ask' && req.method === 'POST') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
        let body;
        try { body = await readJson(req); } catch { return send(res, 400, { error: '依頼の形が正しくありません。' }); }
        const { pid, system, prompt, model } = body || {};
        if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim()) return send(res, 400, { error: '依頼の中身がありません。' });
        const ctrl = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
        const result = await ask(pid, { system, prompt, model }, ctrl.signal);
        if (!res.writableEnded && !res.destroyed) send(res, 200, result);
        return;
      }
      return send(res, 404, { error: 'not found' });
    }

    const file = STATIC[url.pathname];
    if (!file || req.method !== 'GET') return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    try {
      return send(res, 200, await fsp.readFile(path.join(ROOT, file[0])), file[1]);
    } catch {
      return send(res, 500, 'error', 'text/plain; charset=utf-8');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureGeminiHome();
  const server = createServer();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`ポート ${PORT} はすでに使われています（鼎談がもう起動しているかもしれません）。`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`鼎談 TEIDAN（サブスク版）を起動しました： http://${HOST}:${PORT}/`);
    console.log('このウィンドウを閉じると止まります。');
  });
}
