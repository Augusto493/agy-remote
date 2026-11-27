// Agy Remote — ponte entre o celular e o Antigravity CLI (agy) rodando neste PC.
// Sem dependências: só Node.js. Rode com: node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = __dirname;
// O app desktop define AGY_REMOTE_DATA (pasta de dados do usuário); rodando solto, usa ./data
const DATA = process.env.AGY_REMOTE_DATA || path.join(ROOT, 'data');
const events = new EventEmitter();
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(DATA, 'config.json');
const STORE_FILE = path.join(DATA, 'store.json');
const HOME = os.homedir();
const GEMINI_MD = path.join(HOME, '.gemini', 'GEMINI.md');
const CLI_CONV_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'conversations');
const MEM_START = '<!-- agy-remote:memoria:inicio -->';
const MEM_END = '<!-- agy-remote:memoria:fim -->';

fs.mkdirSync(DATA, { recursive: true });

// ---------- config ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const config = Object.assign({
  port: 8790,
  token: crypto.randomBytes(24).toString('hex'),
  workspaces: [HOME],
  agyPath: '',
}, loadJson(CONFIG_FILE, {}));
saveJson(CONFIG_FILE, config);

function resolveAgy() {
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  if (config.agyPath && fs.existsSync(config.agyPath)) return config.agyPath;
  try {
    const out = execFileSync('where', ['agy.exe'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (out[0]) return out[0].trim();
  } catch {}
  return 'agy';
}
const AGY = resolveAgy();

// Código de pareamento: muda a cada vez que o servidor inicia.
const pairCode = String(crypto.randomInt(100000, 999999));
const pairAttempts = [];

// ---------- store (conversas compartilhadas entre PC e celular) ----------
const store = loadJson(STORE_FILE, { conversations: {} });
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(STORE_FILE, store), 300);
}

function convTokens(c) {
  let total = 0, context = 0;
  for (const m of c.messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    total += m.usage.total_tokens || 0;
    context = (m.usage.lastInput || 0) || context;
  }
  return { total, context };
}
function convSummary(c) {
  const last = c.messages[c.messages.length - 1];
  let lastAi = null, lastUser = null;
  for (let i = c.messages.length - 1; i >= 0 && (!lastAi || !lastUser); i--) {
    const m = c.messages[i];
    if (m.role === 'assistant' && !lastAi) lastAi = m;
    if (m.role === 'user' && !lastUser) lastUser = m;
  }
  const running = !!activeRunFor(c.id);
  const status = running ? 'rodando'
    : lastAi && lastAi.denied && lastAi.denied.length ? 'bloqueado'
    : lastAi && lastAi.status && lastAi.status !== 'SUCCESS' ? 'erro'
    : lastAi ? 'concluido' : 'nova';
  return {
    id: c.id, title: c.title, cwd: c.cwd, source: c.source,
    createdAt: c.createdAt, updatedAt: c.updatedAt, running, status,
    model: lastAi ? lastAi.model || null : null,
    device: lastUser ? lastUser.device : null,
    turns: c.messages.filter((m) => m.role === 'assistant').length,
    denied: lastAi && lastAi.denied ? lastAi.denied.map((d) => d.display_name || d.action) : [],
    preview: last ? String(last.text || '').replace(/\n\n\[Anexos[\s\S]*$/, '').slice(0, 140) : '',
    tokens: convTokens(c).total,
    engine: c.engine || null,
    team: c.team ? { state: c.team.state, total: c.team.steps.length, done: c.team.steps.filter((s) => s.status === 'ok').length } : null,
    missionId: c.missionId || null,
  };
}
function activity(limit) {
  const out = [];
  for (const c of Object.values(store.conversations)) {
    for (const m of c.messages) {
      out.push({
        ts: m.ts, convId: c.id, title: c.title, role: m.role, device: m.device || null,
        text: String(m.text || '').replace(/\n\n\[Anexos[\s\S]*$/, '').slice(0, 160),
        tokens: m.usage ? m.usage.total_tokens : 0, status: m.status || null,
        denied: m.denied && m.denied.length ? m.denied.map((d) => d.display_name || d.action) : [],
        tools: m.tools ? m.tools.length : 0,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ---------- uso ----------
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function usageReport() {
  const empty = () => ({ input: 0, output: 0, thinking: 0, cache: 0, total: 0, turns: 0, seconds: 0 });
  const add = (acc, m) => {
    const u = m.usage || {};
    acc.input += u.input_tokens || 0; acc.output += u.output_tokens || 0;
    acc.thinking += u.thinking_tokens || 0; acc.cache += u.cache_read_tokens || 0;
    acc.total += u.total_tokens || 0; acc.turns += 1; acc.seconds += m.duration || 0;
  };
  const now = Date.now(), today = dayKey(now);
  const totals = { today: empty(), week: empty(), month: empty(), all: empty() };
  const days = {}, byModel = {}, byDevice = {}, byEngine = {}, costs = {}, convs = [], engineStats = {};
  for (let i = 29; i >= 0; i--) days[dayKey(now - i * 864e5)] = empty();
  for (const c of Object.values(store.conversations)) {
    const cacc = empty();
    let prevUser = null;
    for (const m of c.messages) {
      if (m.role === 'user') { prevUser = m; continue; }
      if (m.role === 'assistant' && m.engine) {
        // taxa de sucesso e modelo mais usado por IA (conta também respostas sem uso de tokens)
        const es = engineStats[m.engine] = engineStats[m.engine] || { turns: 0, ok: 0, tokens: 0, models: {} };
        es.turns++; if (m.status === 'SUCCESS') es.ok++;
        const tk = m.usage ? m.usage.total_tokens || 0 : 0; es.tokens += tk;
        const mk = m.model || 'padrão'; es.models[mk] = (es.models[mk] || 0) + 1;
      }
      if (!m.usage) continue;
      const k = dayKey(m.ts), age = now - m.ts;
      add(totals.all, m); add(cacc, m);
      if (k === today) add(totals.today, m);
      if (age < 7 * 864e5) add(totals.week, m);
      if (age < 30 * 864e5) add(totals.month, m);
      if (days[k]) add(days[k], m);
      const model = m.model || 'padrão';
      add(byModel[model] = byModel[model] || empty(), m);
      const dev = (prevUser && prevUser.device) || 'desconhecido';
      add(byDevice[dev] = byDevice[dev] || empty(), m);
      const eng = m.engine || 'agy';
      add(byEngine[eng] = byEngine[eng] || empty(), m);
      if (m.cost) costs[eng] = (costs[eng] || 0) + m.cost;
    }
    if (cacc.turns) convs.push({ id: c.id, title: c.title, ...cacc });
  }
  convs.sort((a, b) => b.total - a.total);
  return {
    totals,
    days: Object.entries(days).map(([day, v]) => ({ day, ...v })),
    byModel, byDevice, byEngine, engineStats, costs, topConversations: convs.slice(0, 8),
    conversations: Object.keys(store.conversations).length,
  };
}

// ---------- cota (agy -p /usage e /credits não gastam cota nem criam conversa) ----------
function agyJson(cmd) {
  return new Promise((resolve, reject) => require('child_process').execFile(
    AGY, ['-p', cmd, '--output-format', 'json'], { encoding: 'utf8', timeout: 45000, windowsHide: true, cwd: HOME },
    (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); } catch (e) { reject(e); }
    }));
}
let quotaCache = null, quotaPending = null;
async function getQuota(force) {
  if (!force && quotaCache && Date.now() - quotaCache.fetchedAt < 60e3) return quotaCache;
  if (quotaPending) return quotaPending;
  quotaPending = (async () => {
    const [u, c] = await Promise.allSettled([agyJson('/usage'), agyJson('/credits')]);
    const usage = u.status === 'fulfilled' && u.value.command ? u.value.command.data : null;
    const credits = c.status === 'fulfilled' && c.value.command ? c.value.command.data : null;
    quotaCache = {
      fetchedAt: Date.now(),
      description: usage ? usage.description : '',
      groups: usage ? usage.groups : [],
      credits: credits ? credits.remaining_credits : null,
      upgradeUrl: credits ? credits.upgrade_uri : null,
      error: !usage ? 'Não consegui ler a cota do agy' : null,
    };
    return quotaCache;
  })().finally(() => { quotaPending = null; });
  return quotaPending;
}

// ---------- cota exata do Claude Code (`claude -p /usage`, comando local: não gasta nada) ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseClaudeReset(s) {
  // "Nov 14, 11:20pm (America/Sao_Paulo)" ou "Nov 15, 12pm (...)"
  const m = String(s).match(/([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[3]) % 12; if (m[5].toLowerCase() === 'pm') h += 12;
  const now = new Date();
  const d = new Date(now.getFullYear(), MONTHS[m[1].toLowerCase()], Number(m[2]), h, Number(m[4] || 0));
  if (d < now - 30 * 864e5) d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}
let claudeUsageCache = null, claudeUsagePending = null;
function getClaudeUsage(force) {
  if (!force && claudeUsageCache && Date.now() - claudeUsageCache.at < 60e3) return Promise.resolve(claudeUsageCache);
  if (claudeUsagePending) return claudeUsagePending;
  const info = engineInfo.claude;
  if (!info || !info.installed) return Promise.resolve(null);
  claudeUsagePending = new Promise((resolve) => require('child_process').execFile(info.exe.path, [...(info.exe.prefix || []), '-p', '/usage', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: os.tmpdir(), maxBuffer: 8e6 }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
        const text = String(j.result || '');
        const windows = [];
        for (const line of text.split('\n')) {
          const m = line.match(/^(Current [^:]+):\s*(\d+(?:\.\d+)?)% used\s*·\s*resets\s+(.+)$/i);
          if (m) {
            const name = m[1].replace(/^Current session/i, 'Sessão (5 horas)').replace(/^Current week \(all models\)/i, 'Semana · todos os modelos')
              .replace(/^Current week \((.+)\)/i, 'Semana · $1');
            windows.push({ name, used: Number(m[2]) / 100, resetsAt: parseClaudeReset(m[3]) });
          }
        }
        const act = (text.match(/Last 24h · (\d+) requests · (\d+) sessions/) || []);
        const act7 = (text.match(/Last 7d · (\d+) requests · (\d+) sessions/) || []);
        const tips = [];
        for (const m of text.matchAll(/^\s+(\d+)%\s+(.+)$/gm)) if (tips.length < 4 && !tips.some((t) => t.text === m[2])) tips.push({ pct: Number(m[1]), text: m[2] });
        claudeUsageCache = { at: Date.now(), plan: /subscription/i.test(text) ? 'assinatura' : 'API', windows,
          last24h: act[1] ? { requests: Number(act[1]), sessions: Number(act[2]) } : null,
          last7d: act7[1] ? { requests: Number(act7[1]), sessions: Number(act7[2]) } : null, tips, raw: text.slice(0, 3000) };
      } catch { /* mantém o cache anterior */ }
      resolve(claudeUsageCache);
    })).finally(() => { claudeUsagePending = null; });
  return claudeUsagePending;
}
// ---------- cota exata do Codex (o próprio Codex grava os limites do servidor nos registros dele) ----------
function getCodexUsage() {
  try {
    const root = path.join(HOME, '.codex', 'sessions');
    const files = [];
    const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push(p); } };
    walk(root, 0);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, 5)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try {
          const j = JSON.parse(lines[i]);
          const rl = (j.payload && (j.payload.rate_limits || (j.payload.info && j.payload.info.rate_limits))) || j.rate_limits;
          if (!rl) continue;
          const win = (w, name) => w && { name, used: (w.used_percent || 0) / 100, resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null };
          return { at: fs.statSync(f).mtimeMs, windows: [win(rl.primary, 'Sessão (5 horas)'), win(rl.secondary, 'Semana')].filter(Boolean),
            credits: rl.credits ? Number(rl.credits.balance || 0) : null };
        } catch {}
      }
    }
  } catch {}
  return null;
}

// ---------- arquivos ----------
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|py|rb|php|java|kt|kts|go|rs|c|h|cpp|hpp|cs|swift|dart|sh|bat|cmd|ps1|sql|csv|tsv|log|gradle|properties|lock|gitignore|dockerfile|vue|svelte|astro|prisma|graphql|r|lua|pl)$/i;
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function drives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (let i = 67; i <= 90; i++) { const d = String.fromCharCode(i) + ':\\'; try { if (fs.existsSync(d)) out.push(d); } catch {} }
  return out;
}
function listDir(dir) {
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '$RECYCLE.BIN' || d.name === 'System Volume Information') continue;
    let st = null;
    try { st = fs.statSync(path.join(dir, d.name)); } catch { continue; }
    entries.push({ name: d.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, hidden: d.name.startsWith('.') });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, entries, isGit: fs.existsSync(path.join(dir, '.git')) };
}
function isText(file, buf) {
  // Sem byte nulo no começo = texto
  return !buf.subarray(0, 8000).includes(0);
}
// git com barras normais: o git do MSYS/ucrt64 estraga caminhos com \ e espaço; o do Windows aceita os dois
const gp = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/') : p);
function gitRoot(dir) {
  try { return execFileSync('git', ['-C', gp(dir), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim(); } catch { return null; }
}
function gitChanges(dir) {
  const root = gitRoot(dir);
  if (!root) return { git: false, files: [] };
  const out = execFileSync('git', ['-c', 'core.quotepath=false', '-C', gp(root), 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8e6 });
  const files = out.split(/\r?\n/).filter(Boolean).slice(0, 500).map((l) => {
    const code = l.slice(0, 2), file = l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
    const kind = code.includes('?') ? 'novo' : code.includes('D') ? 'apagado' : code.includes('A') ? 'novo' : code.includes('R') ? 'renomeado' : 'alterado';
    // x = índice (stage), y = arquivo de trabalho; staged = tem algo no índice
    return { file, code: code.trim(), kind, abs: path.join(root, file), x: code[0], y: code[1], staged: code[0] !== ' ' && code[0] !== '?', untracked: code === '??' };
  });
  let branch = '';
  try { branch = execFileSync('git', ['-C', gp(root), 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); } catch {}
  return { git: true, root, branch, files };
}
function gitDiff(root, file) {
  try {
    // Repositório sem nenhum commit não tem HEAD: aí todo arquivo é novo e mostramos o conteúdo inteiro.
    let hasHead = true;
    try { execFileSync('git', ['-C', gp(root), 'rev-parse', '--verify', '--quiet', 'HEAD'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch { hasHead = false; }
    let d = hasHead ? execFileSync('git', ['-C', gp(root), 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8e6 }) : '';
    if (!d.trim()) {
      const abs = path.join(root, file);
      if (fs.existsSync(abs) && fs.statSync(abs).size < 512e3) d = fs.readFileSync(abs, 'utf8').split('\n').map((l) => '+' + l).join('\n');
    }
    return d.slice(0, 400e3);
  } catch (e) { return 'Erro ao gerar diff: ' + e.message; }
}
function gitBranch(root) {
  try { return execFileSync('git', ['-C', gp(root), 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); } catch { return ''; }
}
// Checkpoint: foto do estado do repositório antes de uma execução, sem mexer em nada.
// `git stash create` grava um commit solto (não muda arquivos, índice nem a lista de stash);
// com a árvore limpa ele não devolve nada e aí o ponto de volta é o próprio HEAD.
function gitCheckpoint(dir) {
  const root = gitRoot(dir);
  if (!root) return null;
  const opt = { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] };
  let hash = '', kind = 'stash';
  try { hash = execFileSync('git', ['-C', gp(root), 'stash', 'create', 'agy-remote checkpoint'], opt).trim(); } catch {}
  if (!hash) { kind = 'head'; try { hash = execFileSync('git', ['-C', gp(root), 'rev-parse', 'HEAD'], opt).trim(); } catch {} }
  return /^[0-9a-f]{7,64}$/.test(hash) ? { hash, root, kind } : null;
}

// ---------- Git profissional: hunks, backups, lixeira, restaurar, commit/push/PR ----------
// Regras: só execFile/spawnSync com argumentos em array, caminhos com barras normais (gp), nada de
// reset --hard, clean -f ou push --force. Tudo que apaga ou sobrescreve faz backup antes:
// `git stash create` + `git stash store -m "agy-backup …"` (não some com o gc) ou a lixeira
// interna <repo>/.agentos/trash/<ts>/ (arquivos não rastreados nunca são apagados de vez).
class HttpErr extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
// GIT_LITERAL_PATHSPECS: nome de arquivo com * ou :(...) não vira curinga/mágica
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
function gitRun(root, args, opt = {}) {
  const r = require('child_process').spawnSync('git', ['-c', 'core.quotepath=false', '-C', gp(root), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: opt.timeout || 20000, maxBuffer: 32e6, env: GIT_ENV, input: opt.input,
  });
  if (r.error || r.status !== 0) {
    if (opt.soft) return null;
    const msg = String((r.stderr || '') + (r.stdout || '') || (r.error && r.error.message) || 'falhou').trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
    throw new HttpErr(opt.code || 400, `git ${args[0]}: ${msg.slice(0, 500)}`);
  }
  return opt.both ? { stdout: r.stdout, stderr: r.stderr } : r.stdout;
}
const gitZ = (out) => String(out || '').split('\0').filter(Boolean);
function chunked(list, n, fn) { for (let i = 0; i < list.length; i += n) fn(list.slice(i, i + n)); }
// root precisa ser uma pasta existente dentro de um repositório git; devolve o topo do repositório
function repoOf(rootIn) {
  const s = String(rootIn || '').trim();
  if (!s) throw new HttpErr(400, 'Informe a pasta do repositório (root).');
  const abs = path.resolve(s);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpErr(400, 'Pasta não existe: ' + abs);
  const top = gitRoot(abs);
  if (!top) throw new HttpErr(400, 'Não é um repositório git: ' + abs);
  return path.resolve(top);
}
// caminho relativo ao repositório, com barras normais, sem "..", sem caminho absoluto e fora do .git
function relFile(root, f) {
  const r = String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r) throw new HttpErr(400, 'Informe o arquivo.');
  if (r.includes('\0') || /^[a-zA-Z]:/.test(r) || r.startsWith('/') || r.split('/').some((s) => s === '..'))
    throw new HttpErr(400, 'Caminho inválido: o arquivo precisa ficar dentro do repositório (sem "..").');
  if (/^\.git(\/|$)/i.test(r)) throw new HttpErr(400, 'Caminho inválido: não mexo dentro de .git.');
  const abs = path.resolve(root, r);
  if (!abs.toLowerCase().startsWith(root.toLowerCase().replace(/[\\/]$/, '') + path.sep)) throw new HttpErr(400, 'Caminho inválido: fora do repositório.');
  return r;
}
function relFiles(root, list) {
  if (!Array.isArray(list)) throw new HttpErr(400, 'files precisa ser uma lista.');
  if (list.length > 2000) throw new HttpErr(400, 'Arquivos demais.');
  return [...new Set(list.map((f) => relFile(root, f)))];
}
function needConfirm(b) { if (b.confirm !== true) throw new HttpErr(428, 'Confirmação necessária: esta ação mexe nos arquivos (envie confirm: true).', { needConfirm: true }); }
const hasHeadRev = (root) => gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { soft: true }) !== null;
const isHash = (h) => /^[0-9a-f]{7,64}$/.test(String(h || ''));
function tsId() { const d = new Date(), z = (n, k = 2) => String(n).padStart(k, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}-${z(d.getMilliseconds(), 3)}`; }
// a lixeira e os backups não podem aparecer como "arquivos novos" no git status
function ensureExclude(root) {
  try {
    const p = path.resolve(root, String(gitRun(root, ['rev-parse', '--git-path', 'info/exclude'])).trim());
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (!cur.includes('/.agentos/trash/')) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + '# Agy Remote: lixeira e backups internos\n/.agentos/trash/\n/.agentos/backups/\n');
    }
  } catch {}
}
// backup do estado atual dos arquivos rastreados (índice + trabalho). Árvore limpa = o próprio HEAD.
function gitBackup(root, label) {
  const hash = String(gitRun(root, ['stash', 'create', 'agy-backup'], { soft: true }) || '').trim();
  if (isHash(hash)) {
    const when = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
    gitRun(root, ['stash', 'store', '-m', `agy-backup ${when} · ${String(label).slice(0, 120)}`, hash]);
    return { hash, kind: 'stash', label };
  }
  const head = String(gitRun(root, ['rev-parse', 'HEAD'], { soft: true }) || '').trim();
  return isHash(head) ? { hash: head, kind: 'head', label } : null;
}
function listBackups(root) {
  const out = gitRun(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ct%x1f%gs'], { soft: true }) || '';
  return out.split(/\r?\n/).filter((l) => l.includes('agy-backup')).slice(0, 60).map((l) => {
    const [ref, hash, ct, msg] = l.split('\x1f');
    return { ref, hash, at: Number(ct) * 1000, message: String(msg || '').replace(/^agy-backup\s*/, '') };
  });
}
// move para <repo>/.agentos/trash/<id>/<arquivo> (nunca apaga)
function moveToTrash(root, files, id) {
  ensureExclude(root);
  id = id || tsId();
  const moved = [];
  for (const rel of files) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(root, '.agentos', 'trash', id, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.renameSync(src, dst); } catch { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    moved.push(rel);
  }
  return { id, files: moved };
}
function walkFiles(dir, base, out, limit) {
  let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    if (out.length >= limit) return;
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), rel, out, limit); else out.push(rel);
  }
}
function listTrash(root) {
  const dir = path.join(root, '.agentos', 'trash');
  let ids = []; try { ids = fs.readdirSync(dir).filter((n) => /^[\w.-]+$/.test(n)).sort().reverse().slice(0, 40); } catch {}
  return ids.map((id) => { const files = []; walkFiles(path.join(dir, id), '', files, 200); return { id, files }; }).filter((t) => t.files.length);
}
// diff de UM arquivo contra o HEAD, dividido em cabeçalho + hunks (mesmo diff que a aba Mudanças mostra)
function fileHunks(root, file) {
  const d = gitRun(root, ['-c', 'diff.noprefix=false', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', file]);
  const lines = d.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  const head = [], hunks = []; let cur = null;
  for (const l of lines) {
    if (l.startsWith('@@')) { cur = { header: l, lines: [l] }; hunks.push(cur); continue; }
    if (cur) cur.lines.push(l); else head.push(l);
  }
  return { head, hunks, raw: d };
}
// restaura os arquivos rastreados para `hash` (só o arquivo de trabalho; o índice fica como está).
// Antes: backup do estado atual. Arquivos que o ponto não tem vão para a lixeira (não são apagados);
// não rastreados só vão se forem mais novos que `since` (criados/mexidos depois do checkpoint).
function restoreTo(root, hash, { since, files } = {}) {
  if (!isHash(hash)) throw new HttpErr(400, 'Hash inválido.');
  if (gitRun(root, ['cat-file', '-e', hash + '^{commit}'], { soft: true }) === null) throw new HttpErr(410, 'Esse ponto não existe mais no repositório (o git pode ter limpado objetos antigos).');
  ensureExclude(root);
  const backup = gitBackup(root, files && files.length ? 'antes de restaurar ' + files.slice(0, 3).join(', ') : 'antes de restaurar ' + hash.slice(0, 10));
  if (files && files.length) {
    const inTarget = new Set(gitZ(gitRun(root, ['ls-tree', '-r', '--name-only', '-z', hash, '--', ...files])));
    const missing = files.filter((f) => !inTarget.has(f));
    const trash = missing.length ? moveToTrash(root, missing) : null;
    const present = files.filter((f) => inTarget.has(f));
    if (present.length) chunked(present, 100, (part) => gitRun(root, ['restore', '--source=' + hash, '--worktree', '--', ...part]));
    return { backup, trash, files };
  }
  const inTarget = new Set(gitZ(gitRun(root, ['ls-tree', '-r', '--name-only', '-z', hash])));
  const tracked = gitZ(gitRun(root, ['ls-files', '-z']));
  const untracked = gitZ(gitRun(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const toTrash = [];
  for (const f of tracked) if (!inTarget.has(f) && fs.existsSync(path.join(root, f))) toTrash.push(f);
  for (const f of untracked) {
    if (/^\.agentos\//.test(f)) continue; // pasta das missões do Agente OS: não é do usuário mexer aqui
    if (inTarget.has(f)) { toTrash.push(f); continue; } // seria sobrescrito: guarda a versão atual
    if (since) { try { if (fs.statSync(path.join(root, f)).mtimeMs >= Number(since)) toTrash.push(f); } catch {} }
  }
  const trash = toTrash.length ? moveToTrash(root, toTrash) : null;
  if (inTarget.size) gitRun(root, ['restore', '--source=' + hash, '--worktree', '--', '.'], { timeout: 60000 });
  return { backup, trash, files: null };
}
const encBranch = (b) => String(b).split('/').map(encodeURIComponent).join('/');
function stripCred(u) { return String(u || '').replace(/^(\w+:\/\/)[^@/]+@/, '$1'); }
function githubRepo(u) { const m = String(u || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i); return m ? { owner: m[1], repo: m[2] } : null; }
function gitInfoFull(root) {
  const branch = gitBranch(root);
  const head = String(gitRun(root, ['rev-parse', '--short', 'HEAD'], { soft: true }) || '').trim();
  const upstream = String(gitRun(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { soft: true }) || '').trim();
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = String(gitRun(root, ['rev-list', '--left-right', '--count', upstream + '...HEAD'], { soft: true }) || '').trim().split(/\s+/);
    behind = Number(c[0]) || 0; ahead = Number(c[1]) || 0;
  } else if (head) {
    ahead = Number(String(gitRun(root, ['rev-list', '--count', 'HEAD'], { soft: true }) || '0').trim()) || 0;
  }
  const remotes = [];
  for (const l of String(gitRun(root, ['remote', '-v'], { soft: true }) || '').split(/\r?\n/)) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/); if (m) remotes.push({ name: m[1], url: stripCred(m[2]) });
  }
  const upRemote = upstream ? upstream.split('/')[0] : '';
  const remote = remotes.find((r) => r.name === upRemote) || remotes.find((r) => r.name === 'origin') || remotes[0] || null;
  return { git: true, root, branch, head, upstream: upstream || null, ahead, behind, remotes, remote, github: remote ? githubRepo(remote.url) : null };
}
function defaultBase(root, remote, branch) {
  if (remote) {
    const s = String(gitRun(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { soft: true }) || '').trim();
    if (s) return s.replace(remote + '/', '');
    for (const b of ['main', 'master', 'develop']) if (b !== branch && gitRun(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${b}`], { soft: true }) !== null) return b;
  }
  for (const b of ['main', 'master']) if (b !== branch && gitRun(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b], { soft: true }) !== null) return b;
  return 'main';
}
// GitHub CLI: instalado e logado? (gh auth status sai com código ≠ 0 sem login). Guardado por 10 min.
let ghCache = null, ghPending = null;
function ghStatus(force) {
  if (!force && ghCache && Date.now() - ghCache.at < 10 * 60e3) return Promise.resolve(ghCache);
  if (ghPending) return ghPending;
  ghPending = new Promise((resolve) => require('child_process').execFile('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 15000, windowsHide: true },
    (err, so, se) => {
      const txt = String(so || '') + String(se || '');
      const installed = !(err && (err.code === 'ENOENT' || /not recognized|não é reconhecido/i.test(txt)));
      const acct = (txt.match(/account\s+(\S+)/i) || txt.match(/Logged in to \S+ as (\S+)/i) || [])[1] || null;
      resolve(ghCache = { at: Date.now(), installed, authed: installed && !err, account: acct });
    })).finally(() => { ghPending = null; });
  return ghPending;
}
function gitLog(root, n) {
  if (!hasHeadRev(root)) return [];
  const out = gitRun(root, ['log', '-' + n, '--format=%h%x1f%H%x1f%s%x1f%an%x1f%ct%x1f%D']);
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [short, hash, subject, author, ct, refs] = l.split('\x1f'); return { short, hash, subject, author, at: Number(ct) * 1000, refs }; });
}

// ---------- Integrações (MCP) de cada CLI: só leitura ----------
const SECRET_KEY = /(key|token|secret|passw|authorization|cookie|bearer|credential)/i;
function maskVal(v) { const s = String(v); return s.length <= 6 ? '••••' : '••••' + s.slice(-4); }
function maskSecrets(o, k) {
  if (Array.isArray(o)) return o.map((x) => maskSecrets(x));
  if (o && typeof o === 'object') { const r = {}; for (const [kk, v] of Object.entries(o)) r[kk] = maskSecrets(v, kk); return r; }
  if (typeof o === 'string' && k && SECRET_KEY.test(k)) return maskVal(o);
  if (typeof o === 'string') return o.replace(/(Bearer\s+)[\w.\-]{8,}/gi, '$1••••').replace(/((?:api[_-]?key|token|secret)=)[^&\s"]{6,}/gi, '$1••••');
  return o;
}
function stripJsonc(s) {
  let out = '', i = 0, str = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (str) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = s.indexOf('*/', i + 2); i = i < 0 ? s.length : i + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
function readJsonLoose(file) { return JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); }
function tomlVal(v) {
  v = v.trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^\[.*\]$/.test(v)) { try { return JSON.parse(v.replace(/'/g, '"').replace(/,\s*\]$/, ']')); } catch { return v; } }
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
function codexMcp(file) {
  const servers = {}; let cur = null, sub = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const h = l.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|([\w-]+))(?:\.(\w+))?\s*\]$/);
    if (h) { cur = servers[h[1] || h[2]] = servers[h[1] || h[2]] || {}; sub = h[3] || null; continue; }
    if (l.startsWith('[')) { cur = null; continue; }
    const kv = l.match(/^([\w.-]+|"[^"]+")\s*=\s*(.+)$/);
    if (cur && kv) { const k = kv[1].replace(/"/g, ''); const val = tomlVal(kv[2].replace(/\s+#.*$/, '')); if (sub) (cur[sub] = cur[sub] || {})[k] = val; else cur[k] = val; }
  }
  return servers;
}
function serverRow(name, s) {
  const cmd = Array.isArray(s.command) ? s.command.join(' ') : [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(Boolean).join(' ');
  const url = s.url || s.httpUrl || s.serverUrl || '';
  return { name, type: s.type || (url ? 'http' : cmd ? 'stdio' : '?'), command: cmd || null, url: url || null, enabled: s.enabled !== false && s.disabled !== true };
}
const nonEmpty = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };
function integrationSources() {
  const H = HOME;
  const agyFiles = [path.join(H, '.gemini', 'config', 'mcp_config.json'), path.join(H, '.gemini', 'antigravity', 'mcp_config.json'), path.join(H, '.gemini', 'settings.json')];
  const ocFiles = [path.join(H, '.config', 'opencode', 'opencode.json'), path.join(H, '.config', 'opencode', 'opencode.jsonc')];
  return {
    claude: { name: 'Claude Code', file: path.join(H, '.claude.json') },
    codex: { name: 'Codex', file: path.join(H, '.codex', 'config.toml') },
    agy: { name: 'Antigravity', file: agyFiles.find(nonEmpty) || agyFiles.find((f) => fs.existsSync(f)) || agyFiles[0], candidates: agyFiles },
    opencode: { name: 'OpenCode', file: ocFiles.find(nonEmpty) || ocFiles.find((f) => fs.existsSync(f)) || ocFiles[0], candidates: ocFiles },
  };
}
let claudeMcpCache = null;
function claudeMcpList(force) {
  if (!force && claudeMcpCache && Date.now() - claudeMcpCache.at < 3 * 60e3) return Promise.resolve(claudeMcpCache);
  const info = engineInfo.claude;
  if (!info || !info.installed) return Promise.resolve({ at: Date.now(), error: 'Claude Code não instalado', servers: [] });
  return new Promise((resolve) => require('child_process').execFile(info.exe.path, [...(info.exe.prefix || []), 'mcp', 'list'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: HOME, maxBuffer: 4e6 }, (err, so, se) => {
      const txt = String(so || '');
      const servers = [];
      for (const l of txt.split(/\r?\n/)) {
        const m = l.match(/^(\S[^:]*?):\s+(.+?)\s+-\s+(.+)$/);
        if (!m || /^Checking/i.test(l)) continue;
        const st = m[3].trim();
        servers.push({ name: m[1].trim(), type: /\((HTTP|SSE)\)/i.test(m[2]) ? m[2].match(/\((\w+)\)/)[1].toLowerCase() : /^https?:/i.test(m[2]) ? 'http' : 'stdio',
          command: /^https?:/i.test(m[2]) ? null : maskSecrets(m[2]), url: /^https?:/i.test(m[2]) ? m[2].replace(/\s*\(\w+\)$/, '') : null,
          status: st, ok: /✓|connected/i.test(st) && !/fail|✗/i.test(st) });
      }
      const timedOut = err && (err.killed || err.signal);
      claudeMcpCache = { at: Date.now(), servers, raw: maskSecrets(txt.slice(0, 6000)),
        error: servers.length ? null : timedOut ? '`claude mcp list` passou de 15 s' : (/No MCP servers/i.test(txt) ? null : (err ? String(se || err.message).trim().slice(0, 200) : null)) };
      resolve(claudeMcpCache);
    }));
}
async function integrations(force) {
  const src = integrationSources(), out = [];
  // Claude: o que o próprio CLI lista (com status de conexão)
  const cl = await claudeMcpList(force);
  out.push({ id: 'claude', name: src.claude.name, file: src.claude.file, exists: fs.existsSync(src.claude.file), via: 'claude mcp list', servers: cl.servers, error: cl.error });
  for (const id of ['codex', 'agy', 'opencode']) {
    const s = src[id], row = { id, name: s.name, file: s.file, exists: fs.existsSync(s.file), via: path.basename(s.file), servers: [], error: null };
    if (row.exists && nonEmpty(s.file)) {
      try {
        const obj = id === 'codex' ? codexMcp(s.file) : (id === 'opencode' ? (readJsonLoose(s.file).mcp || {}) : (readJsonLoose(s.file).mcpServers || {}));
        row.servers = Object.entries(obj).map(([n, v]) => maskSecrets(serverRow(n, v || {})));
      } catch (e) { row.error = 'Não consegui ler: ' + e.message.slice(0, 160); }
    }
    out.push(row);
  }
  return out;
}
function integrationFile(id) {
  const s = integrationSources()[id];
  if (!s) throw new HttpErr(404, 'IA desconhecida');
  if (!fs.existsSync(s.file)) return { id, path: s.file, exists: false, content: '', candidates: s.candidates || [s.file] };
  if (fs.statSync(s.file).size > 4e6) return { id, path: s.file, exists: true, content: '(arquivo grande demais para mostrar)' };
  let content;
  if (id === 'claude') {
    // o ~/.claude.json guarda muito mais coisa (conta, histórico): mostramos só a parte de MCP
    const j = readJsonLoose(s.file), proj = {};
    for (const [p, v] of Object.entries(j.projects || {})) if (v && v.mcpServers && Object.keys(v.mcpServers).length) proj[p] = { mcpServers: v.mcpServers };
    content = JSON.stringify(maskSecrets({ mcpServers: j.mcpServers || {}, projects: proj }), null, 2);
  } else if (id === 'codex') {
    content = fs.readFileSync(s.file, 'utf8').replace(/^(\s*"?[\w.-]*(?:key|token|secret|passw|authorization|cookie|bearer|credential)[\w.-]*"?\s*=\s*)(["'])(.*?)\2/gim, (m0, a, q, v) => a + q + maskVal(v) + q);
  } else {
    try { content = JSON.stringify(maskSecrets(readJsonLoose(s.file)), null, 2); } catch { content = fs.readFileSync(s.file, 'utf8'); }
  }
  return { id, path: s.file, exists: true, content: content.slice(0, 400e3), masked: true, partial: id === 'claude' };
}

// rotas /api/git/* e /api/integrations (todas chamadas depois do check de autenticação)
async function gitApi(req, res, url, p) {
  const q = (k) => url.searchParams.get(k);
  const body = () => (req.method === 'POST' ? readBody(req) : Promise.resolve({}));
  try {
    if (p === '/api/git/info') {
      const dir = path.resolve(q('path') || q('root') || HOME);
      const root = fs.existsSync(dir) ? gitRoot(dir) : null;
      if (!root) return send(res, 200, { git: false }), true;
      const info = gitInfoFull(path.resolve(root));
      info.root = root; // mesmo formato de antes (o chat compara com a pasta)
      // gh: só espera a checagem quando pedem (full=1); senão usa o que já sabe e checa em segundo plano
      if (q('full') === '1') info.gh = await ghStatus(q('refresh') === '1');
      else { info.gh = ghCache; if (!ghCache) ghStatus().catch(() => {}); }
      return send(res, 200, info), true;
    }
    if (p === '/api/git/log' && req.method === 'GET') {
      const root = repoOf(q('root'));
      return send(res, 200, { log: gitLog(root, Math.min(50, Math.max(1, Number(q('n')) || 15))) }), true;
    }
    if (p === '/api/git/backups' && req.method === 'GET') {
      const root = repoOf(q('root'));
      return send(res, 200, { root, backups: listBackups(root), trash: listTrash(root) }), true;
    }
    if (p === '/api/git/hunks' && req.method === 'GET') {
      const root = repoOf(q('root')), file = relFile(root, q('file'));
      if (!hasHeadRev(root)) return send(res, 200, { hunks: [] }), true;
      const h = fileHunks(root, file);
      return send(res, 200, { hunks: h.hunks.map((x, i) => ({ index: i, header: x.header, lines: x.lines.length })) }), true;
    }
    if (p === '/api/git/hunk' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root), file = relFile(root, b.file);
      if (b.action !== 'revert') throw new HttpErr(400, 'Ação desconhecida (use action: "revert"; "manter" é só na tela).');
      needConfirm(b);
      if (!hasHeadRev(root)) throw new HttpErr(400, 'Repositório sem commits: use "Descartar arquivo".');
      const h = fileHunks(root, file), i = Math.floor(Number(b.hunkIndex));
      if (!(i >= 0 && i < h.hunks.length)) throw new HttpErr(409, 'Esse trecho não existe mais: o arquivo mudou. Atualize a lista.');
      if (b.header && b.header !== h.hunks[i].header) throw new HttpErr(409, 'O arquivo mudou desde que você abriu o diff. Atualize e tente de novo.');
      if (h.head.some((l) => /^(new file mode|deleted file mode|Binary files|GIT binary patch)/.test(l))) throw new HttpErr(400, 'Arquivo novo, apagado ou binário: use as ações do arquivo inteiro.');
      const patch = h.head.join('\n') + '\n' + h.hunks[i].lines.join('\n') + '\n';
      gitRun(root, ['apply', '-R', '--check', '--whitespace=nowarn', '-'], { input: patch, code: 409 });
      const backup = gitBackup(root, 'descartar trecho ' + (i + 1) + ' de ' + file);
      gitRun(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch, code: 409 });
      return send(res, 200, { ok: true, file, hunkIndex: i, backup }), true;
    }
    if (p === '/api/git/stage' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root), files = relFiles(root, b.files || (b.file ? [b.file] : []));
      if (!files.length) throw new HttpErr(400, 'Nenhum arquivo.');
      if (b.stage === false) {
        if (hasHeadRev(root)) chunked(files, 100, (part) => gitRun(root, ['restore', '--staged', '--', ...part]));
        else chunked(files, 100, (part) => gitRun(root, ['rm', '--cached', '-q', '-r', '--', ...part]));
      } else chunked(files, 100, (part) => gitRun(root, ['add', '-A', '--', ...part]));
      return send(res, 200, { ok: true, staged: b.stage !== false, files }), true;
    }
    if (p === '/api/git/discard' && req.method === 'POST') {
      // descarta tudo de um arquivo: rastreado → volta ao HEAD (com backup); novo → lixeira interna
      const b = await body(), root = repoOf(b.root), file = relFile(root, b.file);
      needConfirm(b);
      const head = hasHeadRev(root);
      const inHead = head && gitRun(root, ['cat-file', '-e', 'HEAD:' + file], { soft: true }) !== null;
      if (!inHead) {
        const inIndex = gitZ(gitRun(root, ['ls-files', '-z', '--', file])).length > 0;
        const trash = moveToTrash(root, [file]);
        if (inIndex) gitRun(root, ['rm', '--cached', '-q', '-r', '--', file], { soft: true });
        if (!trash.files.length) throw new HttpErr(404, 'Arquivo não encontrado.');
        return send(res, 200, { ok: true, file, trash }), true;
      }
      const backup = gitBackup(root, 'descartar mudanças de ' + file);
      gitRun(root, ['checkout', 'HEAD', '--', file]);
      return send(res, 200, { ok: true, file, backup }), true;
    }
    if (p === '/api/git/restore' && req.method === 'POST') {
      // checkpoint ou backup → arquivos de trabalho; files[] opcional restaura só esses arquivos
      const b = await body(), root = repoOf(b.root);
      needConfirm(b);
      const files = b.files ? relFiles(root, b.files) : null;
      const r = restoreTo(root, String(b.hash || '').trim(), { since: b.since ? Number(b.since) : null, files });
      return send(res, 200, { ok: true, hash: b.hash, ...r }), true;
    }
    if (p === '/api/git/trash/restore' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root);
      const id = String(b.id || ''); if (!/^[\w.-]+$/.test(id)) throw new HttpErr(400, 'Item da lixeira inválido.');
      const dir = path.join(root, '.agentos', 'trash', id);
      if (!fs.existsSync(dir)) throw new HttpErr(404, 'Item da lixeira não encontrado.');
      let files = []; walkFiles(dir, '', files, 5000);
      if (b.files) { const want = new Set(relFiles(root, b.files)); files = files.filter((f) => want.has(f)); }
      const restored = [], conflicts = [];
      for (const rel of files) {
        relFile(root, rel);
        const dst = path.join(root, rel), src = path.join(dir, rel);
        if (fs.existsSync(dst)) { conflicts.push(rel); continue; } // nunca sobrescreve o que está lá agora
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.renameSync(src, dst); } catch { fs.cpSync(src, dst); fs.rmSync(src, { force: true }); }
        restored.push(rel);
      }
      try { const left = []; walkFiles(dir, '', left, 1); if (!left.length) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return send(res, 200, { ok: true, restored, conflicts }), true;
    }
    if (p === '/api/git/commit' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root), files = relFiles(root, b.files || []);
      const message = String(b.message || '').replace(/\r\n/g, '\n').trim();
      if (!files.length) throw new HttpErr(400, 'Marque pelo menos um arquivo para o commit.');
      if (!message) throw new HttpErr(400, 'Escreva a mensagem do commit.');
      if (message.length > 20000) throw new HttpErr(400, 'Mensagem longa demais.');
      const head = hasHeadRev(root);
      // stage seletivo: só os arquivos marcados entram; o resto continua alterado, fora do índice
      const want = new Set(files);
      const staged = head ? gitZ(gitRun(root, ['diff', '--cached', '--name-only', '--no-renames', '-z'])) : gitZ(gitRun(root, ['ls-files', '-z']));
      const drop = staged.filter((f) => !want.has(f));
      if (drop.length) chunked(drop, 100, (part) => (head ? gitRun(root, ['restore', '--staged', '--', ...part]) : gitRun(root, ['rm', '--cached', '-q', '-r', '--', ...part])));
      chunked(files, 100, (part) => gitRun(root, ['add', '-A', '--', ...part]));
      if (!gitZ(gitRun(root, head ? ['diff', '--cached', '--name-only', '-z'] : ['ls-files', '-z'])).length) throw new HttpErr(400, 'Nada para commitar nesses arquivos.');
      gitRun(root, ['commit', '-F', '-'], { input: message + '\n', timeout: 60000 });
      const hash = String(gitRun(root, ['rev-parse', 'HEAD'])).trim();
      return send(res, 200, { ok: true, hash, short: hash.slice(0, 7), subject: message.split('\n')[0], files, branch: gitBranch(root) }), true;
    }
    if (p === '/api/git/undo-commit' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root);
      needConfirm(b);
      if (gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1'], { soft: true }) === null) throw new HttpErr(400, 'Não há commit anterior para voltar (este é o primeiro commit).');
      const upstream = String(gitRun(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { soft: true }) || '').trim();
      if (upstream && !b.allowPushed && gitRun(root, ['merge-base', '--is-ancestor', 'HEAD', upstream], { soft: true }) !== null)
        throw new HttpErr(409, 'Esse commit já foi enviado (push). Desfazer agora deixaria a branch diferente do remoto.', { pushed: true });
      const undone = String(gitRun(root, ['rev-parse', 'HEAD'])).trim();
      const subject = String(gitRun(root, ['log', '-1', '--format=%s'])).trim();
      gitRun(root, ['reset', '--soft', 'HEAD~1']);
      return send(res, 200, { ok: true, undone, subject, head: String(gitRun(root, ['rev-parse', '--short', 'HEAD'])).trim() }), true;
    }
    if (p === '/api/git/push' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root);
      const info = gitInfoFull(root);
      if (!info.branch) throw new HttpErr(400, 'HEAD destacado (sem branch): crie uma branch antes do push.');
      if (!info.head) throw new HttpErr(400, 'Ainda não há commits para enviar.');
      if (!info.remote) throw new HttpErr(400, 'Este repositório não tem remoto (git remote add origin <url>).');
      const args = info.upstream ? ['push'] : ['push', '-u', info.remote.name, info.branch];
      const r = gitRun(root, args, { both: true, timeout: 120000, code: 502 });
      const after = gitInfoFull(root);
      return send(res, 200, { ok: true, command: 'git ' + args.join(' '), output: (r.stderr + r.stdout).trim().slice(-2000), branch: info.branch, remote: info.remote.name, upstream: after.upstream, ahead: after.ahead, behind: after.behind }), true;
    }
    if (p === '/api/git/pr' && req.method === 'POST') {
      const b = await body(), root = repoOf(b.root);
      const info = gitInfoFull(root);
      if (!info.branch) throw new HttpErr(400, 'HEAD destacado: não dá para abrir PR.');
      const base = String(b.base || '').trim() || defaultBase(root, info.remote && info.remote.name, info.branch);
      if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new HttpErr(400, 'Branch base inválida.');
      if (base === info.branch) throw new HttpErr(400, `Você está na própria base (${base}). Crie uma branch para o PR.`);
      const title = String(b.title || '').trim() || String(gitRun(root, ['log', '-1', '--format=%s'], { soft: true }) || '').trim() || info.branch;
      const prBody = String(b.body || '').slice(0, 60000);
      const compare = info.github ? `https://github.com/${info.github.owner}/${info.github.repo}/compare/${encBranch(base)}...${encBranch(info.branch)}?expand=1` : null;
      const gh = await ghStatus();
      if (!b.preferUrl && info.github && gh.installed && gh.authed) {
        const r = await new Promise((resolve) => require('child_process').execFile('gh', ['pr', 'create', '--title', title.slice(0, 250), '--body', prBody || ' ', '--base', base, '--head', info.branch],
          { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, so, se) => resolve({ err, so: String(so || ''), se: String(se || '') })));
        const prUrl = (r.so.match(/https:\/\/\S+/g) || []).pop();
        if (!r.err && prUrl) return send(res, 200, { ok: true, via: 'gh', url: prUrl, base, branch: info.branch }), true;
        const existing = (r.se.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
        return send(res, 200, { ok: false, via: 'gh', url: existing || compare, existing: !!existing, base, branch: info.branch,
          error: (existing ? 'Já existe um PR para esta branch.' : 'gh pr create falhou: ' + (r.se || r.so || (r.err && r.err.message)).trim().slice(0, 300)) }), true;
      }
      const reason = !info.remote ? 'Sem remoto configurado.' : !info.github ? 'O remoto não é do GitHub: abra o PR pelo site do seu provedor.'
        : b.preferUrl ? 'Abrindo a página de comparação do GitHub.' : !gh.installed ? 'GitHub CLI (gh) não instalado: abrindo a página de comparação.' : 'gh sem login (rode "gh auth login"): abrindo a página de comparação.';
      return send(res, 200, { ok: !!compare, via: 'url', url: compare, reason, base, branch: info.branch, gh: { installed: gh.installed, authed: gh.authed } }), true;
    }
    if (p === '/api/git/ai-message' && req.method === 'POST') {
      // mensagem de commit pela IA mais barata (modelo `cheap` de cada motor), em modo só planejar
      const b = await body(), root = repoOf(b.root);
      const files = b.files ? relFiles(root, b.files) : [];
      if (files.length) chunked(files, 100, (part) => gitRun(root, ['add', '-A', '--', ...part]));
      let diff = gitRun(root, ['diff', '--staged', '--no-color', '--no-ext-diff', '--stat', '--patch', ...(files.length ? ['--', ...files] : [])], { timeout: 30000 });
      if (!diff.trim()) throw new HttpErr(400, 'Nada no stage: marque arquivos para o commit.');
      if (diff.length > 24000) diff = diff.slice(0, 24000) + '\n[... diff cortado ...]';
      const usable = usableEngines();
      const order = ['claude', 'codex', 'agy', 'opencode'];
      const id = usable.includes(b.engine) ? b.engine : order.find((e) => usable.includes(e) && ENGINES[e].cheap) || usable[0];
      if (!id) throw new HttpErr(400, 'Nenhuma IA ligada.');
      const dir = path.join(os.tmpdir(), 'agy-remote-teste'); fs.mkdirSync(dir, { recursive: true });
      const title = '✨ Mensagem de commit ' + crypto.randomBytes(3).toString('hex');
      const t0 = Date.now();
      let r;
      try {
        r = await runAsync({ prompt: 'Escreva a mensagem de commit (git) para o diff abaixo. Responda SOMENTE com a mensagem, sem comentários e sem crases: ' +
          'primeira linha com no máximo 72 caracteres no imperativo, em português do Brasil; se precisar, uma linha em branco e até 5 tópicos curtos.\n\n```diff\n' + diff + '\n```',
          cwd: dir, engine: id, model: ENGINES[id].cheap || undefined, mode: 'plan', device: 'teste', noFallback: true, title });
      } finally {
        const conv = Object.values(store.conversations).find((c) => c.title === title);
        if (conv) { delete store.conversations[conv.id]; persist(); }
      }
      if (r.status !== 'SUCCESS') throw new HttpErr(502, 'A IA não respondeu: ' + String(r.error || r.text || '').slice(0, 200));
      let msg = String(r.text || '').replace(/^```\w*\n?|```$/gm, '').trim();
      if (/^(["'])[\s\S]*\1$/.test(msg) && msg.length > 1) msg = msg.slice(1, -1).trim(); // só tira aspas que embrulham tudo
      msg = msg.slice(0, 4000);
      return send(res, 200, { message: msg, engine: id, model: ENGINES[id].cheap || 'padrão', seconds: (Date.now() - t0) / 1000 }), true;
    }
    if (p === '/api/integrations' && req.method === 'GET') {
      return send(res, 200, { engines: await integrations(q('refresh') === '1'), gh: await ghStatus() }), true;
    }
    if (p === '/api/integrations/file' && req.method === 'GET') return send(res, 200, integrationFile(String(q('id') || ''))), true;
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.code, { error: e.message, ...(e.extra || {}) }), true;
    if (e instanceof SyntaxError) return send(res, 400, { error: 'JSON inválido' }), true;
    throw e;
  }
  return false;
}
// O cmd.exe sem console escreve as mensagens dele na página de código OEM (850 no Windows em português).
// Se a saída não for UTF-8 válido, decodifica como cp850.
const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
function decodeOut(buf) {
  const utf = buf.toString('utf8');
  if (!utf.includes('�')) return utf;
  let out = ''; for (const b of buf) out += b < 128 ? String.fromCharCode(b) : CP850[b - 128];
  return out;
}
// Terminal do painel: um comando por vez, com shell, tempo e saída limitados.
const TERM_TIMEOUT = 120e3, TERM_LIMIT = 200 * 1024;
function runTerminal(cwd, cmd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const win = process.platform === 'win32';
    let proc;
    try {
      proc = win
        // chcp 65001: saída em UTF-8 (acentos do `dir` e cia. chegam certos)
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${cmd}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message, ms: 0 }); }
    const out = { stdout: [], stderr: [] };
    let used = 0, truncated = false, timedOut = false;
    const take = (which) => (chunk) => {
      if (used >= TERM_LIMIT) { truncated = true; return; }
      const part = chunk.length + used > TERM_LIMIT ? chunk.subarray(0, TERM_LIMIT - used) : chunk;
      if (part.length < chunk.length) truncated = true;
      used += part.length; out[which].push(part);
    };
    proc.stdout.on('data', take('stdout'));
    proc.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { try { proc.kill(); } catch {} }
    }, TERM_TIMEOUT);
    let finished = false;
    const finish = (code, errMsg) => {
      if (finished) return; finished = true; clearTimeout(timer);
      let stderr = decodeOut(Buffer.concat(out.stderr));
      if (errMsg) stderr += (stderr ? '\n' : '') + errMsg;
      if (timedOut) stderr += (stderr ? '\n' : '') + `[encerrado: passou de ${TERM_TIMEOUT / 1000}s]`;
      resolve({ code: code == null ? -1 : code, stdout: decodeOut(Buffer.concat(out.stdout)), stderr, ms: Date.now() - t0, truncated, timedOut });
    };
    proc.on('error', (e) => finish(-1, e.message));
    proc.on('close', (code) => finish(code));
  });
}
function rememberWorkspace(dir) {
  if (!dir) return;
  config.workspaces = [dir, ...config.workspaces.filter((w) => w.toLowerCase() !== dir.toLowerCase())].slice(0, 12);
  saveJson(CONFIG_FILE, config);
}

// ---------- transcrição de áudio (Whisper local do Zap IA + ffmpeg, tudo no PC) ----------
function findExe(cands) { for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} } return null; }
function whereExe(name) { try { return execFileSync('where', [name], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return null; } }
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
function whisperPaths() {
  for (const app of ['Zap IA', 'Suporte IA', 'Agy Remote']) {
    const dir = path.join(APPDATA, app, 'whisper');
    const exe = findExe([path.join(dir, 'bin', 'Release', 'whisper-cli.exe'), path.join(dir, 'bin', 'whisper-cli.exe')]);
    const model = findExe([path.join(dir, 'ggml-small-q5_1.bin')]);
    if (exe && model) return { exe, model };
  }
  return null;
}
let FFMPEG = null;
function ffmpegPath() { if (!FFMPEG) FFMPEG = process.env.FFMPEG_PATH || whereExe('ffmpeg.exe') || whereExe('ffmpeg'); return FFMPEG; }
function run(exe, args, timeout) {
  return new Promise((resolve, reject) => require('child_process').execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 16e6 },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().slice(-400))) : resolve(stdout))));
}
async function transcribe(buf, ext) {
  const w = whisperPaths(), ff = ffmpegPath();
  if (!w) throw new Error('Transcrição não instalada (Whisper do Zap IA não encontrado).');
  if (!ff) throw new Error('ffmpeg não encontrado no PC.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-audio-'));
  try {
    const src = path.join(tmp, 'in.' + (ext || 'webm')), wav = path.join(tmp, 'fala.wav'), out = path.join(tmp, 'fala');
    fs.writeFileSync(src, buf);
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', wav], 60000);
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    await run(w.exe, ['-m', w.model, '-l', 'pt', '-t', threads, '-nt', '-otxt', '-of', out, '-f', wav], 180000);
    return fs.readFileSync(out + '.txt', 'utf8').replace(/\s+/g, ' ').trim();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- eventos ao vivo (o app do celular escuta para notificar) ----------
const listeners = new Set();
function broadcast(ev) {
  const line = JSON.stringify({ ...ev, ts: Date.now() }) + '\n';
  for (const res of listeners) { try { res.write(line); } catch {} }
}
events.on('run-done', (r) => {
  const blocked = r.denied && r.denied.length;
  broadcast({ type: blocked ? 'blocked' : 'done', convId: r.convId, title: r.title, status: r.status,
    text: String(r.text || '').replace(/[*`#>]/g, '').slice(0, 200), denied: r.denied || [], tokens: r.usage ? r.usage.total_tokens : 0 });
});

let modelsCache = null;
async function listModels() {
  if (modelsCache && Date.now() - modelsCache.at < 3600e3) return modelsCache.list;
  try {
    const out = await new Promise((resolve, reject) => require('child_process').execFile(
      AGY, ['models'], { encoding: 'utf8', timeout: 30000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))));
    const list = out.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 2)
      .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
    modelsCache = { at: Date.now(), list };
    return list;
  } catch { return modelsCache ? modelsCache.list : []; }
}

// ---------- motores de IA ----------
const { ENGINES, TECH_FAIL, findImages } = require('./engines');
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
// salva um print/imagem que a IA gerou e devolve o caminho
function saveImage(run, img) {
  const hash = crypto.createHash('sha1').update(img.data.slice(0, 5000) + img.data.length).digest('hex').slice(0, 12);
  if ((run.imageHashes || (run.imageHashes = new Set())).has(hash)) return null;
  run.imageHashes.add(hash);
  const ext = /jpe?g/.test(img.mime) ? 'jpg' : /webp/.test(img.mime) ? 'webp' : 'png';
  const file = path.join(MEDIA, `${new Date().toISOString().slice(0, 10)}-${run.id}-${hash}.${ext}`);
  try { fs.writeFileSync(file, Buffer.from(img.data, 'base64')); return file; } catch { return null; }
}
// caminhos de imagem citados no texto da resposta (ex.: "salvei em C:\...\print.png")
function imagePathsIn(text, cwd) {
  const out = [];
  for (const m of String(text).matchAll(/([A-Za-z]:[\\/][^\s`'"<>|*?]+?\.(?:png|jpe?g|gif|webp))/gi)) {
    const p = m[1].replace(/\//g, '\\'); if (!out.includes(p) && fs.existsSync(p)) out.push(p);
  }
  for (const m of String(text).matchAll(/[`'"(]([\w.\-\\/ ]+?\.(?:png|jpe?g|gif|webp))[`'")]/gi)) {
    if (/^[A-Za-z]:/.test(m[1])) continue;
    const p = path.join(cwd, m[1]); if (!out.includes(p) && fs.existsSync(p)) out.push(p);
  }
  return out.slice(0, 12);
}
config.engines = Object.assign({
  enabled: { claude: true, codex: true, agy: true, opencode: true },
  order: ['claude', 'codex', 'agy', 'opencode'],
  default: 'claude',
  autoFallback: true,
  browser: false,
  models: {},
}, config.engines || {});
for (const id of Object.keys(ENGINES)) if (!config.engines.order.includes(id)) config.engines.order.push(id);
saveJson(CONFIG_FILE, config);

const engineInfo = {};      // id -> { exe, installed }
const engineHealth = {};    // id -> { ok, error, at }
// ---------- login de cada IA (conta logada x chave de API) ----------
const engineAuthLive = {};   // o que a própria CLI informou na última execução (Claude: apiKeySource)
let authCache = null;
function execOut(exe, args) {
  return new Promise((resolve) => require('child_process').execFile(exe.path, [...(exe.prefix || []), ...args],
    { encoding: 'utf8', timeout: 20000, windowsHide: true }, (err, so, se) => resolve(String(so || '') + String(se || ''))));
}
async function getAuth(force) {
  if (!force && authCache && Date.now() - authCache.at < 5 * 60e3) return authCache;
  const out = { at: Date.now() };
  if (engineInfo.claude && engineInfo.claude.installed) {
    try {
      const j = JSON.parse((await execOut(engineInfo.claude.exe, ['auth', 'status'])).match(/\{[\s\S]*\}/)[0]);
      const sub = j.loggedIn && j.authMethod === 'claude.ai';
      out.claude = { ok: !!sub, label: sub ? 'Conta claude.ai (assinatura)' : j.loggedIn ? 'Login: ' + j.authMethod : 'Não logado', method: j.authMethod };
    } catch { out.claude = { ok: false, label: 'Não consegui verificar' }; }
  }
  if (engineInfo.codex && engineInfo.codex.installed) {
    const t = await execOut(engineInfo.codex.exe, ['login', 'status']);
    const chat = /ChatGPT/i.test(t);
    out.codex = { ok: chat, label: chat ? 'Conta ChatGPT (assinatura)' : /api key/i.test(t) ? 'Chave de API — faça login com ChatGPT' : (t.trim().split('\n')[0] || 'Não logado') };
  }
  out.agy = { ok: true, label: 'Conta Google do Antigravity' };
  out.opencode = { ok: true, label: 'Modelos gratuitos do OpenCode' };
  return (authCache = out);
}

const QUOTA_FILE = path.join(DATA, 'engine-quota.json');
const engineQuota = loadJson(QUOTA_FILE, {}); // id -> cota informada pela própria CLI (Claude manda rate_limit_event)
function detectEngines() {
  for (const [id, e] of Object.entries(ENGINES)) {
    const exe = id === 'agy' ? { path: AGY, prefix: [] } : e.exe();
    engineInfo[id] = { exe, installed: !!(exe && exe.path && (exe.path === 'agy' || fs.existsSync(exe.path))) };
  }
}
detectEngines();
function engineList() {
  return config.engines.order.filter((id) => ENGINES[id]).map((id) => {
    const e = ENGINES[id];
    return {
      id, name: e.name, vendor: e.vendor, images: e.images, browser: e.browser, note: e.note,
      installed: engineInfo[id].installed, enabled: !!config.engines.enabled[id],
      path: engineInfo[id].exe ? [...(engineInfo[id].exe.prefix || []), engineInfo[id].exe.path].find((p) => !/node\.exe$/i.test(p)) || engineInfo[id].exe.path : null,
      health: engineHealth[id] || null, quota: engineQuota[id] || null,
      models: id === 'agy' ? (modelsCache ? modelsCache.list : []) : e.models,
      defaultModel: config.engines.models[id] || '', cheap: e.cheap || '',
    };
  });
}
function usableEngines() { return config.engines.order.filter((id) => ENGINES[id] && config.engines.enabled[id] && engineInfo[id].installed); }

// ---------- runs ----------
const runs = new Map(); // runId -> run
function activeRunFor(convId) {
  for (const r of runs.values()) if (!r.done && r.convId === convId) return r;
  return null;
}
function emit(run, ev) {
  ev.seq = run.events.length;
  run.events.push(ev);
  for (const res of run.listeners) res.write(JSON.stringify(ev) + '\n');
}
function newConv({ cwd, title, source, engine }) {
  const id = crypto.randomUUID();
  return store.conversations[id] = { id, title: title || 'Nova conversa', cwd, source: source || 'remote', engine, sessions: {},
    createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}
// conversas antigas eram só do agy (o id da conversa era o id da sessão do agy)
for (const c of Object.values(store.conversations)) {
  if (!c.sessions) { c.sessions = { agy: c.id }; c.engine = c.engine || 'agy'; }
}

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
function contextFor(conv, upto) {
  // Resumo das últimas mensagens para uma IA que ainda não participou da conversa
  const msgs = conv.messages.slice(0, upto).filter((m) => m.text).slice(-12);
  if (!msgs.length) return '';
  const lines = msgs.map((m) => `${m.role === 'user' ? 'Usuário' : 'IA (' + (ENGINES[m.engine] ? ENGINES[m.engine].name : 'assistente') + ')'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 700)}`);
  return `[Contexto: esta conversa já vinha acontecendo com outra IA. Últimas mensagens:]\n${lines.join('\n')}\n[Fim do contexto]\n\n`;
}

function startRun(opts) {
  const { convId, prompt, cwd, mode, skipPermissions, model, device } = opts;
  let conv = convId ? store.conversations[convId] : null;
  if (convId && !conv) {
    // sessão do agy feita no terminal do PC, ainda não importada
    conv = store.conversations[convId] = { id: convId, title: 'Sessão do PC', cwd: cwd || HOME, source: 'pc', engine: 'agy',
      sessions: { agy: convId }, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  }
  const workdir = (conv && conv.cwd) || cwd || config.workspaces[0] || HOME;
  if (!fs.existsSync(workdir)) throw new Error('Pasta não existe: ' + workdir);
  const usable = usableEngines();
  let first = opts.engine || (conv && conv.engine) || config.engines.default;
  if (!usable.includes(first)) first = usable[0];
  if (!first) throw new Error('Nenhuma IA ligada e instalada. Ative uma em Ajustes → IAs.');
  if (!conv) { conv = newConv({ cwd: workdir, title: (opts.title || prompt).replace(/\s+/g, ' ').slice(0, 60), engine: first }); if (device !== 'teste') rememberWorkspace(workdir); }

  const run = {
    id: crypto.randomBytes(8).toString('hex'), convId: conv.id, events: [], listeners: new Set(),
    done: false, proc: null, text: {}, tools: [], toolMap: {}, startedAt: Date.now(),
    model: model || null, lastInput: 0, device: device || null, attempts: [], usage: null, label: opts.label || null,
  };
  runs.set(run.id, run);
  const userIndex = conv.messages.length;
  if (!opts.noUserMessage) {
    // checkpoint (só em repositório git): permite ver depois tudo o que mudou a partir daqui
    let cp = null;
    if (device !== 'teste') { try { cp = gitCheckpoint(workdir); } catch {} }
    conv.messages.push({ role: 'user', text: prompt, ts: Date.now(), device: device || 'desconhecido', label: opts.label || undefined,
      mode: skipPermissions ? 'skip' : (mode || undefined),
      checkpoint: cp ? cp.hash : undefined, checkpointRoot: cp ? cp.root : undefined, checkpointKind: cp ? cp.kind : undefined });
  }
  conv.updatedAt = Date.now(); persist();

  const chain = opts.noFallback || !config.engines.autoFallback ? [first] : [first, ...usable.filter((e) => e !== first)];
  emit(run, { event: 'run_start', runId: run.id, cwd: workdir, convId: conv.id });
  emit(run, { event: 'conversation', convId: conv.id });
  events.emit('run-start', { device: device || 'desconhecido', prompt });

  const images = [];
  for (const m of String(prompt).matchAll(/^- (.+)$/gm)) if (IMG_RE.test(m[1].trim()) && fs.existsSync(m[1].trim())) images.push(m[1].trim());

  const attempt = (k) => {
    const engId = chain[k], eng = ENGINES[engId], info = engineInfo[engId];
    const session = conv.sessions[engId] || null;
    const fullPrompt = session ? prompt : contextFor(conv, userIndex) + prompt;
    const engModel = engId === first ? (model || config.engines.models[engId] || '') : (config.engines.models[engId] || '');
    const args = eng.args({ prompt: fullPrompt, session, model: engModel, mode, skip: !!skipPermissions, images, cwd: workdir,
      browser: !!(opts.browser ?? config.engines.browser) });
    const at = { engine: engId, startedAt: Date.now(), result: null, error: null, stderr: '', gotOutput: false };
    run.attempts.push(at);
    run.engine = engId; run.model = engModel || null;
    emit(run, { event: 'engine', engine: engId, name: eng.name, attempt: k + 1 });
    const st = { i: 0, tools: {}, items: {} };
    const base = k * 10000;
    const on = (e) => {
      if (e.kind === 'session') { conv.sessions[engId] = e.id; conv.engine = engId; persist(); return; }
      if (e.kind === 'text') {
        at.gotOutput = true;
        const key = base + e.index;
        run.text[key] = (run.text[key] || '') + e.delta;
        return emit(run, { event: 'step', step: { index: key, type: 'agent_response', text_delta: e.delta, engine: engId } });
      }
      if (e.kind === 'tool') {
        at.gotOutput = true;
        const key = base + e.index;
        const prev = run.toolMap[key] || {};
        const t = run.toolMap[key] = { name: e.name || prev.name, params: (e.params && Object.values(e.params).some(Boolean)) ? e.params : (prev.params || {}), duration: e.duration, engine: engId, state: e.state };
        if (e.state === 'done' && !prev.doneLogged) { t.doneLogged = true; run.tools.push({ name: t.name, params: t.params, duration: t.duration, engine: engId }); }
        return emit(run, { event: 'step', step: { index: key, type: 'tool', state: e.state === 'done' ? 'DONE' : 'ACTIVE', tool: t.name, params: t.params, duration: e.duration, engine: engId } });
      }
      if (e.kind === 'usage') { run.lastInput = (e.usage.input_tokens || 0) + (e.usage.cache_read_tokens || 0); return emit(run, { event: 'step', step: { index: base + 9999, type: 'usage', usage: e.usage } }); }
      if (e.kind === 'auth') { engineAuthLive[engId] = { source: e.source, at: Date.now() }; return; }
      if (e.kind === 'quota') { engineQuota[engId] = { ...e.data, at: Date.now() }; try { saveJson(QUOTA_FILE, engineQuota); } catch {} return; }
      if (e.kind === 'error') { at.error = e.message; return; }
      if (e.kind === 'result') { at.result = e; if (e.error) at.error = e.error; }
    };
    let proc;
    try {
      const env = { ...process.env, ...(eng.env ? eng.env(DATA) : {}) };
      for (const k of eng.stripEnv || []) delete env[k]; // garante a conta logada, nunca chave de API
      proc = spawn(info.exe.path, [...(info.exe.prefix || []), ...args], { cwd: workdir, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { at.error = err.message; return afterAttempt(k, null); }
    run.proc = proc;
    let buf = '', lastSeen = Date.now();
    // vigia: IA calada por muito tempo = travada → encerra (conta como falha técnica)
    const idleMs = (config.engines.idleMinutes || 8) * 60e3;
    const watch = setInterval(() => {
      if (Date.now() - lastSeen > idleMs) {
        at.error = `timed out: ${eng.name} ficou ${config.engines.idleMinutes || 8} min sem responder`;
        try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch { try { proc.kill(); } catch {} }
      }
    }, 20e3);
    proc.on('close', () => clearInterval(watch));
    const onLine = (line) => {
      lastSeen = Date.now();
      line = line.trim(); if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { at.stderr = (at.stderr + '\n' + line).slice(-2000); return; }
      try { eng.parse(ev, on, st); } catch (err) { at.stderr += '\n' + err.message; }
      // prints e imagens que vierem dentro do evento (ex.: screenshot do Claude in Chrome)
      if (line.length > 2000 && /"image"/.test(line)) {
        for (const img of findImages(ev)) {
          const file = saveImage(run, img);
          if (file) { (run.images || (run.images = [])).push(file); emit(run, { event: 'image', path: file }); }
        }
      }
    };
    proc.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    proc.stderr.on('data', (d) => { at.stderr = (at.stderr + d.toString('utf8')).slice(-3000); });
    proc.on('error', (err) => { at.error = 'Não consegui iniciar ' + eng.name + ': ' + err.message; });
    proc.on('close', (code) => { if (buf.trim()) onLine(buf); at.exitCode = code; afterAttempt(k, code); });
  };

  const afterAttempt = (k, code) => {
    if (run.done) return;
    const at = run.attempts[k], engId = at.engine;
    if (run.cancelled) return finishRun(run, conv, { status: 'CANCELLED' });
    const res = at.result;
    const ok = res && res.status === 'ok' && !at.error;
    const anyOutput = at.gotOutput || (res && (res.text || (res.denied && res.denied.length)));
    if (ok || (code === 0 && anyOutput && !at.error)) {
      engineHealth[engId] = { ok: true, at: Date.now() };
      return finishRun(run, conv, { status: 'SUCCESS', response: res && res.text, usage: res && res.usage, denied: (res && res.denied) || [], cost: res && res.cost });
    }
    // falhou: decide se é falha técnica (troca de IA) ou não
    const reason = String(at.error || (at.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || ('saiu com código ' + code)).slice(0, 300);
    engineHealth[engId] = { ok: false, error: reason, at: Date.now() };
    const technical = !anyOutput || TECH_FAIL.test(reason);
    if (technical && k + 1 < chain.length) {
      emit(run, { event: 'fallback', from: engId, to: chain[k + 1], fromName: ENGINES[engId].name, toName: ENGINES[chain[k + 1]].name, reason });
      run.fallbacks = (run.fallbacks || []).concat({ from: engId, to: chain[k + 1], reason });
      return attempt(k + 1);
    }
    finishRun(run, conv, { status: 'ERROR', error: reason, usage: res && res.usage });
  };

  attempt(0);
  return run;
}

function finishRun(run, conv, info) {
  if (run.done) return;
  run.done = true;
  const streamed = Object.keys(run.text).sort((a, b) => a - b).map((k) => run.text[k]).join('\n\n').trim();
  let text = streamed || (info.response || '').trim();
  if (!text && info.status === 'ERROR') text = 'Não deu certo: ' + (info.error || 'erro desconhecido');
  const usage = info.usage ? { ...info.usage, lastInput: run.lastInput } : null;
  info.usage = usage;
  info.duration = (Date.now() - run.startedAt) / 1000;
  const denied = (info.denied || []).map((d) => (typeof d === 'string' ? { display_name: d } : d));
  conv.messages.push({
    // prints já capturados do stream não se repetem pelo caminho temporário que a extensão cita no texto
    images: [...new Set([...(run.images || []), ...imagePathsIn(text, conv.cwd).filter((p) => !(run.images && run.images.length && /claude-chrome-screenshots/i.test(p)))])].slice(0, 20),
    role: 'assistant', text, ts: Date.now(), tools: run.tools, engine: run.engine,
    status: info.status, denied, usage, duration: info.duration, model: run.model, cost: info.cost,
    fallbacks: run.fallbacks || undefined, error: info.error || undefined, label: run.label || undefined,
  });
  conv.engine = run.engine || conv.engine;
  if (run.engine === 'claude') getClaudeUsage(true).catch(() => {}); // atualiza a cota exata depois de usar
  conv.updatedAt = Date.now();
  persist();
  emit(run, { event: 'done', ...info, denied, text, convId: conv.id, engine: run.engine });
  events.emit('run-done', { convId: conv.id, title: conv.title, text, status: info.status, usage, denied: denied.map((d) => d.display_name || d.action), device: run.device });
  for (const res of run.listeners) res.end();
  run.listeners.clear();
  if (run.onDone) run.onDone({ status: info.status, text, error: info.error });
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000);
}

// ---------- equipe (vários agentes): planejar → executar etapas → revisar ----------
function extractJson(text) {
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/) || String(text).match(/(\{[\s\S]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function runAsync(opts) {
  return new Promise((resolve, reject) => {
    try {
      const r = startRun(opts);
      if (r.done) { const c = store.conversations[r.convId], last = c && c.messages[c.messages.length - 1]; resolve({ status: last ? last.status : 'ERROR', text: last ? last.text : '', error: last && last.error }); }
      else r.onDone = resolve;
    } catch (e) { reject(e); }
  });
}
async function startTeam({ goal, cwd, lead, workers, mode, skipPermissions, device, browser }) {
  const usable = usableEngines();
  lead = usable.includes(lead) ? lead : usable[0];
  workers = (workers || []).filter((w) => usable.includes(w));
  if (!workers.length) workers = usable.slice(0, 3);
  if (!lead) throw new Error('Nenhuma IA disponível.');
  const conv = newConv({ cwd, title: '👥 ' + goal.replace(/\s+/g, ' ').slice(0, 56), engine: lead });
  rememberWorkspace(cwd);
  conv.team = { goal, lead, workers, state: 'planejando', steps: [], startedAt: Date.now() };
  conv.messages.push({ role: 'user', text: goal, ts: Date.now(), device: device || 'desconhecido' });
  persist();
  (async () => {
    const T = conv.team;
    try {
      const planPrompt = `Você é o coordenador de uma equipe de agentes de IA (${workers.map((w) => ENGINES[w].name).join(', ')}).\n` +
        `Objetivo do usuário:\n${goal}\n\nPasta do projeto: ${cwd}\n\n` +
        `Analise a pasta se precisar e divida o trabalho em 2 a 6 etapas concretas e em ordem. ` +
        `Responda SOMENTE com JSON neste formato:\n{"steps":[{"title":"título curto","prompt":"instrução completa e autossuficiente para o agente","engine":"${workers.join('|')}"}]}\n` +
        `Escolha o engine de cada etapa entre: ${workers.join(', ')}. Não execute nada agora, só planeje.`;
      const plan = await runAsync({ convId: conv.id, prompt: planPrompt, mode: 'plan', engine: lead, device: 'equipe', noUserMessage: true, label: '🧭 Plano', noFallback: false });
      const parsed = extractJson(plan.text);
      const steps = parsed && Array.isArray(parsed.steps) ? parsed.steps.slice(0, 8) : null;
      if (!steps || !steps.length) throw new Error('O coordenador não devolveu um plano válido.');
      T.steps = steps.map((s, i) => ({ title: String(s.title || 'Etapa ' + (i + 1)).slice(0, 80), prompt: String(s.prompt || s.title || ''),
        engine: workers.includes(s.engine) ? s.engine : workers[i % workers.length], status: 'pendente' }));
      T.state = 'executando'; persist();
      const done = [];
      for (let i = 0; i < T.steps.length; i++) {
        if (T.state === 'cancelado') break;
        const s = T.steps[i];
        s.status = 'rodando'; s.startedAt = Date.now(); persist();
        const prompt = `Você faz parte de uma equipe. Objetivo geral: ${goal}\n` +
          (done.length ? `Etapas já concluídas por outros agentes:\n${done.map((d) => '- ' + d).join('\n')}\n` : '') +
          `\nSua etapa (${i + 1}/${T.steps.length}) — ${s.title}:\n${s.prompt}\n\nTrabalhe na pasta ${cwd}. Ao terminar, resuma em poucas linhas o que fez.`;
        const r = await runAsync({ convId: conv.id, prompt, engine: s.engine, mode, skipPermissions, device: 'equipe', browser, noUserMessage: true, label: `${i + 1}. ${s.title}` });
        s.status = r.status === 'SUCCESS' ? 'ok' : r.status === 'CANCELLED' ? 'cancelado' : 'erro';
        s.engineUsed = conv.engine; s.finishedAt = Date.now();
        done.push(`${s.title}: ${String(r.text).replace(/\s+/g, ' ').slice(0, 300)}`);
        persist();
        if (r.status === 'CANCELLED') { T.state = 'cancelado'; break; }
      }
      if (T.state !== 'cancelado') {
        T.state = 'revisando'; persist();
        await runAsync({ convId: conv.id, engine: lead, mode: 'plan', device: 'equipe', noUserMessage: true, label: '✅ Revisão final',
          prompt: `Revise o trabalho da equipe para o objetivo: ${goal}\nEtapas:\n${done.map((d) => '- ' + d).join('\n')}\n\nConfira os arquivos na pasta ${cwd}, aponte o que ficou faltando ou com problema e dê um resumo final para o usuário.` });
        T.state = 'concluido';
      }
    } catch (e) {
      T.state = 'erro'; T.error = e.message;
      conv.messages.push({ role: 'assistant', text: 'A equipe parou: ' + e.message, ts: Date.now(), status: 'ERROR', label: '⚠️ Equipe' });
    }
    T.finishedAt = Date.now(); conv.updatedAt = Date.now(); persist();
    broadcast({ type: T.state === 'concluido' ? 'done' : 'blocked', convId: conv.id, title: conv.title, status: T.state, text: T.state === 'concluido' ? 'A equipe terminou todas as etapas.' : (T.error || 'A equipe parou.'), denied: [] });
  })();
  return conv;
}

// ---------- Agente OS (missões com várias IAs coordenadas) ----------
function cancelConv(convId) {
  const r = activeRunFor(convId);
  if (!r) return;
  r.cancelled = true;
  try { execFileSync('taskkill', ['/pid', String(r.proc.pid), '/T', '/F']); } catch { try { r.proc.kill(); } catch {} }
}
const agentOS = require('./agentos')({ store, persist, runAsync, ENGINES, usableEngines, broadcast, newConv, extractJson, cancelConv, config });
// ---------- Automações agendadas (server/automations.js): missões/prompts recorrentes ----------
const automations = fs.existsSync(path.join(__dirname, 'automations.js'))
  ? require('./automations')({ store, persist, agentOS, runAsync, startRun, ENGINES, usableEngines, broadcast, config, saveJson, DATA })
  : null;

// ---------- memória (bloco gerenciado dentro de ~/.gemini/GEMINI.md, lido pelo agy no PC e via app) ----------
function readMemory() {
  let full = '';
  try { full = fs.readFileSync(GEMINI_MD, 'utf8'); } catch {}
  const a = full.indexOf(MEM_START), b = full.indexOf(MEM_END);
  const block = a >= 0 && b > a ? full.slice(a + MEM_START.length, b).replace(/^\s*## Memória \(Agy Remote\)\s*/, '').trim() : '';
  return { full, block };
}
function writeMemory(block) {
  const { full } = readMemory();
  const bak = GEMINI_MD + '.bak-agyremote';
  if (full && !fs.existsSync(bak)) fs.writeFileSync(bak, full);
  const section = `${MEM_START}\n## Memória (Agy Remote)\n${block.trim()}\n${MEM_END}`;
  const a = full.indexOf(MEM_START), b = full.indexOf(MEM_END);
  const next = a >= 0 && b > a
    ? full.slice(0, a) + section + full.slice(b + MEM_END.length)
    : (full.trimEnd() + '\n\n' + section + '\n');
  fs.mkdirSync(path.dirname(GEMINI_MD), { recursive: true });
  fs.writeFileSync(GEMINI_MD, next);
}

// ---------- helpers HTTP ----------
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// Bloqueia DNS rebinding e páginas de outros sites: Host e Origin precisam ser o próprio endereço local.
function isLocalRequest(req) {
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  const host = String(req.headers.host || '');
  if (!isLoopback(req) || !local.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || String(origin).toLowerCase() === 'http://' + host.toLowerCase();
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function authed(req) {
  const t = req.headers['x-agy-token'] || '';
  return t.length === config.token.length &&
    crypto.timingSafeEqual(Buffer.from(t), Buffer.from(config.token));
}
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) {
        out.push({ name, ip: i.address, tailscale: i.address.startsWith('100.') });
      }
    }
  }
  return out;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

// ---------- rotas ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/pair' && req.method === 'POST') {
    const now = Date.now();
    while (pairAttempts.length && now - pairAttempts[0] > 10 * 60 * 1000) pairAttempts.shift();
    if (pairAttempts.length >= 10) return send(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' });
    pairAttempts.push(now);
    const body = await readBody(req);
    if (String(body.code || '').trim() !== pairCode) return send(res, 403, { error: 'Código incorreto.' });
    return send(res, 200, { token: config.token });
  }
  if (p === '/api/local-token') {
    if (!isLocalRequest(req)) return send(res, 403, { error: 'Só no próprio PC.' });
    return send(res, 200, { token: config.token, pairCode, addresses: lanAddresses(), port: config.port });
  }
  if (!authed(req)) return send(res, 401, { error: 'Não autorizado. Pareie o dispositivo.' });

  if (p === '/api/info') {
    return send(res, 200, { host: os.hostname(), agy: AGY, workspaces: config.workspaces, addresses: lanAddresses(), port: config.port });
  }
  if (p.startsWith('/api/missions') && await agentOS.route(req, res, url, p, readBody, send)) return;
  if (p.startsWith('/api/automations') && automations && await automations.route(req, res, url, p, readBody, send)) return;
  if (p === '/api/usage') return send(res, 200, usageReport());
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write(JSON.stringify({ type: 'hello', host: os.hostname(), ts: Date.now() }) + '\n');
    listeners.add(res);
    const ka = setInterval(() => res.write(JSON.stringify({ type: 'ping', ts: Date.now() }) + '\n'), 25000);
    req.on('close', () => { clearInterval(ka); listeners.delete(res); });
    return;
  }
  if (p === '/api/transcribe' && req.method === 'POST') {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 25e6) return send(res, 413, { error: 'Áudio muito grande' }); chunks.push(c); }
    const ext = (url.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    try { return send(res, 200, { text: await transcribe(Buffer.concat(chunks), ext) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/api/transcribe' && req.method === 'GET') return send(res, 200, { ready: !!(whisperPaths() && ffmpegPath()) });
  if (p === '/api/activity') return send(res, 200, { items: activity(Number(url.searchParams.get('limit') || 30)) });
  if (p === '/api/quota') {
    const force = url.searchParams.get('force') === '1';
    const [agyQ, claudeQ] = await Promise.all([getQuota(force).catch((e) => ({ error: e.message, groups: [] })), getClaudeUsage(force).catch(() => null)]);
    return send(res, 200, { ...agyQ, engines: engineQuota, exact: { claude: claudeQ, codex: getCodexUsage() } });
  }
  if (p === '/api/fs/list') {
    const dir = url.searchParams.get('path');
    if (!dir) return send(res, 200, { path: '', parent: '', roots: [{ name: 'Pasta do usuário', path: HOME }, ...drives().map((d) => ({ name: 'Disco ' + d.slice(0, 2), path: d }))], recent: config.workspaces, entries: [] });
    try { return send(res, 200, listDir(path.resolve(dir))); } catch (e) { return send(res, 400, { error: 'Não consegui abrir: ' + e.message }); }
  }
  if (p === '/api/fs/read') {
    const file = path.resolve(url.searchParams.get('path') || '');
    try {
      const st = fs.statSync(file);
      if (st.isDirectory()) return send(res, 400, { error: 'É uma pasta' });
      const ext = path.extname(file).toLowerCase();
      if (IMG_MIME[ext]) return send(res, 200, { kind: 'image', size: st.size, mime: IMG_MIME[ext] });
      const fd = fs.openSync(file, 'r'); const len = Math.min(st.size, 512e3); const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0); fs.closeSync(fd);
      if (!isText(file, buf)) return send(res, 200, { kind: 'binary', size: st.size });
      return send(res, 200, { kind: 'text', size: st.size, truncated: st.size > len, text: buf.toString('utf8') });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/fs/raw') {
    const file = path.resolve(url.searchParams.get('path') || '');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Arquivo não encontrado' });
    res.writeHead(200, { 'content-type': IMG_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/api/fs/changes') {
    try { return send(res, 200, gitChanges(path.resolve(url.searchParams.get('path') || HOME))); }
    catch (e) { return send(res, 200, { git: false, files: [], error: e.message }); }
  }
  if (p === '/api/fs/diff') return send(res, 200, { diff: gitDiff(url.searchParams.get('root'), url.searchParams.get('file')) });
  // /api/git/info (projeto/branch/ahead/behind/remoto/gh), hunks, backups, restaurar, commit, push, PR e integrações MCP
  if ((p.startsWith('/api/git/') || p.startsWith('/api/integrations')) && await gitApi(req, res, url, p)) return;
  if (p === '/api/terminal' && req.method === 'POST') {
    const b = await readBody(req);
    const cmd = String(b.cmd || '').trim();
    const cwd = path.resolve(String(b.cwd || config.workspaces[0] || HOME));
    if (!cmd) return send(res, 400, { error: 'Comando vazio' });
    if (cmd.length > 8000) return send(res, 400, { error: 'Comando longo demais' });
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return send(res, 400, { error: 'Pasta não existe: ' + cwd });
    return send(res, 200, { cwd, ...(await runTerminal(cwd, cmd)) });
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const cwd = url.searchParams.get('cwd') || HOME;
    const name = path.basename(url.searchParams.get('name') || 'arquivo').replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120);
    const dir = path.join(cwd, '.agy-remote', 'anexos');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${Date.now().toString(36)}-${name}`);
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 30e6) return send(res, 413, { error: 'Arquivo maior que 30 MB' }); chunks.push(c); }
    fs.writeFileSync(target, Buffer.concat(chunks));
    return send(res, 200, { path: target, name, size });
  }
  if (p === '/api/workspaces/use' && req.method === 'POST') {
    const body = await readBody(req);
    const dir = String(body.path || '').trim();
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'Pasta não encontrada no PC' });
    rememberWorkspace(dir);
    return send(res, 200, { workspaces: config.workspaces });
  }
  if (p === '/api/models') return send(res, 200, { models: await listModels() });
  if (p === '/api/conversations' && req.method === 'GET') {
    const list = Object.values(store.conversations).sort((a, b) => b.updatedAt - a.updatedAt).map(convSummary);
    return send(res, 200, { conversations: list });
  }
  let m = p.match(/^\/api\/conversations\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const c = store.conversations[m[1]];
    if (!c) return send(res, 404, { error: 'Conversa não encontrada' });
    const r = activeRunFor(c.id);
    return send(res, 200, { conversation: c, activeRun: r ? r.id : null });
  }
  if (m && req.method === 'PATCH') {
    const c = store.conversations[m[1]];
    if (!c) return send(res, 404, { error: 'Conversa não encontrada' });
    const body = await readBody(req);
    if (body.title) c.title = String(body.title).slice(0, 100);
    persist();
    return send(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    delete store.conversations[m[1]];
    persist();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/pc-conversations') {
    let files = [];
    try { files = fs.readdirSync(CLI_CONV_DIR).filter((f) => f.endsWith('.db')); } catch {}
    const list = files.map((f) => {
      const id = f.slice(0, -3);
      return { id, mtime: fs.statSync(path.join(CLI_CONV_DIR, f)).mtimeMs };
    }).filter((x) => !store.conversations[x.id]).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    return send(res, 200, { conversations: list });
  }
  if (p === '/api/runs' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.prompt || !String(body.prompt).trim()) return send(res, 400, { error: 'Mensagem vazia' });
    if (body.convId && activeRunFor(body.convId)) return send(res, 409, { error: 'Esta conversa já está rodando.' });
    try {
      const run = startRun({
        convId: body.convId || null, prompt: String(body.prompt), cwd: body.cwd, engine: body.engine,
        mode: body.mode, skipPermissions: !!body.skipPermissions, model: body.model, device: body.device,
        browser: body.browser,
      });
      return send(res, 200, { runId: run.id, convId: run.convId });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/engines' && req.method === 'GET') {
    if (url.searchParams.get('refresh') === '1') detectEngines();
    if (!modelsCache) listModels().catch(() => {});
    const auth = await getAuth(url.searchParams.get('refresh') === '1').catch(() => ({}));
    const list = engineList().map((e) => {
      const a = auth[e.id] ? { ...auth[e.id] } : null;
      // se a última execução do Claude disser que usou chave, avisa
      if (e.id === 'claude' && a && engineAuthLive.claude && engineAuthLive.claude.source && engineAuthLive.claude.source !== 'none') { a.ok = false; a.label = 'Usou chave de API (' + engineAuthLive.claude.source + ')'; }
      return { ...e, auth: a };
    });
    return send(res, 200, { engines: list, autoFallback: config.engines.autoFallback, browser: config.engines.browser, default: config.engines.default });
  }
  if (p === '/api/engines' && req.method === 'PUT') {
    const b = await readBody(req), E = config.engines;
    if (b.enabled && typeof b.enabled === 'object') for (const [k, v] of Object.entries(b.enabled)) if (ENGINES[k]) E.enabled[k] = !!v;
    if (Array.isArray(b.order)) E.order = b.order.filter((k) => ENGINES[k]).concat(Object.keys(ENGINES).filter((k) => !b.order.includes(k)));
    if (b.default && ENGINES[b.default]) E.default = b.default;
    if (typeof b.autoFallback === 'boolean') E.autoFallback = b.autoFallback;
    if (typeof b.browser === 'boolean') E.browser = b.browser;
    if (b.models && typeof b.models === 'object') for (const [k, v] of Object.entries(b.models)) if (ENGINES[k]) E.models[k] = String(v || '');
    saveJson(CONFIG_FILE, config);
    return send(res, 200, { engines: engineList(), autoFallback: E.autoFallback, browser: E.browser, default: E.default });
  }
  // Testa uma IA com o modelo mais barato dela e um pedido mínimo (não cria conversa visível)
  m = p.match(/^\/api\/engines\/(\w+)\/test$/);
  if (m && req.method === 'POST') {
    const id = m[1];
    if (!ENGINES[id]) return send(res, 404, { error: 'IA desconhecida' });
    if (!engineInfo[id].installed) return send(res, 200, { ok: false, error: 'Não instalada neste PC' });
    const dir = path.join(os.tmpdir(), 'agy-remote-teste'); fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    try {
      const r = await runAsync({ prompt: 'Responda apenas: ok', cwd: dir, engine: id, model: ENGINES[id].cheap || undefined,
        mode: 'plan', device: 'teste', noFallback: true, title: '🧪 Teste ' + ENGINES[id].name });
      const conv = Object.values(store.conversations).find((c) => c.title === '🧪 Teste ' + ENGINES[id].name && c.cwd === dir);
      const last = conv && conv.messages[conv.messages.length - 1];
      if (conv) { delete store.conversations[conv.id]; persist(); }
      return send(res, 200, { ok: r.status === 'SUCCESS', seconds: (Date.now() - t0) / 1000, model: ENGINES[id].cheap || 'padrão',
        tokens: last && last.usage ? last.usage.total_tokens : null, text: String(r.text).slice(0, 120), error: r.error || null });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/team' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.goal || !String(b.goal).trim()) return send(res, 400, { error: 'Descreva o objetivo da equipe' });
    const dir = b.cwd || config.workspaces[0] || HOME;
    if (!fs.existsSync(dir)) return send(res, 400, { error: 'Pasta não existe: ' + dir });
    try {
      const conv = await startTeam({ goal: String(b.goal), cwd: dir, lead: b.lead, workers: b.workers, mode: b.mode,
        skipPermissions: !!b.skipPermissions, device: b.device, browser: b.browser });
      return send(res, 200, { convId: conv.id });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  m = p.match(/^\/api\/conversations\/([\w-]+)\/team\/cancel$/);
  if (m && req.method === 'POST') {
    const c = store.conversations[m[1]];
    if (!c || !c.team) return send(res, 404, { error: 'Equipe não encontrada' });
    c.team.state = 'cancelado'; persist();
    const r = activeRunFor(c.id);
    if (r) { r.cancelled = true; try { execFileSync('taskkill', ['/pid', String(r.proc.pid), '/T', '/F']); } catch { try { r.proc.kill(); } catch {} } }
    return send(res, 200, { ok: true });
  }
  // Bifurcar: conversa nova com as mensagens até `upto` (inclusive). Sem sessões: cada IA recebe o
  // histórico pelo contextFor na primeira mensagem.
  m = p.match(/^\/api\/conversations\/([\w-]+)\/fork$/);
  if (m && req.method === 'POST') {
    const c = store.conversations[m[1]];
    if (!c) return send(res, 404, { error: 'Conversa não encontrada' });
    const b = await readBody(req);
    const upto = b.upto == null ? c.messages.length - 1 : Math.floor(Number(b.upto));
    if (!(upto >= 0 && upto < c.messages.length)) return send(res, 400, { error: 'Índice de mensagem inválido' });
    const f = newConv({ cwd: c.cwd, title: ('↳ ' + String(c.title || 'Conversa').replace(/^↳ /, '')).slice(0, 100), source: c.source, engine: c.engine });
    f.messages = JSON.parse(JSON.stringify(c.messages.slice(0, upto + 1)));
    f.forkedFrom = { id: c.id, index: upto, at: Date.now() };
    persist();
    return send(res, 200, { id: f.id });
  }
  // "Voltar no tempo" sem destruir nada: mostra o diff desde o checkpoint e o comando para restaurar
  m = p.match(/^\/api\/conversations\/([\w-]+)\/rewind$/);
  if (m && req.method === 'POST') {
    const c = store.conversations[m[1]];
    if (!c) return send(res, 404, { error: 'Conversa não encontrada' });
    const b = await readBody(req);
    const msg = c.messages[Math.floor(Number(b.index))];
    if (!msg || !msg.checkpoint) return send(res, 404, { error: 'Esta mensagem não tem checkpoint (a pasta não era git?)' });
    const hash = String(msg.checkpoint);
    if (!/^[0-9a-f]{7,64}$/.test(hash)) return send(res, 400, { error: 'Checkpoint inválido' });
    const root = msg.checkpointRoot || gitRoot(c.cwd);
    if (!root || !fs.existsSync(root)) return send(res, 400, { error: 'Repositório não encontrado: ' + (root || c.cwd) });
    const opt = { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16e6 };
    try { execFileSync('git', ['-C', gp(root), 'cat-file', '-e', hash + '^{commit}'], { ...opt, stdio: 'ignore' }); }
    catch { return send(res, 410, { error: 'O checkpoint não existe mais no repositório (o git pode ter limpado objetos antigos).' }); }
    let stat = '', diff = '';
    try { stat = execFileSync('git', ['-C', gp(root), 'diff', '--stat', hash], opt); } catch (e) { stat = 'Erro: ' + e.message; }
    try { diff = execFileSync('git', ['-C', gp(root), 'diff', hash], opt); } catch (e) { diff = 'Erro: ' + e.message; }
    return send(res, 200, { hash, kind: msg.checkpointKind || 'stash', root, at: msg.ts, stat: stat.slice(0, 20e3), diff: diff.slice(0, 400e3), truncated: diff.length > 400e3,
      command: `git -C "${root}" checkout ${hash} -- .` });
  }
  m = p.match(/^\/api\/runs\/(\w+)\/stream$/);
  if (m) {
    const run = runs.get(m[1]);
    if (!run) return send(res, 404, { error: 'Execução não encontrada' });
    const from = Number(url.searchParams.get('from') || 0);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    for (const ev of run.events.slice(from)) res.write(JSON.stringify(ev) + '\n');
    if (run.done) return res.end();
    run.listeners.add(res);
    const ka = setInterval(() => res.write(JSON.stringify({ event: 'ping' }) + '\n'), 15000);
    req.on('close', () => { clearInterval(ka); run.listeners.delete(res); });
    return;
  }
  m = p.match(/^\/api\/runs\/(\w+)\/cancel$/);
  if (m && req.method === 'POST') {
    const run = runs.get(m[1]);
    if (!run || run.done) return send(res, 404, { error: 'Nada rodando' });
    run.cancelled = true;
    try { execFileSync('taskkill', ['/pid', String(run.proc.pid), '/T', '/F']); } catch { run.proc.kill(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/memory' && req.method === 'GET') {
    const { full, block } = readMemory();
    return send(res, 200, { block, full, file: GEMINI_MD });
  }
  if (p === '/api/memory' && req.method === 'PUT') {
    const body = await readBody(req);
    writeMemory(String(body.block || ''));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/memory/add' && req.method === 'POST') {
    const body = await readBody(req);
    const t = String(body.text || '').trim().replace(/\s+/g, ' ');
    if (!t) return send(res, 400, { error: 'Vazio' });
    const { block } = readMemory();
    writeMemory((block ? block + '\n' : '') + '- ' + t);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/workspaces' && req.method === 'POST') {
    const body = await readBody(req);
    const dir = String(body.path || '').trim();
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'Pasta não encontrada no PC' });
    if (!config.workspaces.includes(dir)) config.workspaces.push(dir);
    saveJson(CONFIG_FILE, config);
    return send(res, 200, { workspaces: config.workspaces });
  }
  if (p === '/api/workspaces' && req.method === 'DELETE') {
    const body = await readBody(req);
    config.workspaces = config.workspaces.filter((w) => w !== body.path);
    if (!config.workspaces.length) config.workspaces = [HOME];
    saveJson(CONFIG_FILE, config);
    return send(res, 200, { workspaces: config.workspaces });
  }
  // Abre a conversa num terminal do PC (para continuar no computador)
  m = p.match(/^\/api\/conversations\/([\w-]+)\/open-on-pc$/);
  if (m && req.method === 'POST') {
    const c = store.conversations[m[1]];
    if (!c) return send(res, 404, { error: 'Conversa não encontrada' });
    if (activeRunFor(c.id)) return send(res, 409, { error: 'Espere a resposta terminar.' });
    const eng = c.engine || 'agy', sid = (c.sessions || {})[eng];
    const CMD = { agy: ['agy', '--conversation'], claude: ['claude', '--resume'], codex: ['codex', 'resume'], opencode: ['opencode', '-s'] }[eng];
    const cmdArgs = sid ? [...CMD, sid] : [CMD[0]];
    spawn('cmd.exe', ['/c', 'start', '"Agy Remote"', '/D', c.cwd, 'cmd', '/k', ...cmdArgs],
      { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Rota desconhecida' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/AgyRemote.apk') {
      const apk = process.env.AGY_REMOTE_APK || path.join(ROOT, '..', 'AgyRemote.apk');
      if (!fs.existsSync(apk)) return send(res, 404, { error: 'APK não encontrado' });
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="AgyRemote.apk"' });
      return fs.createReadStream(apk).pipe(res);
    }
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.end();
  }
});

function activeRuns() { let n = 0; for (const r of runs.values()) if (!r.done) n++; return n; }
module.exports = {
  events,
  info: () => ({ port: config.port, pairCode, token: config.token, addresses: lanAddresses(), agy: AGY, host: os.hostname(), dataDir: DATA, activeRuns: activeRuns() }),
  usage: usageReport,
  missions: () => agentOS.list(),
  close: () => new Promise((r) => server.close(() => r())),
};

server.on('error', (err) => {
  events.emit('error', err);
  if (require.main === module) { console.error('Erro no servidor:', err.message); process.exit(1); }
});

server.listen(config.port, '0.0.0.0', () => {
  events.emit('ready');
  console.log('\n  Agy Remote rodando');
  console.log('  ------------------');
  console.log(`  No PC:       http://localhost:${config.port}`);
  for (const a of lanAddresses()) console.log(`  No celular:  http://${a.ip}:${config.port}   (${a.tailscale ? 'Tailscale' : a.name})`);
  console.log(`\n  Código de pareamento: ${pairCode}`);
  console.log(`  agy: ${AGY}\n`);
});
