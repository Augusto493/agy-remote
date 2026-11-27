// Agente OS — coordena várias IAs (Claude Code, Codex, Antigravity, OpenCode) numa "missão".
//
// Fluxo:  comando em linguagem natural
//   → 🧭 Arquiteto (IA líder) analisa a pasta e devolve um plano em tarefas com dependências,
//        IA escolhida por especialidade e critérios de aceite testáveis
//   → (opcional) usuário aprova/edita o plano
//   → ⚙️ Executor roda as tarefas prontas em paralelo (cada tarefa tem sua conversa = contexto próprio)
//   → 🔍 Verificador (uma IA DIFERENTE da que construiu) confere os critérios e roda testes
//   → 🔧 se reprovar, a mesma IA corrige na mesma sessão (até N vezes)
//   → ✅ Integração final: a líder testa o conjunto e escreve o relatório
//
// Contexto sem perda: tudo vai para <pasta>/.agentos/<missão>/ (BOARD.md com objetivo, plano e decisões,
// tasks/<id>.md com o resultado completo de cada tarefa). Cada agente recebe o quadro e as saídas
// completas das tarefas de que depende, e pode reler os arquivos quando quiser.
//
// Isolamento (opção `isolate`, padrão ligado em repositório git com commit): cada tarefa roda num worktree
// próprio (<pasta>/.agentos/wt/<id8>-<tid>, branch agentos/<id8>-<tid>) criado a partir do branch de integração
// agentos/<id8> no momento em que começa. Aprovada, é commitada e juntada (--no-ff) no worktree de integração
// (<pasta>/.agentos/wt/<id8>-main). No fim, "Aplicar no projeto" junta agentos/<id8> no branch do usuário.
// (O branch de tarefa usa "-" e não "/": o git não deixa existir agentos/<id8> e agentos/<id8>/t1 ao mesmo tempo.)
//
// Limite de tokens (opção `maxTokens`, padrão 3 mi): soma o uso de todas as conversas da missão; ao passar,
// a missão fica "pausado_limite" (não começa tarefas novas) até POST /api/missions/:id/limit.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// git com barras normais: o git do MSYS/ucrt64 estraga caminhos com \ e espaço (mesma regra do gitChanges)
const gp = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p));
function git(dir, args, timeout) {
  return new Promise((resolve) => execFile('git', ['-C', gp(dir), ...args], { encoding: 'utf8', windowsHide: true, timeout: timeout || 120000, maxBuffer: 16e6 },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: (String(stderr || '').trim() || (err ? err.message : '')).slice(0, 1500) })));
}
const DEFAULT_MAX_TOKENS = 3e6;
const fmtTok = (n) => { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' mi'; if (n >= 1e3) return Math.round(n / 1e3) + 'k'; return String(n); };

const STRENGTHS = {
  claude: 'arquitetura, código complexo, refatoração, depuração difícil, revisão crítica, navegador Chrome real',
  codex: 'implementação rápida e precisa, testes automatizados, scripts, terminal, correções pontuais',
  agy: 'front-end/UI, pesquisa na web, tarefas multimodais (Gemini), navegador, documentação',
  opencode: 'tarefas simples e baratas: boilerplate, docs, ajustes pequenos',
};

const ACTIVE = new Set(['planejando', 'executando', 'verificando', 'integrando']);

module.exports = function createAgentOS(d) {
  const { store, persist, runAsync, ENGINES, usableEngines, broadcast, newConv, cancelConv, config } = d;
  // JSON robusto: as IAs às vezes põem crases (```) dentro das strings do JSON, o que quebra um regex simples.
  // Procura objetos { ... } com um scanner que respeita strings e escapes e fica com o último que parseia.
  function extractJson(text) {
    const src = String(text || '');
    const starts = [];
    for (const mm of src.matchAll(/```json\s*\{/g)) starts.push(mm.index + mm[0].length - 1);
    for (let i = src.indexOf('{'); i >= 0 && starts.length < 60; i = src.indexOf('{', i + 1)) if (!starts.includes(i)) starts.push(i);
    const found = [];
    for (const st of starts) {
      let depth = 0, inStr = false, esc = false;
      for (let i = st; i < src.length; i++) {
        const ch = src[i];
        if (inStr) { if (esc) esc = false; else if (ch === String.fromCharCode(92)) esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(src.slice(st, i + 1)); if (o && typeof o === 'object') found.push({ st, end: i, o }); } catch {} break; } }
      }
    }
    // fica com o objeto mais externo (não contido em outro) que aparece por último
    const outer = found.filter((a) => !found.some((b) => b !== a && b.st <= a.st && b.end >= a.end && (b.st < a.st || b.end > a.end)));
    outer.sort((a, b) => a.st - b.st);
    return outer.length ? outer[outer.length - 1].o : (d.extractJson ? d.extractJson(src) : null);
  }
  if (!store.missions) store.missions = {};
  const M = store.missions;

  // Missões que estavam rodando quando o servidor caiu ficam "interrompidas" (podem ser retomadas)
  for (const m of Object.values(M)) {
    m._looping = false; m._replying = false; m._finished = false;
    if (ACTIVE.has(m.state)) { m.state = 'interrompido'; for (const t of m.tasks || []) if (['rodando', 'verificando', 'corrigindo', 'mesclando'].includes(t.status)) t.status = 'pendente'; }
    if (m.state === 'pausado_limite') for (const t of m.tasks || []) if (['rodando', 'verificando', 'corrigindo', 'mesclando'].includes(t.status)) t.status = 'pendente';
    if (m.state !== 'cancelado' && m.state !== 'erro' && m.state !== 'interrompido' && m.state !== 'pausado_limite' && m.state !== 'aguardando') m._finished = true;
  }
  const gitLocks = new Map(); // fila de operações git por missão (merges no worktree de integração, um de cada vez)
  function withLock(m, fn) {
    const prev = gitLocks.get(m.id) || Promise.resolve();
    const p = prev.then(fn, fn);
    gitLocks.set(m.id, p.catch(() => {}));
    return p;
  }

  const name = (e) => (ENGINES[e] ? ENGINES[e].name : e);
  // OpenCode usa um banco local que trava ("database is locked") com 2 execuções ao mesmo tempo → fila
  const serial = new Set(['opencode']);
  const queues = {};
  // Missão "Econômica": cada IA usa o modelo mais barato dela (ex.: Claude Haiku, GPT Luna, Gemini Flash Low)
  let curMission = null;
  function run(opts) {
    const m = opts.mission || curMission;
    delete opts.mission;
    if (m && m.options.cheap && opts.engine && ENGINES[opts.engine] && ENGINES[opts.engine].cheap) opts.model = ENGINES[opts.engine].cheap;
    let p;
    if (!serial.has(opts.engine)) p = runAsync(opts);
    else {
      const prev = queues[opts.engine] || Promise.resolve();
      p = prev.catch(() => {}).then(() => runAsync(opts));
      queues[opts.engine] = p.catch(() => {});
    }
    // cada resposta atualiza o uso de tokens da missão e confere o limite
    return m ? p.then((r) => { try { checkLimit(m); } catch {} return r; }) : p;
  }
  const now = () => Date.now();

  // ---------- limite de tokens ----------
  function tokensOf(m) {
    let total = 0;
    for (const c of Object.values(store.conversations || {})) {
      if (c.missionId !== m.id) continue;
      for (const msg of c.messages || []) if (msg.role === 'assistant' && msg.usage) total += msg.usage.total_tokens || 0;
    }
    return total;
  }
  const maxOf = (m) => (m.options.maxTokens == null ? DEFAULT_MAX_TOKENS : Number(m.options.maxTokens) || 0); // 0 = sem limite
  const overLimit = (m) => { const mx = maxOf(m); return mx > 0 && (m.tokensUsed || 0) >= mx; };
  function pauseLimit(m) {
    if (m.state === 'pausado_limite') return;
    m.state = 'pausado_limite'; m.pausedAt = now(); persist();
    const txt = `🎯 Limite de tokens atingido: ${fmtTok(m.tokensUsed)} de ${fmtTok(maxOf(m))}. Nenhuma tarefa nova vai começar (as que estão rodando terminam). Aumente o limite para continuar.`;
    say(m, 'system', 'sys', txt, { kind: 'limit' });
    log(m, '🎯 Pausada: limite de tokens atingido');
    broadcast({ type: 'blocked', convId: m.planConvId, missionId: m.id, title: '🧠 ' + m.title, status: 'pausado_limite', text: txt, denied: [] });
  }
  function checkLimit(m) {
    m.tokensUsed = tokensOf(m);
    if (overLimit(m) && ['executando', 'planejando'].includes(m.state)) pauseLimit(m);
  }
  for (const m of Object.values(M)) { try { m.tokensUsed = tokensOf(m); } catch {} }

  function dirOf(m) { return path.join(m.cwd, '.agentos', m.id.slice(0, 8)); }
  function boardPath(m) { return path.join(dirOf(m), 'BOARD.md'); }
  function taskPath(m, t) { return path.join(dirOf(m), 'tasks', t.id + '.md'); }
  // BOM UTF-8: o PowerShell 5 do Windows lê .md sem BOM como Latin-1 e os agentes viam "MissÃ£o"
  function write(file, text) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, String.fromCharCode(0xfeff) + text, 'utf8'); } catch {} }

  function log(m, text, extra) {
    m.log.push({ ts: now(), text, ...(extra || {}) });
    if (m.log.length > 400) m.log.splice(0, m.log.length - 400);
    m.updatedAt = now(); persist();
    broadcast({ type: 'mission', id: m.id, state: m.state, text });
  }

  // ---------- chat da missão (estilo WhatsApp): agentes e usuário conversam ----------
  const ROLE = { arq: 'Arquiteto', exe: 'Executor', ver: 'Verificador', sys: 'Sistema', user: 'Você' };
  function say(m, from, role, text, extra) {
    if (!m.chat) m.chat = [];
    const msg = { id: crypto.randomBytes(5).toString('hex'), ts: now(), from, role: ROLE[role] || role, text: String(text || '').slice(0, 4000), ...(extra || {}) };
    m.chat.push(msg);
    if (m.chat.length > 600) m.chat.splice(0, m.chat.length - 600);
    m.updatedAt = now(); persist();
    broadcast({ type: 'mission-chat', id: m.id, msg });
    return msg;
  }
  function instructionsBlock(m) {
    const ins = (m.instructions || []).slice(-10);
    return ins.length ? `\n## ⚠️ Instruções do usuário enviadas DURANTE a execução (têm prioridade)\n${ins.map((i) => '- ' + i.text).join('\n')}\n` : '';
  }
  function typing(m) {
    const out = [];
    for (const t of m.tasks) {
      if (t.status === 'rodando' || t.status === 'corrigindo') out.push({ engine: t.engineUsed || t.engine, role: 'Executor', taskId: t.id, title: t.title });
      if (t.status === 'verificando') out.push({ engine: t.verifyEngine, role: 'Verificador', taskId: t.id, title: t.title });
    }
    if (m.state === 'planejando' || m.state === 'integrando' || m._replying) out.push({ engine: m.options.lead, role: 'Arquiteto', taskId: null });
    return out;
  }

  function writeBoard(m) {
    const lines = [
      `# Missão: ${m.title}`, '',
      `> Quadro compartilhado do Agente OS. Todos os agentes leem este arquivo. Não apague.`, '',
      '## Objetivo do usuário', m.goal, '',
      ...(m.followUps.length ? ['## Pedidos adicionais', ...m.followUps.map((f) => `- ${f.text}`), ''] : []),
      ...((m.instructions || []).length ? ['## ⚠️ Instruções do usuário pelo chat (prioridade)', ...m.instructions.map((i) => `- ${i.text}`), ''] : []),
      '## Plano', m.plan.summary || '(sem resumo)', '',
      ...(m.plan.architecture ? ['## Arquitetura / decisões', m.plan.architecture, ''] : []),
      ...(m.plan.testCommand ? ['## Como testar', '`' + m.plan.testCommand + '`', ''] : []),
      '## Tarefas',
      ...m.tasks.map((t) => `- [${t.status === 'ok' ? 'x' : ' '}] **${t.id}** ${t.title} — ${name(t.engine)} — ${t.status}` +
        (t.deps.length ? ` (depende de ${t.deps.join(', ')})` : '') + (t.summary ? `\n  - Resultado: ${t.summary.replace(/\s+/g, ' ').slice(0, 400)}` : '')),
      '',
      ...(m.notes.length ? ['## Notas dos agentes', ...m.notes.map((n) => `- ${n}`), ''] : []),
    ];
    write(boardPath(m), lines.join('\n'));
  }

  function summarize(m) {
    const done = m.tasks.filter((t) => t.status === 'ok').length;
    return { id: m.id, title: m.title, goal: m.goal, cwd: m.cwd, state: m.state, createdAt: m.createdAt, updatedAt: m.updatedAt,
      finishedAt: m.finishedAt || null, total: m.tasks.length, done, failed: m.tasks.filter((t) => t.status === 'falhou').length,
      running: m.tasks.filter((t) => ['rodando', 'verificando', 'corrigindo'].includes(t.status)).length,
      engines: m.tasks.length ? [...new Set(m.tasks.map((t) => t.engine))] : (m.options.engines || []), verdict: m.report ? m.report.pass : null,
      tokensUsed: m.tokensUsed || 0, maxTokens: maxOf(m), isolate: !!m.options.isolate, gitStatus: m.git ? m.git.status : null, automationId: m.automationId || null };
  }

  // ---------------------------------------------------------------- isolamento por worktree (git)
  const iso = (m) => !!(m.options.isolate && m.git && m.git.status !== 'descartada' && m.git.status !== 'aplicada');
  const id8 = (m) => m.id.slice(0, 8);
  const wtBase = (m) => path.join(m.cwd, '.agentos', 'wt');
  const taskBranch = (m, t) => `${m.git.branch}-${t.id}`;
  const taskWt = (m, t) => path.join(wtBase(m), `${id8(m)}-${t.id}`);
  const inWt = (m, wt) => (m.git && m.git.rel ? path.join(wt, m.git.rel) : wt); // pasta equivalente à do usuário dentro do worktree
  const workDir = (m, t) => (iso(m) && t && t.worktree ? inWt(m, t.worktree) : m.cwd);
  const intDir = (m) => (iso(m) ? inWt(m, m.git.mainWt) : m.cwd);
  let identCache = {};
  async function ident(dir) {
    // sem user.name/email configurado o commit falha; usa uma identidade local só para os commits do Agente OS
    if (identCache[dir] == null) { const r = await git(dir, ['config', 'user.email']); identCache[dir] = r.ok && r.out ? [] : ['-c', 'user.name=Agente OS', '-c', 'user.email=agente-os@localhost']; }
    return identCache[dir];
  }
  // git add -A sem lixo de build (cache do Python, node_modules…) que as IAs geram ao testar
  const JUNK = ['__pycache__/**', '**/__pycache__/**', '**/*.pyc', 'node_modules/**', '**/node_modules/**', '.pytest_cache/**', '**/.pytest_cache/**', '**/.DS_Store'];
  function addAll(dir) { return git(dir, ['add', '-A', '--', '.', ...JUNK.map((g) => ':(exclude,glob)' + g)]); }
  async function unmerged(dir) { const r = await git(dir, ['diff', '--name-only', '--diff-filter=U']); return r.out ? r.out.split(/\r?\n/).filter(Boolean) : []; }
  async function merging(dir) { return (await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok; }

  async function setupIsolation(m) {
    const top = await git(m.cwd, ['rev-parse', '--show-toplevel']);
    const head = top.ok ? await git(m.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) : null;
    if (!top.ok || !head.ok) {
      m.options.isolate = false; persist();
      say(m, 'system', 'sys', top.ok ? '🌿 Repositório sem nenhum commit: as tarefas rodam na mesma pasta.' : '🌿 Pasta sem git: as tarefas rodam na mesma pasta.', { kind: 'info' });
      return;
    }
    const root = path.resolve(top.out);
    const rel = path.relative(root, path.resolve(m.cwd));
    // .agentos/ fora do git (vale para todos os worktrees: o exclude fica no diretório comum)
    const cd = await git(root, ['rev-parse', '--git-common-dir']);
    try {
      const ex = path.join(path.resolve(root, cd.out || '.git'), 'info', 'exclude');
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!/^\/?\.agentos\/?\s*$/m.test(cur)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + '.agentos/\n'); }
    } catch {}
    const id = await ident(root);
    const startBranch = (await git(root, ['branch', '--show-current'])).out;
    // mudanças não commitadas: viram um commit-base solto (stash create não mexe em nada na pasta do usuário)
    let base = head.out, baseKind = 'head';
    const st = await git(root, ['stash', 'create', 'agentos base']);
    if (st.ok && /^[0-9a-f]{7,64}$/.test(st.out)) {
      const ct = await git(root, [...id, 'commit-tree', st.out + '^{tree}', '-p', head.out, '-m', 'agentos: base com as mudanças não commitadas']);
      if (ct.ok && /^[0-9a-f]{7,64}$/.test(ct.out)) { base = ct.out; baseKind = 'stash'; }
    }
    const branch = 'agentos/' + id8(m);
    const mainWt = path.join(wtBase(m), id8(m) + '-main');
    await git(root, ['worktree', 'prune']);
    let r = await git(root, ['branch', '-f', branch, base]);
    if (r.ok) r = await git(root, ['worktree', 'add', gp(mainWt), branch]);
    if (!r.ok) {
      m.options.isolate = false; persist();
      say(m, 'system', 'sys', '🌿 Não consegui criar os worktrees (' + r.err.slice(0, 200) + '). As tarefas rodam na mesma pasta.', { kind: 'error' });
      return;
    }
    m.git = { root, rel, branch, base, baseKind, startBranch, mainWt, worktrees: { main: mainWt }, status: 'ativo', createdAt: now() };
    persist();
    say(m, 'system', 'sys', `🌿 Tarefas isoladas: cada IA trabalha num worktree próprio. Tudo é juntado no branch \`${branch}\`` +
      (baseKind === 'stash' ? ' (que já inclui as suas mudanças não commitadas).' : '.') + ' Sua pasta só muda quando você clicar em “Aplicar no projeto”.', { kind: 'info' });
    log(m, `🌿 Branch de integração ${branch} criado (${baseKind === 'stash' ? 'com mudanças não commitadas' : 'a partir do HEAD'})`);
  }

  // garante o worktree de integração antes de executar (missão retomada, refeita ou depois de aplicar/descartar)
  async function ensureIsolation(m) {
    if (!m.options.isolate) return;
    if (!m.git || m.git.status === 'aplicada' || m.git.status === 'descartada') {
      if (m.git) { for (const t of m.tasks) t.worktree = null; m.git = null; }
      return setupIsolation(m);
    }
    if (!fs.existsSync(m.git.mainWt)) {
      await git(m.git.root, ['worktree', 'prune']);
      const r = await git(m.git.root, ['worktree', 'add', gp(m.git.mainWt), m.git.branch]);
      if (!r.ok) { m.git.status = 'descartada'; m.git = null; return setupIsolation(m); }
    }
    m.git.status = 'ativo'; persist();
  }

  // worktree da tarefa: criado do branch de integração NO MOMENTO em que a tarefa começa (já com as dependências juntadas)
  async function prepareTask(m, t) {
    return withLock(m, async () => {
      const wt = taskWt(m, t), br = taskBranch(m, t), root = m.git.root;
      if (fs.existsSync(wt)) {
        // refazer: atualiza com o que foi juntado desde então
        if (await merging(wt)) await git(wt, ['merge', '--abort']);
        const r = await git(wt, [...await ident(root), 'merge', '--no-edit', m.git.branch]);
        if (!r.ok) await git(wt, ['merge', '--abort']);
      } else {
        await git(root, ['worktree', 'prune']);
        const exists = (await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + br])).ok;
        let r = exists ? await git(root, ['worktree', 'add', gp(wt), br]) : await git(root, ['worktree', 'add', '-b', br, gp(wt), m.git.branch]);
        if (!r.ok) throw new Error('Não consegui criar o worktree da ' + t.id + ': ' + r.err.slice(0, 200));
        if (exists) { const mr = await git(wt, [...await ident(root), 'merge', '--no-edit', m.git.branch]); if (!mr.ok) await git(wt, ['merge', '--abort']); }
      }
      t.worktree = wt; t.branch = br; m.git.worktrees[t.id] = wt; persist();
      return inWt(m, wt);
    });
  }

  async function commitTask(m, t) {
    const wt = t.worktree; if (!wt) return;
    await addAll(wt);
    const diff = await git(wt, ['diff', '--cached', '--quiet']);
    if (!diff.ok) await git(wt, [...await ident(m.git.root), 'commit', '-q', '--no-verify', '-m', `agentos ${t.id}: ${t.title}`]);
  }

  // junta o branch da tarefa no worktree de integração; em conflito aborta lá (não trava as outras tarefas)
  async function mergeTask(m, t) {
    return withLock(m, async () => {
      const mw = m.git.mainWt;
      if (await merging(mw)) await git(mw, ['merge', '--abort']);
      const r = await git(mw, [...await ident(m.git.root), 'merge', '--no-ff', '--no-verify', '-m', `agentos: junta ${t.id} — ${t.title}`, taskBranch(m, t)]);
      if (r.ok) return { ok: true };
      const files = await unmerged(mw);
      await git(mw, ['merge', '--abort']);
      return files.length ? { ok: false, conflict: true, files } : { ok: false, error: r.err };
    });
  }

  // conflito: o branch de integração é juntado no worktree DA TAREFA e a mesma IA (mesma conversa, mesma pasta) resolve e commita.
  // Resolver lá e não no worktree de integração deixa as outras tarefas continuarem juntando em paralelo.
  async function resolveConflict(m, t, files, attempt) {
    const wt = t.worktree;
    if (await merging(wt)) await git(wt, ['merge', '--abort']);
    const mr = await git(wt, [...await ident(m.git.root), 'merge', '--no-ff', '--no-edit', m.git.branch]);
    if (mr.ok) return true; // juntou sozinho (o conflito era com algo que mudou de novo)
    const conflicted = await unmerged(wt);
    say(m, t.engineUsed || t.engine, 'exe', `⚔️ Deu conflito ao juntar a ${t.id} com o trabalho das outras tarefas (${(conflicted.length ? conflicted : files).slice(0, 6).join(', ')}). Resolvendo agora (tentativa ${attempt}/2).`, { taskId: t.id, kind: 'fix' });
    log(m, `⚔️ ${t.id} conflito de merge (${attempt}/2): ${(conflicted.length ? conflicted : files).join(', ').slice(0, 200)}`, { taskId: t.id });
    const r = await run({ mission: m, convId: t.convId, engine: t.engineUsed || t.engine, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
      label: `⚔️ ${t.id} resolver conflito`, browser: m.options.browser,
      prompt: `Sua tarefa ${t.id} foi aprovada, mas ao juntá-la no branch de integração (${m.git.branch}) deu CONFLITO de merge com o trabalho de outras tarefas.\n` +
        `Eu já comecei, no SEU worktree (${inWt(m, wt)}), o merge do branch de integração. Arquivos em conflito:\n${(conflicted.length ? conflicted : files).map((f) => '- ' + f).join('\n')}\n\n` +
        `Resolva TODOS os conflitos mantendo o trabalho das duas partes (o seu e o das outras tarefas), apague os marcadores <<<<<<< ======= >>>>>>>, ` +
        `rode/teste de novo e finalize o merge com: git add -A && git commit --no-edit (se o commit falhar por falta de identidade do git, deixe tudo com git add -A que eu commito)\n` +
        `Quadro da missão: ${boardPath(m)}\n${instructionsBlock(m)}Responda com o resumo e o mesmo bloco JSON de antes.` });
    if (m.state === 'cancelado' || r.status === 'CANCELLED') return false;
    // a IA pode ter resolvido sem commitar: se não há mais conflito nem marcadores, commita por ela
    const left = await unmerged(wt);
    const marks = await git(wt, ['grep', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>) ', '--', '.']);
    if (left.length || (marks.ok && marks.out)) { if (await merging(wt)) await git(wt, ['merge', '--abort']); return false; }
    await addAll(wt);
    if (await merging(wt)) {
      const c = await git(wt, [...await ident(m.git.root), 'commit', '-q', '--no-verify', '--no-edit']);
      if (!c.ok) { await git(wt, ['merge', '--abort']); return false; }
    } else await commitTask(m, t);
    t.output = String(r.text || t.output || '');
    return true;
  }

  // tarefa aprovada → commit no worktree dela → merge no de integração (com até 2 tentativas de resolver conflito)
  async function acceptTask(m, t) {
    if (!iso(m) || !t.worktree) { t.status = 'ok'; return; }
    t.status = 'mesclando'; persist();
    await commitTask(m, t);
    for (let attempt = 0; ;) {
      if (m.state === 'cancelado') { t.status = 'cancelada'; return; }
      const r = await mergeTask(m, t);
      if (r.ok) {
        t.status = 'ok'; t.mergedAt = now(); persist();
        log(m, `🌿 ${t.id} juntada em ${m.git.branch}`, { taskId: t.id });
        say(m, 'system', 'sys', `🌿 ${t.id} juntada no branch de integração.`, { taskId: t.id, kind: 'merge' });
        return;
      }
      if (!r.conflict) {
        t.status = 'falhou'; t.error = 'Não consegui juntar no branch de integração: ' + String(r.error || '').slice(0, 200);
        say(m, 'system', 'sys', `⚠️ ${t.id}: ${t.error}`, { taskId: t.id, kind: 'error' }); log(m, `⚠️ ${t.id} ${t.error}`, { taskId: t.id });
        return;
      }
      if (attempt >= 2) {
        if (await merging(t.worktree)) await git(t.worktree, ['merge', '--abort']);
        t.status = 'falhou'; t.error = 'Conflito de merge não resolvido em 2 tentativas: ' + r.files.join(', ').slice(0, 200);
        say(m, 'system', 'sys', `⛔ ${t.id} falhou: conflito de merge não resolvido em 2 tentativas (${r.files.slice(0, 6).join(', ')}). Rodei git merge --abort; o trabalho dela continua no branch ${taskBranch(m, t)}.`, { taskId: t.id, kind: 'error' });
        log(m, `⛔ ${t.id} conflito não resolvido — merge abortado`, { taskId: t.id });
        return;
      }
      attempt++;
      t.status = 'corrigindo'; persist();
      const ok = await resolveConflict(m, t, r.files, attempt);
      if (m.state === 'cancelado') { t.status = 'cancelada'; return; }
      if (!ok) { t.status = 'mesclando'; continue; }
      t.conflictResolved = true;
      // depois de resolver, outra IA verifica de novo
      if (m.options.verify) {
        let pass = await verify(m, t);
        for (let k = 0; !pass && k < 1 && m.state !== 'cancelado'; k++) {
          t.status = 'corrigindo'; persist();
          const fx = await run({ mission: m, convId: t.convId, engine: t.engineUsed || t.engine, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
            label: `🔧 ${t.id} correção pós-merge`, browser: m.options.browser,
            prompt: `Depois de resolver o conflito, o verificador (${name(t.verdict.engine)}) REPROVOU a ${t.id}:\n${t.verdict.issues.map((i) => '- ' + i).join('\n')}\nCorrija, teste, faça git add -A && git commit e responda com o resumo e o JSON.` });
          if (fx.status !== 'SUCCESS') break;
          await commitTask(m, t);
          pass = await verify(m, t);
        }
        if (m.state === 'cancelado') { t.status = 'cancelada'; return; }
        if (!pass) { t.status = 'falhou'; t.error = 'Reprovada na verificação depois de resolver o conflito de merge'; say(m, 'system', 'sys', `⛔ ${t.id}: ${t.error}.`, { taskId: t.id, kind: 'error' }); return; }
      }
      t.status = 'mesclando'; persist();
    }
  }

  async function removeWorktrees(m) {
    const g = m.git; if (!g) return [];
    const failed = [];
    for (const [k, wt] of Object.entries(g.worktrees || {})) {
      if (!fs.existsSync(wt)) { delete g.worktrees[k]; continue; }
      let r;
      for (let i = 0; i < 3; i++) { r = await git(g.root, ['worktree', 'remove', '--force', gp(wt)]); if (r.ok) break; await new Promise((ok) => setTimeout(ok, 1500)); }
      if (r.ok) delete g.worktrees[k]; else failed.push(wt);
    }
    await git(g.root, ['worktree', 'prune']);
    try { const b = wtBase(m); if (fs.existsSync(b) && !fs.readdirSync(b).length) fs.rmdirSync(b); } catch {}
    persist();
    return failed;
  }
  async function deleteBranches(m) {
    const g = m.git; if (!g) return;
    const list = await git(g.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/' + g.branch, 'refs/heads/' + g.branch + '-*']);
    for (const b of (list.out || '').split(/\r?\n/).filter(Boolean)) if (b === g.branch || b.startsWith(g.branch + '-')) await git(g.root, ['branch', '-D', b]);
  }

  async function applyResult(m) {
    const g = m.git;
    if (!g || g.status === 'aplicada' || g.status === 'descartada') throw new Error('Esta missão não tem resultado para aplicar.');
    if (ACTIVE.has(m.state) || m._looping) throw new Error('Espere a missão terminar.');
    const root = g.root;
    const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.out) {
      throw new Error(g.baseKind === 'stash'
        ? 'A pasta tem mudanças não commitadas (a missão partiu delas, então elas já estão no resultado). Guarde-as com "git stash" e aplique de novo.'
        : 'A pasta tem mudanças não commitadas. Faça commit ou "git stash" delas e aplique de novo.');
    }
    const cur = (await git(root, ['branch', '--show-current'])).out;
    if (!cur) throw new Error('A pasta está sem branch (HEAD solto). Faça checkout de um branch antes de aplicar.');
    const id = await ident(root);
    let method = 'fast-forward';
    let r = await git(root, ['merge', '--ff-only', g.branch]);
    if (!r.ok) {
      method = 'merge';
      r = await git(root, [...id, 'merge', '--no-ff', '--no-verify', '-m', `agentos: aplica a missão "${m.title.slice(0, 60)}"`, g.branch]);
      if (!r.ok) {
        const files = await unmerged(root);
        await git(root, ['merge', '--abort']);
        throw new Error(files.length
          ? `Conflito ao aplicar em ${cur} (${files.slice(0, 8).join(', ')}). Nada foi alterado (merge abortado). O resultado continua no branch ${g.branch}: junte manualmente ou peça à equipe para ajustar.`
          : 'O git recusou o merge: ' + r.err.slice(0, 300));
      }
    }
    g.status = 'aplicada'; g.appliedAt = now(); g.appliedTo = cur; g.method = method; persist();
    say(m, 'system', 'sys', `✅ Resultado aplicado em \`${cur}\` (${method === 'fast-forward' ? 'fast-forward' : 'merge'}). Worktrees e branches temporários removidos.`, { kind: 'info' });
    log(m, `✅ Aplicado em ${cur} (${method})`);
    await removeWorktrees(m); await deleteBranches(m);
    return { branch: cur, method };
  }

  async function discardResult(m, branches) {
    const g = m.git; if (!g) throw new Error('Esta missão não usou worktrees.');
    if (ACTIVE.has(m.state) || m._looping) throw new Error('Cancele a missão antes de descartar.');
    const failed = await removeWorktrees(m);
    if (branches !== false) { await deleteBranches(m); g.status = 'descartada'; g.discardedAt = now(); }
    persist();
    say(m, 'system', 'sys', branches !== false ? '🗑 Resultado descartado: worktrees e branches da missão removidos. Sua pasta não foi alterada.' : '🧹 Worktrees removidos (os branches continuam).', { kind: 'info' });
    return { failed };
  }

  // ---------------------------------------------------------------- planejamento
  function engineMenu(engines) {
    return engines.map((e) => `- ${e} (${name(e)}): ${STRENGTHS[e] || 'uso geral'}`).join('\n');
  }

  async function plan(m, instruction, extra) {
    const engines = m.options.engines;
    const existing = m.tasks.length
      ? `\nTarefas que já existem (não repita; novas tarefas podem depender delas pelo id):\n${m.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join('\n')}\n` : '';
    const prompt =
`Você é o ARQUITETO-CHEFE do Agente OS: um tech lead sênior que coordena uma equipe de IAs de programação.
Pasta do projeto: ${m.cwd}
${extra ? 'Contexto da missão (quadro): ' + boardPath(m) + '\n' : ''}
Pedido do usuário (linguagem natural, pode ser vago — interprete como um expert e decida os detalhes):
"""${instruction}"""
${existing}
Equipe disponível e especialidades:
${engineMenu(engines)}

Faça:
1. Analise rapidamente a pasta (estrutura, stack, como roda e como testa). Não altere nada agora.
2. Quebre o trabalho em 2 a 8 tarefas concretas, cada uma executável por UM agente de forma autônoma.
3. Use "deps" para ordem; tarefas sem dependência entre si e que mexem em arquivos DIFERENTES rodam em paralelo.
4. Escolha o engine de cada tarefa pela especialidade. Distribua entre as IAs quando fizer sentido.
5. Dê critérios de aceite VERIFICÁVEIS (arquivo existe, comando X passa, função Y retorna Z, página abre sem erro).
6. Inclua uma tarefa final de testes se o projeto tiver/precisar de testes.

Responda SOMENTE com um bloco JSON assim:
\`\`\`json
{"summary":"o que será entregue, em 2-3 frases",
 "architecture":"decisões técnicas importantes (stack, estrutura de pastas, padrões)",
 "testCommand":"comando para testar o projeto inteiro, ou vazio",
 "tasks":[{"id":"t1","title":"título curto","engine":"${engines.join('|')}","deps":[],
   "files":["arquivos/pastas principais que a tarefa cria ou altera"],
   "prompt":"instrução completa e autossuficiente para o agente",
   "acceptance":["critério verificável 1","critério 2"]}]}
\`\`\``;
    const r = await run({ mission: m, convId: m.planConvId, prompt, engine: m.options.lead, mode: 'plan', device: 'agentos',
      label: extra ? '🧭 Replanejar' : '🧭 Plano do Arquiteto', noFallback: false });
    if (m.state === 'cancelado') return null;
    const j = extractJson(r.text);
    if (!j || !Array.isArray(j.tasks) || !j.tasks.length) throw new Error('O Arquiteto não devolveu um plano válido. ' + String(r.error || r.text || '').slice(0, 200));
    const base = m.tasks.length;
    const idMap = {};
    const tasks = j.tasks.slice(0, 10).map((t, i) => {
      const id = 't' + (base + i + 1);
      idMap[String(t.id || ('t' + (i + 1)))] = id;
      return { raw: t, id };
    }).map(({ raw, id }, i) => ({
      id, title: String(raw.title || 'Tarefa ' + id).slice(0, 90),
      engine: engines.includes(raw.engine) ? raw.engine : engines[(base + i) % engines.length],
      deps: (Array.isArray(raw.deps) ? raw.deps : []).map((x) => idMap[String(x)] || (m.tasks.find((t) => t.id === String(x)) ? String(x) : null)).filter(Boolean),
      files: (Array.isArray(raw.files) ? raw.files : []).map(String).slice(0, 12),
      prompt: String(raw.prompt || raw.title || ''),
      acceptance: (Array.isArray(raw.acceptance) ? raw.acceptance : []).map(String).slice(0, 8),
      status: 'pendente', attempts: 0, fixes: 0, convId: null, summary: '', verdict: null,
    }));
    // dependência para tarefa inexistente ou de si mesma é descartada; ciclos viram sequência simples
    for (const t of tasks) t.deps = t.deps.filter((x) => x !== t.id);
    if (!extra) { m.plan = { summary: String(j.summary || ''), architecture: String(j.architecture || ''), testCommand: String(j.testCommand || '') }; }
    else if (j.testCommand && !m.plan.testCommand) m.plan.testCommand = String(j.testCommand);
    m.tasks.push(...tasks);
    writeBoard(m);
    log(m, `🧭 Plano: ${tasks.length} tarefa(s) — ${tasks.map((t) => `${t.id} ${name(t.engine)}`).join(', ')}`);
    say(m, m.options.lead, 'arq', (extra ? 'Novas tarefas para o pedido:\n' : (m.plan.summary ? m.plan.summary + '\n\n' : '') + 'Dividi assim:\n') +
      tasks.map((t) => `• ${t.id} ${t.title} → @${t.engine}${t.deps.length ? ' (depois de ' + t.deps.join(', ') + ')' : ''}`).join('\n'), { kind: 'plan' });
    return tasks;
  }

  // ---------------------------------------------------------------- execução
  function depOutputs(m, t) {
    return t.deps.map((id) => m.tasks.find((x) => x.id === id)).filter(Boolean).map((x) =>
      `### ${x.id} — ${x.title} (${name(x.engineUsed || x.engine)})\nArquivo com o resultado completo: ${taskPath(m, x)}\n${String(x.output || x.summary || '').slice(0, 5000)}`).join('\n\n');
  }

  function taskPrompt(m, t) {
    const deps = depOutputs(m, t);
    const wd = workDir(m, t);
    return `Você é um agente ESPECIALISTA do Agente OS (missão "${m.title}"). Trabalhe com autonomia e qualidade de sênior.
Pasta do projeto: ${wd}
${wd !== m.cwd ? `(É um worktree git isolado só para esta tarefa, criado a partir de ${m.cwd}. Trabalhe SOMENTE nesta pasta; não mexa na pasta original. Não precisa commitar: o Agente OS commita e junta o seu trabalho.)\n` : ''}Quadro compartilhado da missão (objetivo, plano, decisões, status das outras tarefas): ${boardPath(m)}
Leia o quadro antes de começar.

Objetivo geral: ${m.goal}
${m.plan.architecture ? 'Decisões de arquitetura: ' + m.plan.architecture + '\n' : ''}
${deps ? '## Resultado das tarefas anteriores das quais você depende\n' + deps + '\n' : ''}
## SUA TAREFA ${t.id}: ${t.title}
${t.prompt}
${t.files.length ? 'Arquivos principais: ' + t.files.join(', ') + '\n' : ''}${t.acceptance.length ? '## Critérios de aceite (serão verificados por outra IA)\n' + t.acceptance.map((a) => '- ' + a).join('\n') + '\n' : ''}
${instructionsBlock(m)}Regras: não mexa em arquivos de outras tarefas sem necessidade; rode e teste o que fizer; não pergunte nada, decida.
Ao terminar, responda com um resumo curto e termine com um bloco JSON:
\`\`\`json
{"summary":"o que foi feito","files":["arquivos alterados"],"howToTest":"comando ou passos","notes":"decisões que outros agentes precisam saber"}
\`\`\``;
  }

  function pickVerifier(m, builder) {
    const others = m.options.engines.filter((e) => e !== builder);
    const pref = ['claude', 'codex', 'agy', 'opencode'].filter((e) => others.includes(e));
    return pref[0] || builder;
  }

  async function verify(m, t) {
    const v = pickVerifier(m, t.engineUsed || t.engine);
    t.verifyEngine = v; t.status = 'verificando'; persist();
    log(m, `🔍 ${t.id} verificando com ${name(v)}`, { taskId: t.id, engine: v });
    const wd = workDir(m, t);
    const vc = t.verifyConvId && store.conversations[t.verifyConvId];
    if (!vc || (vc.cwd !== wd)) {
      const c = newConv({ cwd: wd, title: `🔍 ${m.title.slice(0, 30)} · ${t.id}`, engine: v });
      c.missionId = m.id; t.verifyConvId = c.id; persist();
    }
    const r = await run({ mission: m, convId: t.verifyConvId, engine: v, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
      label: `🔍 Verificar ${t.id}`, browser: m.options.browser,
      prompt: `Você é o VERIFICADOR independente do Agente OS. Seja rigoroso, mas justo. Não reescreva o trabalho: só confira.
Pasta: ${wd}${wd !== m.cwd ? ' (worktree git isolado desta tarefa)' : ''}
Quadro da missão: ${boardPath(m)}
Tarefa ${t.id}: ${t.title}
Instrução que o agente recebeu:
${t.prompt}

Relato do agente que executou (${name(t.engineUsed || t.engine)}):
${String(t.output || '').slice(0, 4000)}

Critérios de aceite:
${(t.acceptance.length ? t.acceptance : ['A tarefa foi feita como pedido e funciona']).map((a, i) => `${i + 1}. ${a}`).join('\n')}

${t.conflictResolved ? 'ATENÇÃO: esta verificação é DEPOIS de juntar esta tarefa com o trabalho de outras tarefas (houve conflito de merge e ele foi resolvido). Onde um critério desta tarefa contradiz o que outra tarefa aprovada fez no mesmo trecho, aceite uma combinação razoável que preserve as duas partes; reprove só se o trabalho desta tarefa sumiu, quebrou ou ficou com marcadores de conflito.\n' : ''}${instructionsBlock(m)}Confira cada critério olhando os arquivos e, quando possível, RODANDO comandos/testes. Responda SOMENTE com JSON:
\`\`\`json
{"pass":true,"checks":[{"criterion":"...","ok":true,"evidence":"o que você viu/rodou"}],"issues":["problema concreto e como corrigir"]}
\`\`\`` });
    const j = extractJson(r.text) || {};
    const pass = r.status === 'SUCCESS' && j.pass === true;
    t.verdict = { pass, engine: v, checks: Array.isArray(j.checks) ? j.checks.slice(0, 12) : [], issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 10) : (pass ? [] : [String(r.error || 'O verificador não devolveu um veredito claro.')]), at: now() };
    say(m, v, 'ver', pass ? `👍 Conferi a ${t.id} de @${t.engineUsed || t.engine}: ${t.verdict.checks.filter((c) => c.ok).length}/${t.verdict.checks.length || 1} critérios ok. Aprovada.`
      : `👎 @${t.engineUsed || t.engine}, a ${t.id} ainda não passou:\n${t.verdict.issues.slice(0, 5).map((i) => '• ' + i).join('\n')}`, { taskId: t.id, kind: 'verdict', pass });
    log(m, `${pass ? '✅' : '❌'} ${t.id} ${pass ? 'aprovada' : 'reprovada'} por ${name(v)}${pass ? '' : ': ' + t.verdict.issues.slice(0, 2).join(' | ').slice(0, 220)}`, { taskId: t.id, engine: v });
    return pass;
  }

  async function runTask(m, t) {
    t.status = 'rodando'; t.startedAt = t.startedAt || now(); t.attempts++;
    if (iso(m)) await prepareTask(m, t); else t.worktree = null;
    const wd = workDir(m, t);
    const oc = t.convId && store.conversations[t.convId];
    if (!oc || oc.cwd !== wd) { // conversa nova se a pasta mudou (a sessão das CLIs fica presa à pasta)
      const c = newConv({ cwd: wd, title: `🤖 ${m.title.slice(0, 30)} · ${t.id} ${t.title.slice(0, 24)}`, engine: t.engine });
      c.missionId = m.id; t.convId = c.id;
    }
    persist(); writeBoard(m);
    log(m, `⚙️ ${t.id} começou com ${name(t.engine)}: ${t.title}`, { taskId: t.id, engine: t.engine });
    say(m, t.engine, 'exe', `Peguei a ${t.id}: ${t.title}. Começando agora.`, { taskId: t.id, kind: 'start' });
    let seen = (m.instructions || []).length;
    let r = await run({ mission: m, convId: t.convId, prompt: taskPrompt(m, t), engine: t.engine, mode: m.options.mode, skipPermissions: m.options.skip,
      device: 'agentos', label: `⚙️ ${t.id} ${t.title}`, browser: m.options.browser });
    const conv = store.conversations[t.convId];
    t.engineUsed = conv ? conv.engine : t.engine;
    if (m.state === 'cancelado' || r.status === 'CANCELLED') { t.status = 'cancelada'; return; }
    // instruções que o usuário mandou no chat ENQUANTO esta tarefa rodava → o mesmo agente aplica antes da verificação
    for (let k = 0; k < 2 && r.status === 'SUCCESS' && (m.instructions || []).length > seen; k++) {
      const fresh = m.instructions.slice(seen); seen = m.instructions.length;
      say(m, t.engineUsed, 'exe', `Vi sua mensagem no chat. Ajustando a ${t.id} agora.`, { taskId: t.id, kind: 'fix' });
      r = await run({ mission: m, convId: t.convId, engine: t.engineUsed, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
        label: `💬 ${t.id} nova instrução`, browser: m.options.browser,
        prompt: `Enquanto você trabalhava na ${t.id}, o usuário mandou no chat da missão:\n${fresh.map((i) => '- ' + i.text).join('\n')}\n\n` +
          `Aplique o que for relevante para a SUA tarefa (${t.title}) no que você já fez, teste de novo e responda com o resumo e o mesmo bloco JSON de antes. ` +
          `Se nada se aplicar à sua tarefa, diga isso e repita o JSON.` });
      if (m.state === 'cancelado' || r.status === 'CANCELLED') { t.status = 'cancelada'; return; }
    }
    for (;;) {
      t.output = String(r.text || '');
      const j = extractJson(t.output);
      t.summary = String((j && j.summary) || t.output.replace(/```[\s\S]*?```/g, '').trim().slice(0, 600));
      if (j && j.notes) m.notes.push(`${t.id}: ${String(j.notes).slice(0, 400)}`);
      write(taskPath(m, t), `# ${t.id} — ${t.title}\nIA: ${name(t.engineUsed)}\n\n## Instrução\n${t.prompt}\n\n## Resultado\n${t.output}\n` +
        (t.verdict ? `\n## Última verificação (${name(t.verdict.engine)}): ${t.verdict.pass ? 'APROVADA' : 'REPROVADA'}\n${t.verdict.issues.map((i) => '- ' + i).join('\n')}\n` : ''));
      if (r.status === 'SUCCESS') say(m, t.engineUsed, 'exe', `✅ Terminei a ${t.id}. ${t.summary}`.slice(0, 1500), { taskId: t.id, kind: 'done' });
      if (r.status !== 'SUCCESS') { say(m, t.engineUsed || t.engine, 'exe', `⚠️ Não consegui concluir a ${t.id}: ${String(r.error || 'erro').slice(0, 300)}`, { taskId: t.id, kind: 'error' }); t.status = 'falhou'; t.error = String(r.error || 'erro').slice(0, 300); log(m, `⚠️ ${t.id} falhou: ${t.error}`, { taskId: t.id }); break; }
      if (!m.options.verify) { log(m, `✅ ${t.id} concluída por ${name(t.engineUsed)}`, { taskId: t.id }); await acceptTask(m, t); break; }
      const pass = await verify(m, t);
      if (m.state === 'cancelado') { t.status = 'cancelada'; return; }
      if (pass) { await acceptTask(m, t); break; }
      if (t.fixes >= m.options.maxFix) { t.status = 'falhou'; t.error = 'Reprovada na verificação após ' + t.fixes + ' correção(ões)'; break; }
      t.fixes++; t.status = 'corrigindo'; persist();
      log(m, `🔧 ${t.id} correção ${t.fixes}/${m.options.maxFix} com ${name(t.engineUsed)}`, { taskId: t.id, engine: t.engineUsed });
      say(m, t.engineUsed, 'exe', `Entendido, @${t.verdict.engine}. Corrigindo a ${t.id} (tentativa ${t.fixes}/${m.options.maxFix}).`, { taskId: t.id, kind: 'fix' });
      r = await run({ mission: m, convId: t.convId, engine: t.engineUsed, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
        label: `🔧 ${t.id} correção ${t.fixes}`, browser: m.options.browser,
        prompt: `O verificador independente (${name(t.verdict.engine)}) REPROVOU sua tarefa ${t.id}. Problemas encontrados:\n${t.verdict.issues.map((i) => '- ' + i).join('\n')}\n` +
          (t.verdict.checks.length ? `\nChecagens:\n${t.verdict.checks.map((c) => `- [${c.ok ? 'ok' : 'falhou'}] ${c.criterion}: ${c.evidence || ''}`).join('\n')}\n` : '') +
          `${instructionsBlock(m)}\nCorrija tudo, rode/teste de novo e responda com o resumo e o mesmo bloco JSON de antes.` });
      if (m.state === 'cancelado' || r.status === 'CANCELLED') { t.status = 'cancelada'; return; }
    }
    t.finishedAt = now(); persist(); writeBoard(m);
  }

  async function schedule(m) {
    if (m._looping) return; m._looping = true; m._finished = false;
    try {
      m.tokensUsed = tokensOf(m);
      if (m.state !== 'pausado_limite') m.state = 'executando';
      persist();
      if (m.options.isolate) await ensureIsolation(m);
      if (overLimit(m)) pauseLimit(m);
      const running = new Map();
      for (;;) {
        if (m.state === 'cancelado') break;
        if (overLimit(m) && m.state === 'executando') pauseLimit(m);
        const paused = m.state === 'pausado_limite';
        for (const t of m.tasks) {
          if (t.status !== 'pendente') continue;
          const deps = t.deps.map((id) => m.tasks.find((x) => x.id === id)).filter(Boolean);
          if (deps.some((x) => ['falhou', 'cancelada', 'bloqueada'].includes(x.status))) { t.status = 'bloqueada'; t.error = 'Uma tarefa da qual depende não foi concluída'; log(m, `⛔ ${t.id} bloqueada (dependência falhou)`, { taskId: t.id }); }
        }
        const ready = m.tasks.filter((t) => t.status === 'pendente' && !running.has(t.id) &&
          t.deps.every((id) => { const x = m.tasks.find((y) => y.id === id); return !x || x.status === 'ok' || x.status === 'removida'; }));
        while (!paused && ready.length && running.size < m.options.parallel) {
          const t = ready.shift();
          running.set(t.id, runTask(m, t).catch((e) => { t.status = 'falhou'; t.error = e.message; log(m, `⚠️ ${t.id}: ${e.message}`); }).finally(() => running.delete(t.id)));
        }
        if (!running.size) break;
        await Promise.race(running.values());
      }
      // pausada pelo limite de tokens: as que rodavam terminaram; espera o usuário aumentar o limite
      if (m.state === 'pausado_limite') { persist(); writeBoard(m); return; }
      // tarefas que sobraram presas em ciclo de dependência
      for (const t of m.tasks) if (t.status === 'pendente') { t.status = 'bloqueada'; t.error = 'Dependência circular ou inexistente'; }
      if (m.state === 'cancelado') return finish(m);
      if (overLimit(m)) { pauseLimit(m); return; }
      await integrate(m);
    } catch (e) {
      m.state = 'erro'; m.error = e.message; log(m, '⚠️ Missão parou: ' + e.message);
    } finally { m._looping = false; }
    finish(m);
  }

  async function integrate(m) {
    m.state = 'integrando'; persist();
    log(m, `🧪 Integração final com ${name(m.options.lead)}`);
    const okN = m.tasks.filter((t) => t.status === 'ok').length, badN = m.tasks.filter((t) => ['falhou', 'bloqueada'].includes(t.status)).length;
    say(m, m.options.lead, 'arq', badN ? `${okN} tarefa(s) aprovada(s) e ${badN} com problema. Vou testar o conjunto e escrever o relatório com as pendências.`
      : 'Todas as tarefas passaram pela verificação. Vou testar o conjunto e escrever o relatório.', { kind: 'info' });
    // com isolamento a integração roda no worktree de integração (conversa própria: a sessão das CLIs fica presa à pasta)
    let convId = m.planConvId;
    const idir = intDir(m);
    if (iso(m)) {
      const ic = m.integConvId && store.conversations[m.integConvId];
      if (!ic || ic.cwd !== idir) { const c = newConv({ cwd: idir, title: `🧪 ${m.title.slice(0, 40)} · integração`, engine: m.options.lead }); c.missionId = m.id; m.integConvId = c.id; persist(); }
      convId = m.integConvId;
    }
    const r = await run({ mission: m, convId, engine: m.options.lead, mode: m.options.mode, skipPermissions: m.options.skip, device: 'agentos',
      label: '🧪 Integração e relatório', browser: m.options.browser,
      prompt: `Você é o ARQUITETO-CHEFE fechando a missão. Quadro: ${boardPath(m)}
${iso(m) ? `Pasta de trabalho: ${idir} — worktree git de integração (branch ${m.git.branch}), onde o trabalho aprovado de todas as tarefas já foi juntado. Teste e corrija AQUI, não na pasta original (${m.cwd}).\n` : `Pasta: ${m.cwd}\n`}Objetivo: ${m.goal}
${m.plan.testCommand ? 'Comando de teste planejado: ' + m.plan.testCommand + '\n' : ''}
Resultado das tarefas:
${m.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title} (${name(t.engineUsed || t.engine)}): ${String(t.summary || t.error || '').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}

Agora teste o CONJUNTO de verdade (rode o projeto/testes quando possível), corrija pequenos problemas de integração se achar, e responda com um relatório curto para o usuário e este JSON no final:
\`\`\`json
{"pass":true,"summary":"o que foi entregue","howToRun":"como rodar/usar","tests":"o que foi testado e o resultado","issues":["pendências reais, se houver"],"next":["próximos passos sugeridos"]}
\`\`\`` });
    const j = extractJson(r.text) || {};
    const allOk = m.tasks.every((t) => t.status === 'ok' || t.status === 'removida');
    m.report = { pass: r.status === 'SUCCESS' && j.pass !== false && allOk, summary: String(j.summary || ''), howToRun: String(j.howToRun || ''),
      tests: String(j.tests || ''), issues: Array.isArray(j.issues) ? j.issues.map(String) : [], next: Array.isArray(j.next) ? j.next.map(String) : [],
      text: String(r.text || '').replace(/```json[\s\S]*?```/g, '').trim().slice(0, 6000), at: now() };
    say(m, m.options.lead, 'arq', (m.report.pass ? '🏁 Pronto! ' : '🏁 Terminei, com pendências. ') + (m.report.summary || '') +
      (m.report.howToRun ? '\n\n▶️ Como rodar: ' + m.report.howToRun : '') + (m.report.issues.length ? '\n\n⚠️ Pendências:\n' + m.report.issues.map((i) => '• ' + i).join('\n') : ''), { kind: 'report', pass: m.report.pass });
    write(path.join(dirOf(m), 'REPORT.md'), `# Relatório — ${m.title}\n\n${m.report.text}\n\n## Como rodar\n${m.report.howToRun}\n\n## Testes\n${m.report.tests}\n\n## Pendências\n${m.report.issues.map((i) => '- ' + i).join('\n') || '- nenhuma'}\n`);
    // ajustes que a integração fez no worktree de integração viram um commit
    if (iso(m)) {
      await withLock(m, async () => {
        const mw = m.git.mainWt;
        if (await merging(mw)) await git(mw, ['merge', '--abort']);
        await addAll(mw);
        if (!(await git(mw, ['diff', '--cached', '--quiet'])).ok) await git(mw, [...await ident(m.git.root), 'commit', '-q', '--no-verify', '-m', 'agentos: ajustes da integração final']);
      });
    }
  }

  function finish(m) {
    if (m._finished) return;
    m._finished = true;
    if (m.state !== 'cancelado' && m.state !== 'erro') m.state = m.report && m.report.pass ? 'concluido' : 'concluido_com_pendencias';
    m.finishedAt = now(); writeBoard(m);
    if (m.git && m.git.status === 'ativo' && m.options.isolate) {
      if (m.state === 'cancelado') {
        m.git.status = 'cancelada';
        // as CLIs acabaram de ser encerradas; espera soltarem os arquivos antes de remover os worktrees
        setTimeout(() => removeWorktrees(m).then((f) => say(m, 'system', 'sys', f.length ? `🧹 Não consegui remover ${f.length} worktree(s) agora (arquivos em uso). Use “Descartar resultado” depois.` : `🧹 Worktrees da missão removidos. Os branches (${m.git.branch}…) continuam: apague em “Descartar resultado” se não precisar.`, { kind: 'info' })).catch(() => {}), 2500);
      } else if (m.state === 'concluido' || m.state === 'concluido_com_pendencias') {
        m.git.status = 'pronta'; persist();
        say(m, 'system', 'sys', `🌿 Pronta para aplicar: o resultado está no branch \`${m.git.branch}\`. Sua pasta ainda não mudou — use “✅ Aplicar no projeto” ou “🗑 Descartar resultado”.`, { kind: 'ready' });
        if (m.options.autoApply && m.state === 'concluido') {
          applyResult(m).catch((e) => say(m, 'system', 'sys', '⚠️ Não consegui aplicar automaticamente: ' + e.message, { kind: 'error' }));
        }
      }
    }
    log(m, m.state === 'concluido' ? '🏁 Missão concluída e verificada' : m.state === 'cancelado' ? '⏹ Missão cancelada' : m.state === 'erro' ? '⚠️ Missão com erro' : '🏁 Missão terminou com pendências');
    broadcast({ type: m.state === 'concluido' ? 'done' : 'blocked', convId: m.planConvId, missionId: m.id, title: '🧠 ' + m.title, status: m.state,
      text: m.report && m.report.summary ? m.report.summary.slice(0, 200) : 'Missão: ' + m.state, denied: [] });
  }

  // ---------------------------------------------------------------- conversar durante a execução
  async function userChat(m, text, silent) {
    if (!silent) {
      say(m, 'user', 'user', text, { kind: 'user' });
      (m.instructions || (m.instructions = [])).push({ ts: now(), text });
    }
    persist(); writeBoard(m);
    const running = ACTIVE.has(m.state) || m._looping;
    if (!m.chatConvId) {
      const c = newConv({ cwd: m.cwd, title: `💬 ${m.title.slice(0, 40)} · chat`, engine: m.options.lead });
      c.missionId = m.id; m.chatConvId = c.id; persist();
    }
    m._replying = true;
    try {
      const status = m.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title} (@${t.engineUsed || t.engine})${t.summary ? ': ' + t.summary.replace(/\s+/g, ' ').slice(0, 160) : ''}`).join('\n') || '(ainda sem tarefas)';
      const r = await run({ mission: m, convId: m.chatConvId, engine: m.options.lead, mode: 'plan', device: 'agentos', label: '💬 Chat da missão',
        prompt: `Você é o ARQUITETO do Agente OS falando com o usuário no chat em grupo da missão (estilo WhatsApp: respostas curtas, diretas, em português).
Missão: ${m.goal}
Pasta: ${m.cwd} · Quadro: ${boardPath(m)}
Estado: ${m.state}${running ? ' (a equipe está trabalhando agora)' : ''}
Tarefas:
${status}
Equipe disponível: ${m.options.engines.map((e) => '@' + e).join(', ')}

O usuário escreveu: "${text.replace(/"/g, "'")}"

A mensagem dele já foi repassada como instrução prioritária para todos os agentes nas próximas etapas.
Se for uma pergunta, responda. Se pedir trabalho novo ou mudança, crie tarefas novas (ids novos; podem depender das existentes).
Se pedir para parar algo, liste em cancelTasks (só tarefas pendentes). Responda SOMENTE com JSON:
\`\`\`json
{"reply":"resposta curta para o usuário","newTasks":[{"id":"n1","title":"...","engine":"${m.options.engines.join('|')}","deps":[],"files":[],"prompt":"instrução completa","acceptance":["..."]}],"cancelTasks":[]}
\`\`\`` });
      const j = extractJson(r.text) || {};
      say(m, m.options.lead, 'arq', String(j.reply || (r.status === 'SUCCESS' ? r.text : 'Anotado! Repassei sua instrução para a equipe.')).replace(/```[\s\S]*?```/g, '').trim().slice(0, 1500) || 'Anotado!', { kind: 'reply' });
      for (const id of Array.isArray(j.cancelTasks) ? j.cancelTasks : []) {
        const t = m.tasks.find((x) => x.id === String(id));
        if (t && t.status === 'pendente') { t.status = 'removida'; t.removed = true; log(m, `🗑 ${t.id} removida a pedido do usuário`, { taskId: t.id }); }
      }
      const add = Array.isArray(j.newTasks) ? j.newTasks.slice(0, 6) : [];
      if (add.length) {
        const base = m.tasks.length;
        const map = {};
        add.forEach((x, i) => { map[String(x.id || 'n' + (i + 1))] = 't' + (base + i + 1); });
        const engines = m.options.engines;
        for (const [i, x] of add.entries()) {
          m.tasks.push({ id: 't' + (base + i + 1), title: String(x.title || 'Tarefa extra').slice(0, 90),
            engine: engines.includes(x.engine) ? x.engine : engines[i % engines.length],
            deps: (Array.isArray(x.deps) ? x.deps : []).map((d) => map[String(d)] || (m.tasks.find((t) => t.id === String(d)) ? String(d) : null)).filter(Boolean),
            files: (Array.isArray(x.files) ? x.files : []).map(String).slice(0, 12), prompt: String(x.prompt || x.title || ''),
            acceptance: (Array.isArray(x.acceptance) ? x.acceptance : []).map(String).slice(0, 8),
            status: 'pendente', attempts: 0, fixes: 0, convId: null, summary: '', verdict: null, fromChat: true });
        }
        m.report = null;
        writeBoard(m);
        log(m, `💬 ${add.length} tarefa(s) nova(s) criadas pelo chat`);
        say(m, 'system', 'sys', `➕ ${add.length} tarefa(s) adicionada(s) ao plano pelo Arquiteto.`, { kind: 'info' });
        if (!m._looping && m.state !== 'cancelado') { m._finished = false; schedule(m); }
      }
    } catch (e) {
      say(m, 'system', 'sys', '⚠️ O Arquiteto não conseguiu responder: ' + e.message, { kind: 'error' });
    } finally {
      m._replying = false; persist();
      // mensagens que chegaram enquanto o Arquiteto respondia: responde a todas juntas
      const pend = (m._pendingChat || []).splice(0);
      if (pend.length) userChat(m, pend.join(' / '), true);
    }
  }

  // ---------------------------------------------------------------- API
  async function start(b) {
    const usable = usableEngines();
    if (!usable.length) throw new Error('Nenhuma IA ligada e instalada.');
    const goal = String(b.goal || '').trim();
    if (!goal) throw new Error('Diga o que você quer que o Agente OS faça.');
    const cwd = b.cwd;
    if (!cwd || !fs.existsSync(cwd)) throw new Error('Pasta não existe: ' + cwd);
    const engines = (Array.isArray(b.engines) && b.engines.length ? b.engines : usable).filter((e) => usable.includes(e));
    if (!engines.length) throw new Error('Nenhuma das IAs escolhidas está disponível.');
    const lead = engines.includes(b.lead) ? b.lead : (engines.includes('claude') ? 'claude' : engines[0]);
    const id = crypto.randomUUID();
    const title = String(b.title || goal).replace(/\s+/g, ' ').slice(0, 70);
    const pc = newConv({ cwd, title: '🧠 ' + title, engine: lead }); pc.missionId = id;
    const m = M[id] = {
      id, title, goal, cwd, state: 'planejando', createdAt: now(), updatedAt: now(), planConvId: pc.id,
      options: { engines, lead, verify: b.verify !== false, maxFix: Math.max(0, Math.min(4, Number(b.maxFix ?? 2))),
        parallel: Math.max(1, Math.min(4, Number(b.parallel || 2))), cheap: !!b.cheap, mode: b.mode || 'edit', skip: !!b.skip, browser: !!b.browser, approve: !!b.approve,
        isolate: b.isolate !== false, autoApply: !!b.autoApply,
        maxTokens: b.maxTokens == null || b.maxTokens === '' ? DEFAULT_MAX_TOKENS : Math.max(0, Math.round(Number(b.maxTokens) || 0)) },
      plan: {}, tasks: [], log: [], notes: [], followUps: [], report: null, device: b.device || null, chat: [], instructions: [], tokensUsed: 0,
      automationId: b.automationId || null,
    };
    persist();
    log(m, `🧠 Missão criada. Líder: ${name(lead)} · equipe: ${engines.map(name).join(', ')}`);
    say(m, 'user', 'user', goal, { kind: 'goal' });
    say(m, lead, 'arq', `Recebido! Vou analisar a pasta e montar o plano com ${engines.filter((e) => e !== lead).map((e) => '@' + e).join(', ') || 'a equipe'}.`, { kind: 'info' });
    (async () => {
      try {
        if (m.options.isolate) { try { await setupIsolation(m); } catch (e) { m.options.isolate = false; say(m, 'system', 'sys', '🌿 Isolamento desligado: ' + e.message, { kind: 'error' }); } }
        await plan(m, goal);
        if (m.state === 'cancelado') return finish(m);
        if (m.options.approve) { m.state = 'aguardando'; log(m, '⏸ Plano pronto. Aguardando sua aprovação.'); broadcast({ type: 'blocked', convId: m.planConvId, missionId: m.id, title: '🧠 ' + m.title, status: 'aguardando', text: 'Plano pronto para aprovar', denied: [] }); return; }
        await schedule(m);
      } catch (e) { m.state = 'erro'; m.error = e.message; log(m, '⚠️ ' + e.message); finish(m); }
    })();
    return m;
  }

  function public_(m) {
    const { _looping, _finished, _replying, _pendingChat, ...rest } = m;
    return { ...rest, typing: typing(m), board: boardPath(m), dir: dirOf(m), tokensUsed: m.tokensUsed || 0, maxTokens: maxOf(m), looping: !!_looping,
      tasks: m.tasks.map((t) => ({ ...t, output: undefined, outputPreview: String(t.output || '').slice(0, 3000) })) };
  }

  function cancel(m) {
    m.state = 'cancelado'; persist();
    say(m, 'system', 'sys', '⏹ Missão cancelada por você.', { kind: 'info' });
    for (const t of m.tasks) { if (t.convId) cancelConv(t.convId); if (t.verifyConvId) cancelConv(t.verifyConvId); if (['pendente', 'rodando', 'verificando', 'corrigindo', 'mesclando'].includes(t.status)) t.status = 'cancelada'; }
    cancelConv(m.planConvId);
    if (m.integConvId) cancelConv(m.integConvId);
    if (!m._looping) finish(m);
  }

  async function route(req, res, url, p, readBody, send) {
    if (p === '/api/missions' && req.method === 'GET') {
      return send(res, 200, { missions: Object.values(M).sort((a, b) => b.updatedAt - a.updatedAt).map(summarize), strengths: STRENGTHS }), true;
    }
    if (p === '/api/missions' && req.method === 'POST') {
      try { const m = await start(await readBody(req)); return send(res, 200, { id: m.id, mission: public_(m) }), true; }
      catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    let mm = p.match(/^\/api\/missions\/([\w-]+)(?:\/(cancel|approve|resume|message|chat|limit|apply|discard|tasks\/(t\d+)\/(retry|engine)))?$/);
    if (!mm) return false;
    const m = M[mm[1]];
    if (!m) return send(res, 404, { error: 'Missão não encontrada' }), true;
    const act = mm[2];
    if (!act && req.method === 'GET') return send(res, 200, { mission: public_(m) }), true;
    if (act === 'chat' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      return send(res, 200, { chat: (m.chat || []).filter((c) => c.ts > after), typing: typing(m), state: m.state, title: m.title,
        done: m.tasks.filter((t) => t.status === 'ok').length, total: m.tasks.length, lead: m.options.lead, engines: m.options.engines,
        tokensUsed: m.tokensUsed || 0, maxTokens: maxOf(m), gitStatus: m.git ? m.git.status : null }), true;
    }
    if (!act && req.method === 'DELETE') {
      if (ACTIVE.has(m.state) || m._looping) return send(res, 400, { error: 'Cancele a missão antes de apagar.' }), true;
      // apagar a missão remove os worktrees dela; os branches só com ?branches=1
      let failed = [];
      if (m.git && m.git.status !== 'aplicada' && m.git.status !== 'descartada') {
        try { failed = await removeWorktrees(m); if (url.searchParams.get('branches') === '1') await deleteBranches(m); } catch {}
      }
      delete M[m.id]; persist(); return send(res, 200, { ok: true, failed }), true;
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não suportado' }), true;
    const b = await readBody(req).catch(() => ({}));
    if (act === 'cancel') { cancel(m); return send(res, 200, { ok: true }), true; }
    if (act === 'limit') {
      const n = Math.round(Number(b.maxTokens));
      if (!(n >= 0)) return send(res, 400, { error: 'Limite inválido' }), true;
      m.tokensUsed = tokensOf(m);
      if (n > 0 && n <= m.tokensUsed) return send(res, 400, { error: `O novo limite precisa ser maior que o uso atual (${fmtTok(m.tokensUsed)}).` }), true;
      m.options.maxTokens = n; persist();
      say(m, 'system', 'sys', `🎯 Limite de tokens agora é ${n ? fmtTok(n) : 'ilimitado'} (usados: ${fmtTok(m.tokensUsed)}).`, { kind: 'info' });
      if (m.state === 'pausado_limite') {
        m.state = 'executando'; m.pausedAt = null; persist();
        log(m, '▶️ Retomando: limite de tokens aumentado');
        if (!m._looping) schedule(m);
      }
      return send(res, 200, { ok: true, maxTokens: n, tokensUsed: m.tokensUsed }), true;
    }
    if (act === 'apply') {
      try { const r = await applyResult(m); return send(res, 200, { ok: true, ...r }), true; }
      catch (e) { say(m, 'system', 'sys', '⚠️ Não apliquei: ' + e.message, { kind: 'error' }); return send(res, 400, { error: e.message }), true; }
    }
    if (act === 'discard') {
      try { const r = await discardResult(m, b.branches !== false); return send(res, 200, { ok: true, ...r }), true; }
      catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    if (act === 'chat') {
      const text = String(b.text || '').trim();
      if (!text) return send(res, 400, { error: 'Mensagem vazia' }), true;
      if (m._replying) {
        say(m, 'user', 'user', text, { kind: 'user' });
        (m.instructions || (m.instructions = [])).push({ ts: now(), text });
        (m._pendingChat || (m._pendingChat = [])).push(text);
        persist(); writeBoard(m);
        return send(res, 200, { ok: true, queued: true }), true;
      }
      userChat(m, text);
      return send(res, 200, { ok: true }), true;
    }
    if (act === 'approve') {
      if (m.state !== 'aguardando') return send(res, 400, { error: 'A missão não está aguardando aprovação.' }), true;
      if (Array.isArray(b.tasks)) for (const e of b.tasks) { const t = m.tasks.find((x) => x.id === e.id); if (!t) continue; if (e.remove) { t.status = 'removida'; t.removed = true; } if (e.engine && m.options.engines.includes(e.engine)) t.engine = e.engine; }
      log(m, '▶️ Plano aprovado'); schedule(m); return send(res, 200, { ok: true }), true;
    }
    if (act === 'resume') {
      if (ACTIVE.has(m.state) || m._looping) return send(res, 400, { error: 'A missão já está rodando.' }), true;
      for (const t of m.tasks) if (['bloqueada', 'cancelada', 'falhou'].includes(t.status) && b.all) { t.status = 'pendente'; t.fixes = 0; }
      if (m.state === 'pausado_limite' && !overLimit(m)) m.state = 'executando';
      log(m, '▶️ Retomando'); schedule(m); return send(res, 200, { ok: true }), true;
    }
    if (act === 'message') {
      const text = String(b.text || '').trim();
      if (!text) return send(res, 400, { error: 'Escreva o que mais o Agente OS deve fazer.' }), true;
      if (ACTIVE.has(m.state) || m._looping) return send(res, 400, { error: 'Espere a missão terminar a etapa atual (ou cancele).' }), true;
      m.followUps.push({ text, ts: now() }); m._finished = false; m.state = 'planejando'; m.report = null; persist();
      log(m, '💬 Novo pedido: ' + text.slice(0, 160));
      (async () => { try { await plan(m, text, true); await schedule(m); } catch (e) { m.state = 'erro'; m.error = e.message; log(m, '⚠️ ' + e.message); finish(m); } })();
      return send(res, 200, { ok: true }), true;
    }
    const t = m.tasks.find((x) => x.id === mm[3]);
    if (!t) return send(res, 404, { error: 'Tarefa não encontrada' }), true;
    if (mm[4] === 'engine') {
      if (!m.options.engines.includes(b.engine)) return send(res, 400, { error: 'IA inválida para esta missão' }), true;
      if (['rodando', 'verificando', 'corrigindo'].includes(t.status)) return send(res, 400, { error: 'Tarefa em andamento' }), true;
      t.engine = b.engine; t.convId = null; persist(); writeBoard(m); return send(res, 200, { ok: true }), true;
    }
    if (mm[4] === 'retry') {
      if (['rodando', 'verificando', 'corrigindo'].includes(t.status)) return send(res, 400, { error: 'Tarefa em andamento' }), true;
      t.status = 'pendente'; t.fixes = 0; t.error = null; t.verdict = null;
      for (const x of m.tasks) if (x.status === 'bloqueada') x.status = 'pendente';
      log(m, `🔁 ${t.id} vai rodar de novo`, { taskId: t.id });
      if (!m._looping) schedule(m);
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }

  return { route, start, list: () => Object.values(M).map(summarize), get: (id) => M[id] && public_(M[id]), STRENGTHS, ACTIVE };
};
