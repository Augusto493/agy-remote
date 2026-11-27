// Motores de IA do Agy Remote: cada um sabe montar o comando da CLI e traduzir
// a saída JSON dela para eventos padronizados.
//
// Eventos padronizados (onEvent):
//   { kind: 'session', id }                     id da sessão da CLI (para continuar depois)
//   { kind: 'text', index, delta }              texto da resposta (pedaço)
//   { kind: 'tool', index, name, params, state, duration }   ação (ler/editar arquivo, comando…)
//   { kind: 'usage', usage }                    tokens desta etapa
//   { kind: 'quota', data }                     informação de cota vinda da própria CLI
//   { kind: 'error', message }                  erro reportado pela CLI
//   { kind: 'result', status, text, usage, denied, cost }  fim do turno
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function where(name) {
  try {
    return execFileSync('where', [name], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
// Prefere .exe; se só houver o atalho .cmd do npm, lê o atalho e acha o programa real
// (o .cmd quebraria textos com espaço/aspas vindos do app).
let NODE = null;
function nodeExe() { if (!NODE) NODE = where('node.exe')[0] || where('node')[0] || 'node'; return NODE; }
function fromShim(cmdPath) {
  try {
    const src = fs.readFileSync(cmdPath, 'utf8');
    // o atalho cita vários caminhos (ex.: "%dp0%\node.exe" opcional e o script .js real)
    for (const m of src.matchAll(/"%dp0%\\([^"]+\.(exe|js))"/gi)) {
      const target = path.join(path.dirname(cmdPath), m[1]);
      if (!fs.existsSync(target) || /\\node\.exe$/i.test(target)) continue;
      return m[2].toLowerCase() === 'exe' ? { path: target, prefix: [] } : { path: nodeExe(), prefix: [target] };
    }
    return null;
  } catch { return null; }
}
function resolveExe(names) {
  for (const n of names) {
    const hits = where(n);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return { path: exe, prefix: [] };
    const cmd = hits.find((h) => /\.cmd$/i.test(h));
    if (cmd) { const r = fromShim(cmd); if (r) return r; }
  }
  return null;
}

const MAP_PARAMS = (input) => {
  input = input || {};
  return {
    Path: input.file_path || input.path || input.filePath || input.notebook_path,
    CommandLine: input.command || input.cmd,
    Url: input.url,
    Query: input.pattern || input.query,
    DirectoryPath: input.directory,
  };
};

// Instruções quando o navegador está ligado: usar o Google Chrome de verdade, com os logins do usuário.
const BROWSER_HINT = {
  claude: 'Para qualquer tarefa no navegador (abrir sites, pesquisar no Google, clicar, preencher, tirar print), use as ferramentas mcp__claude-in-chrome: elas controlam o Google Chrome real do usuário pela extensão Claude in Chrome. Comece com tabs_context_mcp e abra uma aba nova com tabs_create_mcp. NÃO use Chrome headless, Puppeteer, Playwright nem scripts para isso. Quando pedirem print, use computer com action screenshot; o print aparece para o usuário no chat.',
  codex: '[Navegador] Para tarefas no navegador, use a ferramenta computer-use para controlar o Google Chrome real do usuário (abra o Chrome visível, navegue e tire prints da tela). Não use Chrome headless nem scripts de automação. Se precisar salvar um print, salve como PNG na pasta de trabalho e diga o caminho.',
  agy: '[Navegador] Para tarefas no navegador use suas ferramentas de navegador (browser_*) e tire prints quando pedirem; salve os prints como PNG na pasta de trabalho e diga o caminho.',
};

// ---------------------------------------------------------------- Antigravity (agy)
const agy = {
  id: 'agy', name: 'Antigravity', vendor: 'Google', images: 'yes', browser: 'yes',
  note: 'Gemini 4, Claude e GPT-OSS pelo plano do Antigravity',
  exe: () => resolveExe(['agy']),
  models: [], // preenchido por `agy models`
  args({ prompt, session, model, mode, skip, browser }) {
    if (browser) prompt = BROWSER_HINT.agy + '\n\n' + prompt;
    const a = ['-p', prompt, '--output-format', 'stream-json'];
    if (session) a.push('--conversation', session);
    if (skip) a.push('--dangerously-skip-permissions');
    else if (mode) a.push('--mode', mode === 'auto' ? 'auto' : mode);
    if (model) a.push('--model', model);
    return a;
  },
  parse(ev, emit) {
    if (ev.event === 'init' && ev.conversation_id) return emit({ kind: 'session', id: ev.conversation_id });
    if (ev.event === 'step_update') {
      const s = ev.step_update || {};
      if (s.step_type === 'agent_response' && s.text_delta) emit({ kind: 'text', index: s.step_index, delta: s.text_delta });
      if (s.step_type === 'tool') emit({ kind: 'tool', index: s.step_index, name: s.tool_name, params: (s.tool_info && s.tool_info.parameters) || {}, state: s.state === 'DONE' ? 'done' : 'live', duration: s.duration_seconds });
      if (s.usage) emit({ kind: 'usage', usage: s.usage });
      return;
    }
    if (ev.event === 'result') {
      const r = ev.result || {};
      emit({ kind: 'result', status: r.status === 'SUCCESS' ? 'ok' : 'error', text: r.response || '', usage: r.usage,
        denied: (r.denied_actions || []).map((d) => d.display_name || d.action) });
    }
  },
};

// ---------------------------------------------------------------- Claude Code
const claude = {
  id: 'claude', name: 'Claude Code', vendor: 'Anthropic', images: 'yes', browser: 'chrome',
  note: 'Usa o Chrome com a extensão Claude in Chrome (opção --chrome)',
  exe: () => resolveExe(['claude']),
  models: [
    { id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet' }, { id: 'haiku', name: 'Claude Haiku' },
  ],
  args({ prompt, session, model, mode, skip, browser }) {
    const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (session) a.push('--resume', session);
    if (model) a.push('--model', model);
    if (skip) a.push('--dangerously-skip-permissions');
    else a.push('--permission-mode', mode === 'plan' ? 'plan' : 'acceptEdits');
    if (browser) {
      // Chrome real do usuário pela extensão Claude in Chrome. Sem tela para aprovar,
      // as ferramentas da extensão precisam ser liberadas aqui.
      a.push('--chrome', '--allowedTools', 'mcp__claude-in-chrome', '--append-system-prompt', BROWSER_HINT.claude);
    }
    return a;
  },
  // variáveis que fariam o Claude Code usar a API paga em vez da conta claude.ai logada
  stripEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  parse(ev, emit, st) {
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      if (ev.apiKeySource) emit({ kind: 'auth', source: ev.apiKeySource });
      return emit({ kind: 'session', id: ev.session_id });
    }
    if (ev.type === 'assistant' && ev.message) {
      for (const c of ev.message.content || []) {
        if (c.type === 'text' && c.text) emit({ kind: 'text', index: st.i++, delta: c.text });
        if (c.type === 'tool_use') { st.tools[c.id] = st.i; emit({ kind: 'tool', index: st.i++, name: c.name, params: MAP_PARAMS(c.input), state: 'live' }); }
      }
      return;
    }
    if (ev.type === 'user' && ev.message) {
      for (const c of ev.message.content || []) if (c.type === 'tool_result' && st.tools[c.tool_use_id] != null) emit({ kind: 'tool', index: st.tools[c.tool_use_id], state: 'done' });
      return;
    }
    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) return emit({ kind: 'quota', data: ev.rate_limit_info });
    if (ev.type === 'result') {
      const u = ev.usage || {};
      const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const usage = { input_tokens: inp, output_tokens: u.output_tokens || 0, cache_read_tokens: u.cache_read_input_tokens || 0,
        thinking_tokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0 };
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
      emit({ kind: 'result', status: ev.is_error ? 'error' : 'ok', text: ev.result || '', usage, cost: ev.total_cost_usd,
        denied: (ev.permission_denials || []).map((d) => d.tool_name || 'ferramenta'), error: ev.is_error ? String(ev.result || ev.subtype || 'erro') : null });
    }
  },
};

// ---------------------------------------------------------------- Codex
const codex = {
  id: 'codex', name: 'Codex', vendor: 'OpenAI', images: 'yes', browser: 'yes',
  note: 'Tem uso do navegador e do computador nativos (browser_use / computer_use)',
  exe: () => resolveExe(['codex']),
  models: [],
  stripEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  args({ prompt, session, model, mode, skip, images, cwd, browser }) {
    if (browser) prompt = BROWSER_HINT.codex + '\n\n' + prompt;
    const a = ['exec'];
    if (session) a.push('resume', session);
    // sempre a conta do ChatGPT logada, nunca chave de API
    a.push('--json', '--skip-git-repo-check', '-c', 'forced_login_method="chatgpt"');
    if (!session) a.push('-C', cwd);
    if (model) a.push('-m', model);
    // No Windows o sandbox "workspace-write" do Codex travou as ferramentas neste PC
    // (ficou 6 min tentando). Para editar, ele roda sem sandbox; em "Só planejar" fica só leitura.
    if (skip) a.push('--dangerously-bypass-approvals-and-sandbox');
    else a.push('--sandbox', mode === 'plan' ? 'read-only' : (process.platform === 'win32' ? 'danger-full-access' : 'workspace-write'));
    for (const img of images || []) a.push('-i', img);
    a.push(prompt);
    return a;
  },
  parse(ev, emit, st) {
    if (ev.type === 'thread.started' && ev.thread_id) return emit({ kind: 'session', id: ev.thread_id });
    const it = ev.item;
    if ((ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated') && it) {
      const done = ev.type === 'item.completed';
      if (st.items[it.id] == null) st.items[it.id] = st.i++;
      const idx = st.items[it.id];
      if (it.type === 'agent_message' && done && it.text) emit({ kind: 'text', index: idx, delta: it.text });
      else if (it.type === 'command_execution') emit({ kind: 'tool', index: idx, name: 'run_command', params: { CommandLine: it.command }, state: done ? 'done' : 'live' });
      else if (it.type === 'file_change') {
        const p = (it.changes || []).map((c) => c.path).join(', ');
        emit({ kind: 'tool', index: idx, name: 'write_file', params: { Path: (it.changes && it.changes[0] && it.changes[0].path) || p }, state: done ? 'done' : 'live' });
      } else if (it.type === 'mcp_tool_call') emit({ kind: 'tool', index: idx, name: it.tool || 'mcp', params: {}, state: done ? 'done' : 'live' });
      else if (it.type === 'web_search') emit({ kind: 'tool', index: idx, name: 'search_web', params: { Query: it.query }, state: done ? 'done' : 'live' });
      else if (it.type === 'error') emit({ kind: 'error', message: it.message });
      return;
    }
    if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      st.usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_tokens: u.cached_input_tokens || 0,
        thinking_tokens: u.reasoning_output_tokens || 0 };
      st.usage.total_tokens = st.usage.input_tokens + st.usage.output_tokens;
      return emit({ kind: 'result', status: 'ok', usage: st.usage });
    }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = (ev.error && ev.error.message) || ev.message || 'erro do Codex';
      return emit({ kind: 'result', status: 'error', error: msg });
    }
  },
};

// ---------------------------------------------------------------- OpenCode
const opencode = {
  id: 'opencode', name: 'OpenCode', vendor: 'Aberto', images: 'model', browser: 'no',
  note: 'Aceita imagem dependendo do modelo configurado',
  exe: () => resolveExe(['opencode']),
  models: [],
  // O banco padrão do OpenCode neste PC (~/.local/share/opencode) está corrompido e preso por outro
  // programa; o Agy Remote usa uma pasta de dados própria para não mexer nele.
  env: (dataDir) => { const d = path.join(dataDir, '..', 'opencode-data'); fs.mkdirSync(d, { recursive: true }); return { XDG_DATA_HOME: d }; },
  args({ prompt, session, model, skip, images, cwd }) {
    const a = ['run', '--format', 'json', '--dir', cwd];
    if (session) a.push('-s', session);
    if (model) a.push('-m', model);
    if (skip) a.push('--auto');
    for (const img of images || []) a.push('-f', img);
    a.push(prompt);
    return a;
  },
  parse(ev, emit, st) {
    const sid = ev.sessionID || ev.sessionId || (ev.part && ev.part.sessionID);
    if (sid && !st.sid) { st.sid = sid; emit({ kind: 'session', id: sid }); }
    const p = ev.part || ev;
    if ((p.type === 'text' || ev.type === 'text') && p.text) emit({ kind: 'text', index: st.i++, delta: p.text });
    if (p.type === 'tool' || ev.type === 'tool_use') {
      const s = p.state || {};
      emit({ kind: 'tool', index: st.i++, name: p.tool || 'ferramenta', params: MAP_PARAMS(s.input), state: s.status === 'completed' ? 'done' : 'live' });
    }
    if (p.type === 'step-finish' && p.tokens) {
      const t = p.tokens;
      const u = { input_tokens: t.input || 0, output_tokens: t.output || 0, thinking_tokens: t.reasoning || 0,
        cache_read_tokens: (t.cache && t.cache.read) || 0 };
      u.total_tokens = t.total || (u.input_tokens + u.output_tokens);
      st.usage = u; st.cost = (st.cost || 0) + (p.cost || 0);
      if (p.reason === 'stop') emit({ kind: 'result', status: 'ok', usage: u, cost: st.cost || undefined });
      else emit({ kind: 'usage', usage: u });
    }
    if (ev.type === 'error') emit({ kind: 'result', status: 'error', error: (ev.error && (ev.error.message || ev.error.data && ev.error.data.message)) || 'erro do OpenCode' });
  },
};

// Modelos do Codex vêm do cache local da própria CLI (~/.codex/models_cache.json)
function loadCodexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    codex.models = (j.models || []).filter((m) => m.visibility === 'list').map((m) => ({
      id: m.slug, name: m.display_name, images: (m.input_modalities || []).includes('image') ? 'yes' : 'no',
    }));
  } catch {}
}
loadCodexModels();

// Modelo mais barato de cada plataforma (usado nos testes e no "modo econômico")
agy.cheap = 'gemini-3.8-flash-low';
claude.cheap = 'haiku';
codex.cheap = 'gpt-6-luna';
opencode.cheap = 'opencode/deepseek-v4.1-flash-free';
// modelos gratuitos que o OpenCode oferece (lista de `opencode models`)
opencode.models = ['beam-free', 'big-pickle', 'deepseek-v4.1-flash-free', 'flint-40b-free', 'glm-5.3-flash-free', 'iceman-free',
  'inkling-2-small-free', 'longcat-2.5-free', 'mimo-v2.6-flash-free', 'minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free'].map((m) => ({ id: 'opencode/' + m, name: m.replace(/-free$/, ' (grátis)'), images: /vl/.test(m) ? 'yes' : 'model' }));

const ENGINES = { agy, claude, codex, opencode };

// Detecta falhas TÉCNICAS (que justificam tentar outra IA). Recusa NÃO entra aqui.
const TECH_FAIL = /(quota|rate.?limit|429|credit|cr[eé]dito|limite|usage limit|exhausted|overloaded|503|502|500|unauthori[sz]ed|401|403|not logged|log ?in|sign ?in|authentication|api key|ENOENT|not found|não encontrad|timed? ?out|ECONN|network|Database is not empty|Unexpected error|internal error)/i;

// Procura imagens (base64) dentro de qualquer evento JSON: prints do Claude in Chrome
// (tool_result com {type:'image', source:{data}}), resultados de computer-use etc.
function findImages(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return out;
  if (Array.isArray(obj)) { for (const x of obj) findImages(x, out, depth + 1); return out; }
  if (obj.type === 'image' || obj.type === 'input_image' || obj.type === 'output_image') {
    const src = obj.source || obj;
    const data = src.data || src.base64 || (typeof src.image_url === 'string' && src.image_url.startsWith('data:') ? src.image_url.split(',')[1] : null);
    const mime = src.media_type || src.mimeType || src.mime_type || (typeof src.image_url === 'string' ? (src.image_url.match(/^data:([^;]+)/) || [])[1] : null) || 'image/png';
    if (data && data.length > 200) out.push({ data, mime });
    return out;
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') findImages(v, out, depth + 1);
  return out;
}

module.exports = { ENGINES, TECH_FAIL, resolveExe, findImages };
