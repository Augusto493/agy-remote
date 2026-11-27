// Agente OS — central de missões (UI). Usa os globais do script principal: api, state, esc, toast, ago, fmtSec,
// sheet, closeSheet, $, $$, go, openConv. Só mexe dentro de #osRoot e no badge .pip do botão "Agente OS".
(function () {
  'use strict';

  // ------------------------------------------------------------------ constantes
  const ENG = {
    claude: { name: 'Claude Code', short: 'Claude', cls: 'e-claude', role: 'Arquitetura' },
    codex: { name: 'Codex', short: 'Codex', cls: 'e-codex', role: 'Implementação' },
    agy: { name: 'Antigravity', short: 'Antigravity', cls: 'e-agy', role: 'Front-end e pesquisa' },
    opencode: { name: 'OpenCode', short: 'OpenCode', cls: 'e-opencode', role: 'Tarefas rápidas' },
  };
  const M_ST = {
    planejando: ['Planejando', 'run'], aguardando: ['Aguardando aprovação', 'need'], executando: ['Executando', 'run'],
    integrando: ['Integrando', 'run'], concluido: ['Concluída', 'ok'], concluido_com_pendencias: ['Com pendências', 'need'],
    erro: ['Erro', 'err'], cancelado: ['Cancelada', 'off'], interrompido: ['Interrompida', 'warn'], pausado_limite: ['Pausada: limite de tokens', 'need'],
  };
  const T_ST = {
    pendente: ['Na fila', 'off'], rodando: ['Rodando', 'run'], verificando: ['Verificando', 'run'], corrigindo: ['Corrigindo', 'warn'],
    mesclando: ['Juntando', 'run'], ok: ['Aprovada', 'ok'], falhou: ['Falhou', 'err'], bloqueada: ['Bloqueada', 'err'], cancelada: ['Cancelada', 'off'], removida: ['Removida', 'off'],
  };
  const ACTIVE = ['planejando', 'executando', 'integrando'];
  const NEED = ['aguardando', 'erro', 'concluido_com_pendencias', 'interrompido', 'pausado_limite'];
  const BUSY_T = ['rodando', 'verificando', 'corrigindo', 'mesclando'];
  const FILTERS = [
    ['todas', 'Todas', () => true],
    ['rodando', 'Rodando', (m) => ACTIVE.includes(m.state)],
    ['eu', 'Precisa de você', (m) => NEED.includes(m.state)],
    ['fim', 'Concluídas', (m) => ['concluido', 'concluido_com_pendencias', 'cancelado'].includes(m.state)],
  ];
  const COLS = [
    ['Na fila', ['pendente']], ['Executando', ['rodando', 'corrigindo', 'mesclando']], ['Verificando', ['verificando']],
    ['Concluídas', ['ok']], ['Problemas', ['falhou', 'bloqueada', 'cancelada']],
  ];
  const SUGS = [
    ['App completo do zero', 'Crie um app web de lista de tarefas em HTML, CSS e JS puro, com testes automatizados', '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9h17M8 13.5l2 2 4-4"/></svg>'],
    ['Caça-bugs com testes', 'Encontre e corrija os bugs deste projeto e garanta que os testes passam', '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>'],
    ['Cobertura de testes', 'Escreva testes automatizados para o código que já existe, rode todos e documente como rodar', '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M10.5 9.5l3 5M16 5v5M5 16h5"/></svg>'],
  ];
  const IC = {
    cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/></svg>',
    wrench: '<svg viewBox="0 0 24 24"><path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.1 2.1 0 0 1-3-3l8-8a4 4 0 0 1-2-2z"/></svg>',
    filter: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // ------------------------------------------------------------------ estado
  const LSK = 'agy.os.';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(LSK + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(LSK + k, JSON.stringify(v)); } catch {} },
  };
  const S = {
    built: false, missions: [], loaded: false, strengths: {}, filter: 'todas', q: '', fEng: '', sel: ls.get('sel', null), mission: null,
    view: ls.get('board', 'grafo'), panel: null, openCards: new Set(), approve: {}, listAt: 0, detAt: 0, statsAt: 0,
    cache: {}, testing: {}, busy: false, carousel: 1,
    opts: Object.assign({ cwd: '', engines: [], lead: '', parallel: 2, verify: true, maxFix: 2, skip: false, approve: false, browser: false, cheap: true, isolate: true, autoApply: false, maxTokens: 3000000 }, ls.get('opts', {})),
  };
  const saveOpts = () => ls.set('opts', S.opts);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const say = (t) => (typeof toast === 'function' ? toast(t) : console.log(t));
  const Q = (s, r) => (r || document).querySelector(s);
  const QQ = (s, r) => [...(r || document).querySelectorAll(s)];
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
  const isMobile = () => window.matchMedia('(max-width:820px)').matches;
  const engObj = (id) => (state.engines || []).find((x) => x.id === id);
  const engName = (id) => { const e = engObj(id); return (e && e.name) || (ENG[id] && ENG[id].name) || id || 'IA'; };
  const engShort = (id) => (ENG[id] && ENG[id].short) || engName(id);
  const ecls = (id) => (ENG[id] ? ENG[id].cls : 'e-other');
  const engChip = (id, extra) => `<span class="os-eng ${ecls(id)}" title="${E(engName(id))}"><i></i>${E(engShort(id))}${extra || ''}</span>`;
  const engDot = (id) => `<i class="os-edot ${ecls(id)}" title="${E(engName(id))}"></i>`;
  const usable = () => (state.engines || []).filter((e) => e.enabled && e.installed).map((e) => e.id);
  const dur = (ms) => { const s = Math.max(0, ms / 1000); return typeof fmtSec === 'function' ? fmtSec(s) : Math.round(s) + 's'; };
  const when = (ts) => (!ts ? '—' : typeof ago === 'function' ? ago(ts) : new Date(ts).toLocaleString('pt-BR'));
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dt = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  const visible = () => state.view === 'os' && !document.hidden;
  const mdx = (t) => (typeof md === 'function' ? md(t) : '<p>' + E(t).replace(/\n/g, '<br>') + '</p>');
  function patch(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
  function stBadge(map, st) { const [t, c] = map[st] || [st, 'off']; return `<span class="os-st s-${c}"><i></i>${E(t)}</span>`; }
  const needChip = (m) => NEED.includes(m.state) ? '<span class="os-need">Precisa de você</span>' : '';
  function openChat(id) { if (!id) return say('Essa conversa ainda não existe.'); go('chat'); openConv(id); }
  const tok = (n) => (typeof fmtTok === 'function' ? fmtTok(n) : String(n || 0));
  const limTxt = (n) => (n ? tok(n) : 'sem limite');
  // "em 2 h", "em 5 min"
  function inTime(ts) {
    if (!ts) return '—';
    const s = (ts - Date.now()) / 1000;
    if (s < 45) return 'em instantes';
    if (s < 3600) return 'em ' + Math.round(s / 60) + ' min';
    if (s < 86400) { const h = Math.floor(s / 3600), mi = Math.round((s % 3600) / 60); return 'em ' + h + ' h' + (mi && h < 6 ? ' ' + mi + ' min' : ''); }
    return 'em ' + Math.round(s / 86400) + ' dia' + (Math.round(s / 86400) > 1 ? 's' : '');
  }
  function tokBar(used, max) {
    const pct = max ? Math.min(100, Math.round((used || 0) / max * 100)) : 0;
    return `<span class="os-tok ${max && pct >= 100 ? 'over' : pct >= 80 ? 'near' : ''}" title="Tokens usados nesta missão / limite">🎯 <b class="num">${E(tok(used))}</b> / ${E(limTxt(max))}${max ? `<span class="os-tokbar"><i style="width:${pct}%"></i></span>` : ''}</span>`;
  }
  const mElapsed = (m) => (m.finishedAt || (ACTIVE.includes(m.state) || m.state === 'aguardando' ? Date.now() : m.updatedAt)) - m.createdAt;

  // ------------------------------------------------------------------ esqueleto
  function build() {
    const root = document.getElementById('osRoot');
    if (!root) return false;
    root.innerHTML = `
      <div class="os-page" id="osHomeP"><div class="os-in">
        <header class="os-head">
          <div class="os-head-t"><h1>Agente OS</h1><p id="osSub">Carregando missões…</p></div>
          <button class="os-tool os-autobtn" id="osAutoGo" title="Ver as automações agendadas">⏰ <span>Automações</span><b class="num" id="osAutoN" hidden></b></button><button class="os-cta" id="osNew"><span>+</span> Nova missão</button>
        </header>
        <div class="os-cmd" id="osCmdBox"></div>
        <section class="os-sec"><div class="os-sec-h"><h2>Sua equipe de IA</h2><span class="muted">Cada missão distribui as tarefas pela especialidade de cada uma</span></div>
          <div class="os-team" id="osTeam"></div></section>
        <section class="os-sec"><div class="os-tabsrow">
            <div class="os-tabs" id="osTabs"></div>
            <div class="os-tools"><button class="os-tool" id="osFilt">${IC.filter}<span>Filtro</span></button>
              <label class="os-search">${IC.search}<input id="osQ" placeholder="Buscar missões" autocomplete="off"></label></div>
          </div>
          <div id="osTable"></div></section>
        <section class="os-sec" id="osAutoSec"><div class="os-sec-h"><h2>⏰ Automações</h2><span class="muted">Missões e prompts que rodam sozinhos na hora marcada</span><span style="flex:1"></span><button class="btn sm primary" id="osAutoNew">+ Nova automação</button></div>
          <div class="os-autosugs" id="osAutoSugs"></div><div class="os-autos" id="osAutos"></div></section>
      </div></div>
      <div class="os-page" id="osDetP" hidden><div class="os-in os-wide" id="osDetail"></div></div>
      <aside class="os-tpanel" id="osPanel" hidden></aside>
      <div class="os-scrim" id="osScrim" hidden></div>`;
    root.addEventListener('toggle', (e) => {
      const d = e.target; if (!d.dataset || !d.dataset.card) return;
      if (d.open) S.openCards.add(d.dataset.card); else S.openCards.delete(d.dataset.card);
      const host = d.closest('[data-sec]') || d.closest('#osPanel'); if (host) host._h = null;
    }, true);
    Q('#osNew', root).onclick = () => newMission();
    Q('#osAutoGo', root).onclick = () => { Q('#osAutoSec').scrollIntoView({ behavior: 'smooth', block: 'start' }); loadAutos(); };
    Q('#osAutoNew', root).onclick = () => autoForm(null);
    Q('#osAutoSugs', root).innerHTML = AUTO_SUGS.map((x, i) => `<button class="os-sug os-asug" data-asug="${i}"><b>${E(x.label)}</b><span>${E(x.goal)}</span></button>`).join('');
    QQ('[data-asug]', root).forEach((b) => b.onclick = () => autoForm(null, AUTO_SUGS[+b.dataset.asug]));
    Q('#osAutos', root).onclick = onAutoClick;
    Q('#osQ', root).oninput = (e) => { S.q = e.target.value.trim().toLowerCase(); renderList(); };
    Q('#osFilt', root).onclick = pickFilter;
    Q('#osPanel', root).onclick = onDetailClick;
    Q('#osScrim', root).onclick = () => setPanel(null);
    buildCmd();
    buildDetail();
    S.built = true;
    return true;
  }

  function newMission(text) {
    if (S.sel) select(null);
    const ta = Q('#osGoal');
    if (typeof text === 'string') { ta.value = text; ls.set('draft', text); }
    grow();
    Q('#osHomeP').scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 60);
  }

  // ------------------------------------------------------------------ barra de comando
  function grow() { const ta = Q('#osGoal'); if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 76), window.innerHeight * 0.4) + 'px'; }
  function buildCmd() {
    const el = Q('#osCmdBox');
    el.innerHTML = `
      <div class="os-greet"><h2>O que a sua equipe de IA vai construir hoje?</h2><p id="osOnline"></p></div>
      <div class="os-cmd-box">
        <textarea id="osGoal" rows="2" placeholder="Diga o que você quer construir ou resolver…"></textarea>
        <div class="os-cmd-bar"><div class="os-modes" id="osModes"></div>
          <button class="os-send" id="osGo" aria-label="Iniciar missão" title="Iniciar missão (Enter)"><svg><use href="#i-send"/></svg></button></div>
      </div>
      <div class="os-cfg"><div class="os-pills" id="osPills"></div><span class="os-kbd hide-m">Enter envia · <kbd>Shift + Enter</kbd> nova linha</span></div>
      <div class="os-warn" id="osWarn"></div>
      <div class="os-sugs">${SUGS.map(([t, s, ic], i) => `<button class="os-sug" data-sug="${i}"><span class="os-sug-h"><span class="os-sug-i">${ic}</span><span class="os-sug-a">→</span></span><b>${E(t)}</b><span>${E(s)}</span></button>`).join('')}</div>`;
    const ta = Q('#osGoal');
    ta.value = ls.get('draft', '');
    ta.oninput = () => { ls.set('draft', ta.value); grow(); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); launch(); } };
    Q('#osGo').onclick = launch;
    QQ('[data-sug]', el).forEach((b) => b.onclick = () => { ta.value = SUGS[+b.dataset.sug][1]; ls.set('draft', ta.value); grow(); ta.focus(); });
    renderPills();
  }

  function fixOpts() {
    const ws = (state.info && state.info.workspaces) || [];
    if (!S.opts.cwd) S.opts.cwd = state.cwd || ws[0] || '';
    const ok = usable();
    if (ok.length) {
      S.opts.engines = S.opts.engines.filter((e) => ok.includes(e));
      if (!S.opts.engines.length) S.opts.engines = ok.slice();
      if (!S.opts.engines.includes(S.opts.lead)) S.opts.lead = S.opts.engines.includes('claude') ? 'claude' : S.opts.engines[0];
    }
  }

  function renderPills() {
    if (!Q('#osPills')) return;
    fixOpts();
    const o = S.opts;
    const pill = (id, icon, label, on, title) => `<button class="chip ${on === undefined ? '' : 'toggle' + (on ? ' on' : '')}" id="${id}" title="${E(title || '')}">${icon ? `<svg><use href="#${icon}"/></svg>` : ''}<span>${label}</span></button>`;
    const team = o.engines.length ? o.engines.map(engDot).join('') + ' ' + (o.engines.length === 1 ? E(engShort(o.engines[0])) : o.engines.length + ' IAs') : 'Equipe';
    const on = usable();
    Q('#osOnline').innerHTML = on.length ? `<span class="os-online">${on.map(engDot).join('')}</span>Equipe online: <b>${on.length} IA${on.length > 1 ? 's' : ''}</b><span class="os-names">· ${on.map((x) => E(engShort(x))).join(', ')}</span>` : 'Nenhuma IA ligada — ative nos Ajustes.';
    const mode = (id, ic, label, isOn, title) => `<button class="os-mode ${isOn ? 'on' : ''}" id="${id}" title="${E(title)}">${ic}<span>${label}</span></button>`;
    Q('#osModes').innerHTML =
      mode('osMDeep', '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>', 'Raciocínio profundo', o.approve, 'Pausa para você revisar e aprovar o plano antes de executar') +
      mode('osMSwarm', '<svg viewBox="0 0 24 24"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l3 7M16 8l-3 7M8.2 7h7.6"/></svg>', 'Modo enxame', o.parallel >= 3, 'Roda 3 tarefas ao mesmo tempo') +
      mode('osMStrict', '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>', 'Verificação rigorosa', o.verify && o.maxFix >= 3, 'Verificação cruzada com até 3 correções por tarefa');
    Q('#osMDeep').onclick = () => { o.approve = !o.approve; saveOpts(); renderPills(); };
    Q('#osMSwarm').onclick = () => { o.parallel = o.parallel >= 3 ? 2 : 3; saveOpts(); renderPills(); };
    Q('#osMStrict').onclick = () => { if (o.verify && o.maxFix >= 3) o.maxFix = 2; else { o.verify = true; o.maxFix = 3; } saveOpts(); renderPills(); };
    Q('#osPills').innerHTML = [
      pill('osPCwd', 'i-folder', E(baseName(o.cwd) || 'Pasta'), undefined, o.cwd),
      pill('osPTeam', 'i-team', team, undefined, 'Equipe de IAs'),
      pill('osPLead', '', '🧭 Líder: ' + E(engShort(o.lead)), undefined, 'IA que planeja e integra'),
      pill('osPPar', '', '⇉ ' + o.parallel + ' em paralelo', undefined, 'Quantas tarefas rodam ao mesmo tempo'),
      pill('osPVer', '', '🔍 Verificação' + (o.verify ? ' · ' + o.maxFix + ' corr.' : ' desligada'), o.verify, 'Outra IA confere cada tarefa'),
      pill('osPSkip', '', '🔓 Liberar comandos', o.skip, 'As IAs rodam comandos sem pedir permissão'),
      pill('osPBr', 'i-globe', 'Navegador', o.browser, 'Deixa as IAs usarem o navegador'),
      pill('osPCheap', '', '💸 Econômico', o.cheap, 'Cada IA usa o modelo mais barato (Haiku, Luna, Flash Low…) — ideal para testes'),
      pill('osPIso', '', '🌿 Isolar tarefas' + (o.isolate && o.autoApply ? ' · aplica sozinho' : ''), o.isolate, 'Cada tarefa roda num worktree git próprio; o resultado só entra no seu projeto quando você aplicar'),
      pill('osPLim', '', '🎯 Limite: ' + E(limTxt(o.maxTokens)), undefined, 'Máximo de tokens que a missão pode gastar antes de pausar'),
    ].join('');
    Q('#osWarn').textContent = o.skip
      ? '⚠️ Comandos liberados: as IAs instalam pacotes e rodam testes sem perguntar. Use em pastas de projeto.'
      : 'Sem liberar comandos: o que fica bloqueado depende de cada IA (o Codex no Windows roda sem sandbox mesmo assim).';
    Q('#osWarn').classList.toggle('on', !!o.skip);
    Q('#osPCwd').onclick = pickCwd;
    Q('#osPTeam').onclick = pickTeam;
    Q('#osPLead').onclick = pickLead;
    Q('#osPPar').onclick = () => pickNum('Tarefas em paralelo', [1, 2, 3, 4], o.parallel, (n) => { o.parallel = n; }, (n) => n === 1 ? 'Uma por vez (mais barato)' : n + ' tarefas ao mesmo tempo');
    Q('#osPVer').onclick = pickVerify;
    Q('#osPSkip').onclick = () => { o.skip = !o.skip; saveOpts(); renderPills(); };
    Q('#osPBr').onclick = () => { o.browser = !o.browser; saveOpts(); renderPills(); };
    Q('#osPCheap').onclick = () => { o.cheap = !o.cheap; saveOpts(); renderPills(); };
    Q('#osPIso').onclick = pickIsolate;
    Q('#osPLim').onclick = () => pickLimit('Limite de tokens da missão', o.maxTokens, 0, (n) => { o.maxTokens = n; saveOpts(); renderPills(); });
  }

  function pickIsolate() {
    const o = S.opts;
    const draw = (ov) => {
      Q('.sheet-b', ov).innerHTML = `
        <div class="engrow" style="padding:10px"><div class="tx"><b>🌿 Isolar tarefas</b><span>Cada IA trabalha num worktree git próprio (em .agentos/wt). O que for aprovado é juntado num branch de integração e só entra no seu projeto quando você clicar em “Aplicar no projeto”. Só vale em pastas com git e pelo menos 1 commit.</span></div>
          <label class="sw"><input type="checkbox" id="osIsoOn" ${o.isolate ? 'checked' : ''}><i></i></label></div>
        <div class="engrow" style="padding:10px"><div class="tx"><b>Aplicar automaticamente</b><span>Quando a missão terminar sem pendências, junta o resultado no seu branch atual sem perguntar.</span></div>
          <label class="sw"><input type="checkbox" id="osIsoAuto" ${o.autoApply ? 'checked' : ''} ${o.isolate ? '' : 'disabled'}><i></i></label></div>`;
      Q('#osIsoOn', ov).onchange = (e) => { o.isolate = e.target.checked; saveOpts(); renderPills(); draw(ov); };
      Q('#osIsoAuto', ov).onchange = (e) => { o.autoApply = e.target.checked; saveOpts(); renderPills(); draw(ov); };
    };
    sheet('Isolamento das tarefas', '', draw);
  }

  // presets de limite; `min` = uso atual (ao aumentar o limite de uma missão pausada)
  function pickLimit(title, cur, min, set) {
    const presets = [500e3, 1e6, 3e6, 5e6, 10e6, 20e6].filter((n) => n > min);
    if (min) presets.unshift(...[Math.ceil(min * 1.5 / 1e5) * 1e5, Math.ceil((min + 1e6) / 1e5) * 1e5].filter((n, i, a) => a.indexOf(n) === i && !presets.includes(n)));
    const html = `${min ? `<div class="os-note">Já foram usados <b>${E(tok(min))}</b> tokens. Escolha um limite maior para continuar.</div>` : '<div class="os-note">Soma os tokens de todas as conversas da missão (plano, tarefas, verificação e chat). Ao passar, a missão pausa e avisa você.</div>'}
      ${presets.sort((a, b) => a - b).map((n) => optBtn(`data-n="${n}"`, E(tok(n)) + ' tokens', '', n === cur, '🎯')).join('')}
      ${min ? '' : optBtn('data-n="0"', 'Sem limite', 'A missão nunca pausa por tokens', cur === 0, '∞')}
      <div class="ogh">Outro valor</div><div class="os-row" style="padding:0 10px 6px"><input id="osLimN" type="number" min="1" step="100000" placeholder="ex.: 2000000" class="mono"><button class="btn sm primary" id="osLimOk">Usar</button></div>`;
    sheet(title, html, (ov) => {
      QQ('[data-n]', ov).forEach((b) => b.onclick = () => { closeSheet(); set(+b.dataset.n); });
      const use = () => { const n = Math.round(+Q('#osLimN', ov).value); if (!(n > min)) return say(min ? 'Use um valor maior que ' + tok(min) : 'Valor inválido'); closeSheet(); set(n); };
      Q('#osLimOk', ov).onclick = use;
      Q('#osLimN', ov).onkeydown = (e) => { if (e.key === 'Enter') use(); };
    });
  }

  function optBtn(attrs, title, sub, on, icon) {
    return `<button class="opt ${on ? 'on' : ''}" ${attrs}><span class="oi">${icon || ''}</span><span class="ot"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span>${on ? '<span class="ck">✓</span>' : ''}</button>`;
  }

  function pickCwd() {
    const ws = (state.info && state.info.workspaces) || [];
    const html = `<div class="ogh">Pastas recentes</div>${ws.map((w, i) => optBtn(`data-w="${i}"`, E(baseName(w)), E(w), w === S.opts.cwd, '<svg><use href="#i-folder"/></svg>')).join('') || '<div class="empty" style="padding:20px">Nenhuma pasta salva</div>'}
      <div class="ogh">Outra pasta</div><div class="os-row" style="padding:0 10px 6px"><input id="osOther" placeholder="C:\\caminho\\da\\pasta" class="mono"><button class="btn sm primary" id="osOtherOk">Usar</button></div>`;
    sheet('Pasta do projeto', html, (ov) => {
      QQ('[data-w]', ov).forEach((b) => b.onclick = () => { S.opts.cwd = ws[+b.dataset.w]; saveOpts(); renderPills(); closeSheet(); });
      const use = async () => {
        const p = Q('#osOther', ov).value.trim(); if (!p) return;
        try { const d = await api('/api/workspaces/use', { method: 'POST', body: { path: p } }); if (state.info && d.workspaces) state.info.workspaces = d.workspaces; }
        catch (e) { return say(e.message); }
        S.opts.cwd = p; saveOpts(); renderPills(); closeSheet();
      };
      Q('#osOtherOk', ov).onclick = use;
      Q('#osOther', ov).onkeydown = (e) => { if (e.key === 'Enter') use(); };
    });
  }

  function pickTeam() {
    const all = (state.engines || []).filter((e) => e.installed);
    const draw = (ov) => {
      Q('#osTeamL', ov).innerHTML = all.map((e) => {
        const on = S.opts.engines.includes(e.id), off = !e.enabled;
        return `<button class="opt ${on ? 'on' : ''}" data-e="${e.id}" ${off ? 'disabled style="opacity:.5"' : ''}><span class="oi">${engDot(e.id)}</span><span class="ot"><b>${E(engName(e.id))}${off ? ' · desligada nos Ajustes' : ''}</b><span>${E(S.strengths[e.id] || '')}</span></span>${on ? '<span class="ck">✓</span>' : ''}</button>`;
      }).join('') || '<div class="empty" style="padding:20px">Nenhuma IA instalada</div>';
      QQ('[data-e]', ov).forEach((b) => b.onclick = () => {
        const id = b.dataset.e, list = S.opts.engines;
        if (list.includes(id)) { if (list.length === 1) return say('A equipe precisa de pelo menos uma IA.'); S.opts.engines = list.filter((x) => x !== id); }
        else S.opts.engines = [...list, id];
        fixOpts(); saveOpts(); renderPills(); draw(ov);
      });
    };
    sheet('Equipe da missão', `<div class="os-note">Escolha quais IAs podem receber tarefas. O Arquiteto distribui pela especialidade de cada uma.</div><div id="osTeamL"></div>`, draw);
  }

  function pickLead() {
    sheet('IA líder (Arquiteto)', `<div class="os-note">Planeja as tarefas no começo e faz a integração e o relatório no fim.</div>` +
      S.opts.engines.map((id) => optBtn(`data-e="${id}"`, E(engName(id)), E(S.strengths[id] || ''), id === S.opts.lead, engDot(id))).join(''), (ov) => {
      QQ('[data-e]', ov).forEach((b) => b.onclick = () => { S.opts.lead = b.dataset.e; saveOpts(); renderPills(); closeSheet(); });
    });
  }

  function pickNum(title, nums, cur, set, sub) {
    sheet(title, nums.map((n) => optBtn(`data-n="${n}"`, String(n), sub(n), n === cur, `<b>${n}</b>`)).join(''), (ov) => {
      QQ('[data-n]', ov).forEach((b) => b.onclick = () => { set(+b.dataset.n); saveOpts(); renderPills(); closeSheet(); });
    });
  }

  function pickVerify() {
    const o = S.opts;
    const draw = (ov) => {
      Q('.sheet-b', ov).innerHTML = `
        <div class="engrow" style="padding:10px"><div class="tx"><b>Verificação cruzada</b><span>Uma IA diferente confere os critérios de aceite de cada tarefa e roda os testes.</span></div>
          <label class="sw"><input type="checkbox" id="osVOn" ${o.verify ? 'checked' : ''}><i></i></label></div>
        <div class="ogh">Correções permitidas por tarefa</div>
        <div class="os-row" style="padding:0 10px 10px">${[0, 1, 2, 3, 4].map((n) => `<button class="chip toggle ${o.maxFix === n ? 'on' : ''}" data-n="${n}" ${o.verify ? '' : 'disabled'}>${n}</button>`).join('')}</div>
        <div class="os-note">Se o verificador reprovar, a mesma IA corrige até esse número de vezes.</div>`;
      Q('#osVOn', ov).onchange = (e) => { o.verify = e.target.checked; saveOpts(); renderPills(); draw(ov); };
      QQ('[data-n]', ov).forEach((b) => b.onclick = () => { o.maxFix = +b.dataset.n; saveOpts(); renderPills(); draw(ov); });
    };
    sheet('Verificação', '', draw);
  }

  async function launch() {
    const ta = Q('#osGoal');
    const goal = ta.value.trim();
    if (!goal) { ta.focus(); return say('Diga o que o Agente OS deve fazer.'); }
    if (S.busy) return;
    fixOpts();
    if (!S.opts.cwd) return say('Escolha a pasta do projeto.');
    S.busy = true; Q('#osGo').disabled = true;
    try {
      const o = S.opts;
      const d = await api('/api/missions', { method: 'POST', body: { goal, cwd: o.cwd, engines: o.engines, lead: o.lead, parallel: o.parallel,
        verify: o.verify, maxFix: o.maxFix, mode: 'edit', skip: o.skip, browser: o.browser, cheap: o.cheap, approve: o.approve, isolate: !!o.isolate, autoApply: !!(o.isolate && o.autoApply), maxTokens: o.maxTokens, device: typeof device === 'string' ? device : undefined } });
      ta.value = ''; ls.set('draft', ''); ta.style.height = '';
      say('🧠 Missão criada. O Arquiteto está planejando…');
      S.mission = d.mission; select(d.id);
      loadList();
    } catch (e) { say(e.message); }
    finally { S.busy = false; Q('#osGo').disabled = false; }
  }

  // ------------------------------------------------------------------ lista / tabela
  async function loadList() {
    S.listAt = Date.now();
    try {
      const d = await api('/api/missions');
      S.missions = d.missions || []; S.strengths = d.strengths || S.strengths; S.loaded = true;
    } catch { return; }
    renderPip(); renderFloat();
    if (S.built) {
      const sig = usable().join(',') + '|' + ((state.info && state.info.workspaces) || []).length;
      if (sig !== S.engSig) { S.engSig = sig; renderPills(); }
      renderList(); renderTeam();
    }
    if (S.built && !S.sel && Date.now() - S.statsAt > 15000) loadStats();
  }

  function renderPip() {
    const wait = S.missions.some((m) => m.state === 'aguardando');
    QQ('.nav[data-view="os"] .pip').forEach((p) => { p.hidden = !wait; p.title = wait ? 'Missão aguardando sua aprovação' : ''; });
  }

  function renderList() {
    const run = S.missions.filter((m) => ACTIVE.includes(m.state)).length;
    const need = S.missions.filter((m) => NEED.includes(m.state)).length;
    patch(Q('#osSub'), !S.loaded ? 'Carregando missões…' : [run ? `<b class="s-run">${run} rodando</b>` : '0 rodando', need ? `<b class="s-need">${need} precisa${need > 1 ? 'm' : ''} de você</b>` : '', `${S.missions.length} miss${S.missions.length === 1 ? 'ão' : 'ões'}`].filter(Boolean).join(' • '));
    const counts = FILTERS.map(([, , f]) => S.missions.filter(f).length);
    patch(Q('#osTabs'), FILTERS.map(([k, t], i) => `<button class="${S.filter === k ? 'on' : ''} ${k === 'eu' && counts[i] ? 'needy' : ''}" data-f="${k}">${t}<span class="n">${counts[i]}</span></button>`).join(''));
    QQ('#osTabs [data-f]').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; renderList(); });
    Q('#osFilt').classList.toggle('on', !!S.fEng);
    if (S.loaded && !S.missions.length) { patch(Q('#osTable'), emptyHtml()); bindEmpty(); return; }
    const f = (FILTERS.find(([k]) => k === S.filter) || FILTERS[0])[2];
    const list = S.missions.filter(f).filter((m) => (!S.fEng || (m.engines || []).includes(S.fEng)) &&
      (!S.q || (m.title + ' ' + m.goal + ' ' + m.cwd).toLowerCase().includes(S.q)));
    const rows = list.map((m) => {
      const [stT, stC] = M_ST[m.state] || [m.state, 'off'];
      const pct = m.total ? Math.round(m.done / m.total * 100) : 0;
      return `<div class="os-tr" role="row" tabindex="0" data-m="${m.id}">
        <div class="c-m"><b>${E(m.title)}</b><span>📁 ${E(baseName(m.cwd))}${m.finishedAt ? ' · ' + dur(m.finishedAt - m.createdAt) : ''}${m.tokensUsed ? ' · 🎯 ' + E(tok(m.tokensUsed)) : ''}${m.automationId ? ' · ⏰' : ''}</span></div>
        <div class="c-s"><span class="os-st s-${stC}"><i></i>${E(stT)}</span>${needChip(m)}${m.gitStatus === 'pronta' ? '<span class="os-need os-ready" title="Resultado isolado esperando você aplicar">🌿 Aplicar</span>' : ''}</div>
        <div class="c-e">${(m.engines || []).map((e) => engChip(e)).join('') || '<span class="muted">—</span>'}</div>
        <div class="c-p"><div class="os-prog ${m.failed ? 'has-f' : ''}"><i style="width:${pct}%"></i></div><span class="num">${pct}%</span><span class="num muted">${m.done}/${m.total || 0}</span></div>
        <div class="c-t">${when(m.updatedAt)}</div>
        <div class="c-x"><button class="os-ib" data-menu="${m.id}" aria-label="Mais ações">${IC.dots}</button></div>
      </div>`;
    }).join('');
    patch(Q('#osTable'), `<div class="os-table" role="table">
      <div class="os-tr os-th" role="row"><div class="c-m">Missão</div><div class="c-s">Estado</div><div class="c-e">Equipe</div><div class="c-p">Progresso</div><div class="c-t">Última atividade</div><div class="c-x"></div></div>
      ${rows || `<div class="os-empty">${S.loaded ? 'Nenhuma missão neste filtro.' : 'Carregando…'}</div>`}</div>`);
    QQ('#osTable [data-m]').forEach((r) => {
      r.onclick = (e) => { if (e.target.closest('[data-menu]')) return; select(r.dataset.m); };
      r.onkeydown = (e) => { if (e.key === 'Enter') select(r.dataset.m); };
    });
    QQ('#osTable [data-menu]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); rowMenu(b.dataset.menu); });
  }

  function emptyHtml() {
    const cards = Object.keys(ENG).map((id) => `<div class="os-cc ${ecls(id)}"><div class="os-av">${E(engShort(id)[0])}</div><b>${E(engShort(id))}</b><span>${E(ENG[id].role)}</span><div class="os-cc-l"><i></i><i></i><i></i></div></div>`);
    return `<div class="os-emptyhero"><div class="os-car" id="osCar">${cards.join('')}</div>
      <h2>Monte sua força de trabalho de IA</h2>
      <p>Descreva um objetivo e o Agente OS divide em tarefas, distribui entre Claude, Codex, Antigravity e OpenCode, verifica cada entrega e te entrega um relatório.</p>
      <button class="os-cta" data-a="newm"><span>+</span> Nova missão</button></div>`;
  }
  function bindEmpty() {
    const b = Q('#osTable [data-a="newm"]'); if (b) b.onclick = () => newMission();
    paintCarousel();
  }
  function paintCarousel() {
    const cs = QQ('#osCar .os-cc'); if (!cs.length) return;
    const n = cs.length;
    cs.forEach((c, i) => { const d = ((i - S.carousel) % n + n) % n; c.dataset.pos = d === 0 ? 'c' : d === 1 ? 'r' : d === n - 1 ? 'l' : 'h'; });
  }

  function pickFilter() {
    const engs = Object.keys(ENG);
    sheet('Filtrar missões', `<div class="ogh">Por IA envolvida</div>` + optBtn('data-fe=""', 'Todas as IAs', '', !S.fEng, '★') +
      engs.map((id) => optBtn(`data-fe="${id}"`, E(engName(id)), '', S.fEng === id, engDot(id))).join(''), (ov) => {
      QQ('[data-fe]', ov).forEach((b) => b.onclick = () => { S.fEng = b.dataset.fe; renderList(); closeSheet(); });
    });
  }

  function rowMenu(id) {
    const m = S.missions.find((x) => x.id === id); if (!m) return;
    const active = ACTIVE.includes(m.state);
    const items = [optBtn('data-r="open"', 'Abrir missão', E(m.title), false, '↗')];
    if (active || m.state === 'aguardando' || m.state === 'pausado_limite') items.push(optBtn('data-r="cancel"', 'Cancelar', 'Interrompe as IAs desta missão', false, '⏹'));
    if (m.state === 'interrompido') items.push(optBtn('data-r="resume"', 'Retomar', 'Continua de onde parou', false, '▶'));
    if (!active) items.push(optBtn('data-r="del"', 'Apagar', 'Tira da lista (arquivos e conversas ficam)', false, '🗑'));
    sheet('Missão', items.join(''), (ov) => {
      QQ('[data-r]', ov).forEach((b) => b.onclick = async () => {
        closeSheet();
        const r = b.dataset.r;
        if (r === 'open') return select(id);
        if (r === 'del') return delConfirm(m);
        if (r === 'cancel') return confirmSheet('Cancelar missão?', 'As IAs que estão trabalhando serão interrompidas.', '⏹ Cancelar missão', () => act('/cancel', null, 'Missão cancelada', id));
        if (r === 'resume') return act('/resume', {}, 'Retomando a missão', id);
      });
    });
  }

  // ------------------------------------------------------------------ equipe (cards por IA)
  async function loadStats() {
    S.statsAt = Date.now();
    for (const m of S.missions.slice(0, 25)) {
      const c = S.cache[m.id];
      if (c && c.updatedAt === m.updatedAt) continue;
      try { const d = await api('/api/missions/' + m.id); S.cache[m.id] = { updatedAt: m.updatedAt, tasks: d.mission.tasks.map((t) => ({ engine: t.engineUsed || t.engine, status: t.status, fixes: t.fixes, verdict: t.verdict ? { pass: t.verdict.pass } : null, ts: t.finishedAt || t.startedAt || 0 })) }; }
      catch {}
    }
    for (const id of Object.keys(S.cache)) if (!S.missions.some((m) => m.id === id)) delete S.cache[id];
    renderTeam();
  }

  function engStats(id) {
    let done = 0, verified = 0, first = 0, last = 0;
    for (const c of Object.values(S.cache)) for (const t of c.tasks) {
      if (t.engine !== id) continue;
      if (t.status === 'ok') done++;
      if (t.verdict) { verified++; if (t.status === 'ok' && !t.fixes) first++; }
      if (t.ts > last) last = t.ts;
    }
    return { done, rate: verified ? Math.round(first / verified * 100) + '%' : '—', last };
  }

  function quotaText(e) {
    try {
      if (typeof quotaLeft === 'function') { const q = quotaLeft(e.id, e.defaultModel); if (q && q.remaining_fraction != null) return 'cota ' + Math.round(q.remaining_fraction * 100) + '%'; }
    } catch {}
    const q = e.quota;
    if (q && q.utilization != null) return 'cota ' + Math.max(0, Math.round(100 - q.utilization * (q.utilization <= 1 ? 100 : 1))) + '%';
    if (q && q.status) return 'cota: ' + (q.status === 'allowed' ? 'ok' : q.status);
    return 'cota —';
  }

  function renderTeam() {
    const el = Q('#osTeam'); if (!el) return;
    const engs = (state.engines || []).length ? state.engines : Object.keys(ENG).map((id) => ({ id, name: ENG[id].name, installed: true, enabled: true }));
    patch(el, engs.map((e) => {
      const herr = e.health && e.health.error ? String(e.health.error).replace(/\u001b\[[0-9;]*m/g, '') : '';
      const st = !e.installed ? ['off', 'Não instalada'] : e.health && e.health.ok === false ? ['err', 'Precisa de atenção'] : !e.enabled ? ['off', 'Desligada'] : ['ok', 'Ativa'];
      const s = engStats(e.id);
      const testing = S.testing[e.id];
      return `<div class="os-ac ${ecls(e.id)} ${!e.installed || !e.enabled ? 'dim' : ''}">
        <div class="os-ac-h"><div class="os-av">${E(engShort(e.id)[0])}</div>
          <div class="os-ac-n"><b>${E(engName(e.id))}</b><span class="os-st s-${st[0]}"><i></i>${st[1]}</span></div></div>
        <p class="os-ac-d" title="${E(S.strengths[e.id] || '')}">${E(S.strengths[e.id] || ENG[e.id] && ENG[e.id].role || '')}</p>
        <div class="os-ac-meta"><span title="Modelo padrão">◆ ${E(e.defaultModel || 'modelo padrão')}</span><span>${E(quotaText(e))}</span></div>
        ${e.health && e.health.ok === false && herr ? `<div class="os-ac-err" title="${E(herr)}">${E(herr.slice(0, 90))}</div>` : ''}
        <div class="os-ac-n3"><div><b class="num">${s.done}</b><span>feitas</span></div><div><b class="num">${s.rate}</b><span title="Aprovadas na 1ª verificação">aprovação</span></div><div><b>${s.last ? when(s.last) : '—'}</b><span>último uso</span></div></div>
        <div class="os-ac-b"><button class="btn sm" data-test="${e.id}" ${!e.installed || testing ? 'disabled' : ''}>${testing ? '<span class="spin"></span> Testando…' : 'Testar'}</button><button class="btn sm" data-cfg="${e.id}">Configurar</button></div>
      </div>`;
    }).join(''));
    QQ('[data-test]', el).forEach((b) => b.onclick = () => testEngine(b.dataset.test));
    QQ('[data-cfg]', el).forEach((b) => b.onclick = () => go('settings'));
  }

  async function testEngine(id) {
    S.testing[id] = true; renderTeam();
    try {
      const r = await api(`/api/engines/${id}/test`, { method: 'POST' });
      say(r.ok ? `✅ ${engName(id)} respondeu em ${String((r.seconds || 0).toFixed(1)).replace('.', ',')} s` : `❌ ${engName(id)}: ${r.error || 'falhou'}`);
    } catch (e) { say(e.message); }
    delete S.testing[id];
    try { const d = await api('/api/engines'); state.engines = d.engines || state.engines; } catch {}
    renderTeam();
  }

  // ------------------------------------------------------------------ seleção
  function select(id) {
    S.sel = id; ls.set('sel', id);
    if (!id || (S.mission && S.mission.id !== id)) S.mission = null;
    S.panel = null;
    const root = Q('#osRoot');
    root.classList.toggle('detail', !!id);
    Q('#osHomeP').hidden = !!id; Q('#osDetP').hidden = !id;
    setPanel(null, true);
    QQ('#osDetail [data-sec]').forEach((s) => { s.innerHTML = ''; s._h = null; });
    if (id) {
      const sm = S.missions.find((x) => x.id === id) || (S.mission && S.mission.id === id ? S.mission : null);
      setTab(!sm || ACTIVE.includes(sm.state) || sm.state === 'aguardando' ? 'chat' : 'ov', true);
      if (DC) DC.set(id);
      const mo = Q('#osMore'); mo.value = ls.get('more.' + id, '');
      Q('#osDetP').scrollTop = 0;
      if (S.mission) renderDetail();
      loadDetail();
    } else { renderList(); }
  }

  async function loadDetail() {
    const id = S.sel; if (!id) return;
    S.detAt = Date.now();
    try {
      const d = await api('/api/missions/' + id);
      if (S.sel !== id) return;
      S.mission = d.mission; renderDetail();
    } catch (e) {
      if (S.sel !== id) return;
      if (/não encontrada|404/i.test(e.message)) { say('Missão não encontrada.'); select(null); loadList(); }
    }
  }

  // ------------------------------------------------------------------ detalhe
  function buildDetail() {
    const el = Q('#osDetail');
    el.innerHTML = `
      <div class="os-crumb"><button class="os-back" id="osBack">${IC.back}<span>Missões</span></button><span style="flex:1"></span>
        <div class="seg os-dtabs" id="osDTabs"><button data-t="chat">💬 Chat</button><button data-t="ov">📊 Visão geral</button></div></div>
      <div class="os-dh" data-sec="head"></div>
      <div class="os-actions" data-sec="acts"></div>
      <div data-sec="approve"></div>
      <div data-sec="git"></div>
      <div class="os-chatwrap" id="osChatTab" hidden></div>
      <div id="osOv">
      <div class="os-block os-flow">
        <div class="os-bh"><h3>Fluxo de tarefas</h3><span class="muted num" data-sec="tcount"></span><span style="flex:1"></span>
          <div class="seg" id="osViewSeg" style="margin:0"><button data-v="grafo">Grafo</button><button data-v="quadro">Quadro</button></div></div>
        <div data-sec="tasks"></div>
        <div class="os-stats" data-sec="stats"></div>
      </div>
      <div data-sec="report"></div>
      <div data-sec="plan"></div>
      <div class="os-two">
        <div class="os-block"><div class="os-bh"><h3>Linha do tempo</h3><span class="os-live" data-sec="live"></span></div><div class="os-log" data-sec="log"></div></div>
        <div class="os-block os-more"><div class="os-bh"><h3>Pedir mais</h3></div>
          <textarea id="osMore" rows="3" placeholder="Continue a missão: “agora adicione modo escuro”, “corrija o teste que falhou”…"></textarea>
          <div class="os-row" style="justify-content:space-between;margin-top:8px"><span class="muted" style="font-size:12.5px" data-sec="morehint"></span><button class="btn sm primary" id="osMoreGo">Enviar pedido</button></div>
        </div>
      </div>
      </div>`;
    QQ('#osDTabs button').forEach((b) => b.onclick = () => setTab(b.dataset.t));
    DC = makeChat(Q('#osChatTab'), { getMission: () => S.mission, isVisible: () => visible() && !!S.sel && S.tab === 'chat' });
    Q('#osBack').onclick = () => select(null);
    const mo = Q('#osMore');
    mo.oninput = () => ls.set('more.' + S.sel, mo.value);
    mo.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMore(); } };
    Q('#osMoreGo').onclick = sendMore;
    QQ('#osViewSeg button').forEach((b) => b.onclick = () => { S.view = b.dataset.v; ls.set('board', S.view); renderDetail(); });
    el.onclick = onDetailClick;
    el.onchange = onDetailChange;
  }

  const sec = (k) => Q(`#osDetail [data-sec="${k}"]`);

  function renderDetail() {
    const m = S.mission; if (!m || m.id !== S.sel || !sec('head')) return;
    const active = ACTIVE.includes(m.state);
    const done = m.tasks.filter((x) => x.status === 'ok').length;
    const o = m.options || {};
    patch(sec('head'), `
      <div class="os-dh-meta">${stBadge(M_ST, m.state)}${needChip(m)}<span class="muted">criada ${when(m.createdAt)}</span></div>
      <h2>${E(m.goal.length <= 140 ? m.goal : m.title)}</h2>
      ${m.goal.length > 140 ? `<p class="os-goal">${E(m.goal)}</p>` : ''}
      ${(m.followUps || []).map((f) => `<p class="os-goal os-fu">💬 ${E(f.text)}</p>`).join('')}
      <div class="os-dh-tags"><span class="badge" title="${E(m.cwd)}">📁 <b>${E(baseName(m.cwd))}</b></span>
        <span class="badge">🧭 Líder ${engChip(o.lead)}</span>
        <span class="badge">Equipe ${(o.engines || []).map(engDot).join('')}</span>
        <span class="badge">⇉ ${o.parallel || 1} em paralelo</span>
        <span class="badge">${o.verify ? '🔍 verificação · ' + o.maxFix + ' corr.' : 'sem verificação'}</span>
        ${o.skip ? '<span class="badge">🔓 comandos liberados</span>' : ''}${o.browser ? '<span class="badge">🌐 navegador</span>' : ''}${o.cheap ? '<span class="badge">💸 econômico</span>' : ''}${o.isolate ? '<span class="badge" title="Cada tarefa num worktree git próprio">🌿 isolada</span>' : ''}${tokBar(m.tokensUsed, m.maxTokens)}</div>
      ${m.error && m.state === 'erro' ? `<div class="os-err">⚠️ ${E(m.error)}</div>` : ''}`);

    const retryable = m.tasks.some((x) => ['falhou', 'bloqueada', 'cancelada'].includes(x.status));
    const btns = [];
    const paused = m.state === 'pausado_limite';
    if (paused) btns.push(`<button class="btn sm primary" data-a="limit">🎯 Aumentar limite</button>`);
    if (active || paused || m.state === 'aguardando') btns.push(`<button class="btn sm" data-a="cancel">⏹ Cancelar</button>`);
    if (m.state === 'interrompido' && m.tasks.length) btns.push(`<button class="btn sm primary" data-a="resume">▶️ Retomar</button>`);
    if (!active && !paused && m.state !== 'aguardando' && retryable) btns.push(`<button class="btn sm ${m.state === 'interrompido' ? '' : 'primary'}" data-a="resumeAll">🔁 Refazer o que falhou</button>`);
    btns.push(`<button class="btn sm" data-a="arch" ${m.planConvId ? '' : 'disabled'}>🧭 Conversa do Arquiteto</button>`);
    btns.push(`<button class="btn sm" data-a="files">📂 Arquivos</button>`);
    if (!active && !m.looping) btns.push(`<button class="btn sm os-danger" data-a="del">🗑 Apagar</button>`);
    patch(sec('acts'), btns.join(''));

    patch(sec('approve'), m.state === 'aguardando' ? approveHtml(m) : paused ? limitHtml(m) : '');
    patch(sec('git'), m.git ? gitHtml(m) : '');
    patch(sec('report'), m.report ? reportHtml(m) : '');

    const p = m.plan || {};
    patch(sec('plan'), (p.summary || p.architecture || p.testCommand) ? `<div class="os-block os-plan">
      <div class="os-bh"><h3>Plano do Arquiteto</h3></div>
      ${p.summary ? `<p>${E(p.summary)}</p>` : ''}
      ${p.architecture ? `<details class="os-det" data-card="${m.id}:arch" ${S.openCards.has(m.id + ':arch') ? 'open' : ''}><summary>Arquitetura e decisões</summary><div class="os-pre">${E(p.architecture)}</div></details>` : ''}
      ${p.testCommand ? `<div class="os-kv"><span>Como testar</span><code class="mono">${E(p.testCommand)}</code></div>` : ''}
      <div class="os-kv"><span>Quadro</span><code class="mono" title="${E(m.board || '')}">${E(m.board || m.dir || '')}</code></div>
    </div>` : '');

    // tarefas
    const view = isMobile() ? (S.view === 'quadro' ? 'quadro' : 'camadas') : (S.view === 'quadro' ? 'quadro' : 'grafo');
    QQ('#osViewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === (view === 'camadas' ? 'grafo' : view)));
    patch(sec('tcount'), m.tasks.length ? `${done}/${m.tasks.length} aprovadas` : '');
    patch(sec('tasks'), !m.tasks.length
      ? (m.state === 'planejando' ? `<div class="os-planning"><span class="spin"></span><div><b>O Arquiteto está analisando a pasta e montando o plano…</b><span>Costuma levar de 30 s a 2 min. As tarefas aparecem aqui.</span></div><button class="btn sm" data-a="arch">Ver ao vivo</button></div>` : '<div class="os-empty">Nenhuma tarefa.</div>')
      : view === 'grafo' ? graphHtml(m) : view === 'quadro' ? kanbanHtml(m) : layersHtml(m));

    // stats
    const verified = m.tasks.filter((t) => t.verdict);
    const rate = verified.length ? Math.round(verified.filter((t) => t.verdict.pass).length / verified.length * 100) + '%' : '—';
    const fixes = m.tasks.reduce((a, t) => a + (t.fixes || 0), 0);
    const stat = (ic, l, v) => `<div class="os-stat"><span class="os-stat-i">${ic}</span><div><span>${l}</span><b class="num">${v}</b></div></div>`;
    patch(sec('stats'), stat(IC.cal, 'Início', dt(m.createdAt)) + stat(IC.check, 'Taxa de aprovação', rate) + stat(IC.clock, 'Duração', dur(mElapsed(m))) +
      stat(IC.list, 'Tarefas', `${done}/${m.tasks.length}`) + stat(IC.wrench, 'Correções', fixes));

    // log
    const logEl = sec('log');
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    patch(logEl, (m.log || []).slice(-200).map((l) => `<div class="os-li"><span class="ts num">${hhmm(l.ts)}</span>${l.taskId ? `<button class="tid" data-node="${E(l.taskId)}">${E(l.taskId)}</button>` : ''}${l.engine ? engDot(l.engine) : ''}<span class="tx">${E(l.text)}</span></div>`).join('') || '<div class="os-empty">Sem eventos ainda.</div>');
    if (nearBottom || !logEl._seen) { logEl.scrollTop = logEl.scrollHeight; logEl._seen = true; }
    patch(sec('live'), active ? '<span class="os-dot s-run"></span>ao vivo' : '');

    const canMore = !active && m.state !== 'aguardando';
    Q('#osMoreGo').disabled = !canMore;
    patch(sec('morehint'), canMore ? 'O Arquiteto planeja novas tarefas usando o que já foi feito.' : m.state === 'aguardando' ? 'Aprove ou cancele o plano primeiro.' : 'Disponível quando a etapa atual terminar.');

    renderPanel();
    if (DC && S.tab === 'chat') DC.renderSteps();
  }

  function setTab(t, silent) {
    S.tab = t === 'ov' ? 'ov' : 'chat';
    QQ('#osDTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab));
    if (Q('#osChatTab')) { Q('#osChatTab').hidden = S.tab !== 'chat'; Q('#osOv').hidden = S.tab !== 'ov'; }
    if (!silent && S.tab === 'chat' && DC) { DC.poll(); DC.toBottom(); }
    renderFloat();
  }

  function approveHtml(m) {
    const ed = S.approve[m.id] || (S.approve[m.id] = {});
    const engs = (m.options && m.options.engines) || [];
    const rows = m.tasks.filter((t) => t.status === 'pendente').map((t) => {
      const e = ed[t.id] || {};
      const cur = e.engine || t.engine;
      return `<div class="os-ap ${e.remove ? 'rm' : ''}">
        <div class="os-ap-t"><span class="tid">${E(t.id)}</span><b>${E(t.title)}</b>${t.deps.length ? `<span class="muted">depende de ${E(t.deps.join(', '))}</span>` : ''}</div>
        <div class="os-ap-c"><span class="os-sel ${ecls(cur)}"><i></i><select data-ap-eng="${t.id}" aria-label="IA da tarefa ${E(t.id)}">${engs.map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${E(engShort(x))}</option>`).join('')}</select></span>
          <label class="os-rm"><input type="checkbox" data-ap-rm="${t.id}" ${e.remove ? 'checked' : ''}> remover</label></div>
      </div>`;
    }).join('');
    return `<div class="os-block os-approve"><div class="os-bh"><h3>⏸ Plano pronto — aprove para começar</h3></div>
      <p class="muted" style="margin:0 0 10px">Revise as tarefas. Você pode trocar a IA de cada uma ou remover o que não quer. Tarefas que dependem de uma removida ficam bloqueadas.</p>
      ${rows}<div class="btns"><button class="btn primary os-pbtn" data-a="approve">▶️ Aprovar e executar</button><button class="btn" data-a="cancel">Cancelar missão</button></div></div>`;
  }

  function limitHtml(m) {
    return `<div class="os-block os-limit"><div class="os-bh"><h3>🎯 Pausada: limite de tokens</h3></div>
      <p class="muted" style="margin:0 0 10px">A missão já usou <b>${E(tok(m.tokensUsed))}</b> de <b>${E(limTxt(m.maxTokens))}</b> tokens. Nenhuma tarefa nova começa${m.looping ? ' (as que estavam rodando estão terminando)' : ''}. Aumente o limite para continuar de onde parou.</p>
      <div class="btns"><button class="btn primary" data-a="limit">🎯 Aumentar limite e continuar</button><button class="btn" data-a="cancel">Cancelar missão</button></div></div>`;
  }

  const GIT_ST = { ativo: ['Em andamento', 'run'], pronta: ['Pronta para aplicar', 'need'], aplicada: ['Aplicada', 'ok'], descartada: ['Descartada', 'off'], cancelada: ['Cancelada', 'off'] };
  function gitHtml(m) {
    const g = m.git;
    const [stT, stC] = GIT_ST[g.status] || [g.status, 'off'];
    const busy = ACTIVE.includes(m.state) || m.looping;
    const rows = m.tasks.filter((t) => t.branch).map((t) => `<div class="os-gitrow"><span class="tid">${E(t.id)}</span><code class="mono" title="${E(t.worktree || '')}">${E(t.branch)}</code>
      <span class="${t.mergedAt ? 's-ok' : ['falhou', 'cancelada'].includes(t.status) ? 's-err' : 's-off'} os-gitm">${t.mergedAt ? '✓ juntada' : t.status === 'falhou' ? '✗ não juntada' : BUSY_T.includes(t.status) ? '… trabalhando' : '—'}</span></div>`).join('');
    const btns = [];
    if (g.status === 'pronta') btns.push('<button class="btn primary" data-a="apply">✅ Aplicar no projeto</button>');
    if (!['aplicada', 'descartada'].includes(g.status) && !busy) btns.push(`<button class="btn os-danger" data-a="discard">🗑 ${g.status === 'cancelada' ? 'Apagar branches' : 'Descartar resultado'}</button>`);
    const msg = g.status === 'pronta' ? `O trabalho aprovado está no branch <code class="mono">${E(g.branch)}</code>. Sua pasta${g.startBranch ? ` (branch <b>${E(g.startBranch)}</b>)` : ''} ainda não mudou.`
      : g.status === 'aplicada' ? `Aplicado em <b>${E(g.appliedTo || '')}</b> por ${g.method === 'fast-forward' ? 'fast-forward' : 'merge'} ${when(g.appliedAt)}. Worktrees e branches temporários removidos.`
      : g.status === 'descartada' ? 'Resultado descartado: worktrees e branches removidos. Sua pasta não foi alterada.'
      : g.status === 'cancelada' ? `Missão cancelada. Os worktrees foram removidos; os branches <code class="mono">${E(g.branch)}…</code> continuam até você apagar.`
      : `Cada tarefa trabalha num worktree próprio e o que é aprovado é juntado em <code class="mono">${E(g.branch)}</code>.`;
    return `<div class="os-block os-git ${g.status === 'pronta' ? 'ready' : ''}">
      <div class="os-bh"><h3>🌿 Resultado isolado</h3><span class="os-st s-${stC}"><i></i>${E(stT)}</span></div>
      <p class="os-gitp">${msg}${g.baseKind === 'stash' && !['aplicada', 'descartada'].includes(g.status) ? ' <span class="muted">(partiu das suas mudanças não commitadas)</span>' : ''}</p>
      ${rows && !['aplicada', 'descartada'].includes(g.status) ? `<details class="os-det" data-card="${m.id}:git" ${S.openCards.has(m.id + ':git') ? 'open' : ''}><summary>Branches das tarefas</summary><div class="os-gitlist">${rows}</div></details>` : ''}
      ${btns.length ? `<div class="btns">${btns.join('')}</div>` : ''}</div>`;
  }

  function reportHtml(m) {
    const r = m.report;
    const list = (a) => `<ul>${a.map((x) => `<li>${E(x)}</li>`).join('')}</ul>`;
    return `<div class="os-block os-report ${r.pass ? 'pass' : 'warn'}">
      <div class="os-bh"><h3>${r.pass ? '✅ Missão entregue e verificada' : '⚠️ Missão terminou com pendências'}</h3></div>
      ${r.summary ? `<p class="os-rsum">${E(r.summary)}</p>` : ''}
      <div class="os-rgrid">
        ${r.howToRun ? `<div><h4>Como rodar</h4><div class="os-pre mono">${E(r.howToRun)}</div></div>` : ''}
        ${r.tests ? `<div><h4>Testes</h4><div class="os-pre">${E(r.tests)}</div></div>` : ''}
        ${r.issues && r.issues.length ? `<div><h4>Pendências</h4>${list(r.issues)}</div>` : ''}
        ${r.next && r.next.length ? `<div><h4>Próximos passos</h4>${list(r.next)}</div>` : ''}
      </div>
      ${r.text ? `<details class="os-det" data-card="${m.id}:rep" ${S.openCards.has(m.id + ':rep') ? 'open' : ''}><summary>Relatório completo do Arquiteto</summary><div class="body os-md">${mdx(r.text)}</div></details>` : ''}
    </div>`;
  }

  // ---- nós / grafo
  function nodeHtml(m, t, style) {
    const [stT, stC] = T_ST[t.status] || [t.status, 'off'];
    const mark = t.status === 'ok' ? '<span class="os-mk ok">✓</span>' : ['falhou', 'bloqueada'].includes(t.status) ? '<span class="os-mk err">✗</span>' : BUSY_T.includes(t.status) ? '<span class="os-mk run"></span>' : '';
    return `<button class="os-node ${ecls(t.engine)} t-${t.status} ${S.panel === t.id ? 'sel' : ''}" data-node="${t.id}" ${style ? `style="${style}"` : ''}>
      <div class="os-node-h"><span class="tid">${E(t.id)}</span>${t.fixes ? `<span class="os-fx">🔧${t.fixes}</span>` : ''}<span style="flex:1"></span>${mark}</div>
      <div class="os-node-t">${E(t.title)}</div>
      <div class="os-node-f">${engChip(t.engine)}<span class="os-st s-${stC}"><i></i>${E(stT)}</span></div>
    </button>`;
  }

  function depthOf(m) {
    const depth = {}; const byId = Object.fromEntries(m.tasks.map((t) => [t.id, t]));
    const dfs = (t, seen) => {
      if (depth[t.id] != null) return depth[t.id];
      if (seen.has(t.id)) return 0;
      seen.add(t.id);
      return (depth[t.id] = t.deps.map((x) => byId[x]).filter(Boolean).reduce((a, x) => Math.max(a, dfs(x, seen) + 1), 0));
    };
    m.tasks.forEach((t) => dfs(t, new Set()));
    const layers = [];
    for (const t of m.tasks) (layers[depth[t.id]] = layers[depth[t.id]] || []).push(t);
    return layers.filter(Boolean);
  }

  function graphHtml(m) {
    const NW = 236, NH = 108, GX = 72, GY = 20, P = 28;
    const layers = depthOf(m);
    const rows = Math.max(...layers.map((l) => l.length));
    const W = P * 2 + layers.length * NW + (layers.length - 1) * GX;
    const H = P * 2 + rows * NH + (rows - 1) * GY;
    const pos = {};
    layers.forEach((l, i) => {
      const off = (H - (l.length * NH + (l.length - 1) * GY)) / 2;
      l.forEach((t, j) => { pos[t.id] = { x: P + i * (NW + GX), y: off + j * (NH + GY) }; });
    });
    const edges = [];
    for (const t of m.tasks) for (const d of t.deps) {
      const a = pos[d], b = pos[t.id]; if (!a || !b) continue;
      const src = m.tasks.find((x) => x.id === d);
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, c = Math.max(24, (x2 - x1) / 2);
      const cls = BUSY_T.includes(t.status) ? 'live' : src && src.status === 'ok' ? 'done' : ['falhou', 'bloqueada', 'cancelada'].includes(src && src.status) ? 'bad' : '';
      edges.push(`<path class="${cls}" d="M${x1} ${y1} C${x1 + c} ${y1} ${x2 - c} ${y2} ${x2} ${y2}"/><circle class="${cls}" cx="${x2}" cy="${y2}" r="3"/>`);
    }
    const heads = layers.map((l, i) => `<div class="os-lh" style="left:${P + i * (NW + GX)}px;width:${NW}px">Etapa ${i + 1}${l.length > 1 ? ' · ' + l.length + ' em paralelo' : ''}</div>`).join('');
    return `<div class="os-canvas"><div class="os-graph" style="width:${W}px;height:${H + 18}px">${heads}
      <svg class="os-edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="top:18px">${edges.join('')}</svg>
      <div class="os-nodes" style="top:18px">${m.tasks.map((t) => nodeHtml(m, t, `left:${pos[t.id].x}px;top:${pos[t.id].y}px;width:${NW}px;height:${NH}px`)).join('')}</div>
    </div></div>`;
  }

  function layersHtml(m) {
    return `<div class="os-layers">${depthOf(m).map((l, i) => `<div class="os-layer"><div class="os-layer-h"><span>Etapa ${i + 1}</span><em>${l.length > 1 ? l.length + ' em paralelo' : '1 tarefa'}</em></div><div class="os-layer-c">${l.map((t) => nodeHtml(m, t)).join('')}</div></div>`).join('')}</div>`;
  }

  function kanbanHtml(m) {
    return `<div class="os-kanban">${COLS.map(([title, sts]) => {
      const ts = m.tasks.filter((t) => sts.includes(t.status));
      if (title === 'Problemas' && !ts.length) return '';
      return `<div class="os-col"><div class="os-col-h">${E(title)}<span class="num">${ts.length}</span></div>${ts.map((t) => nodeHtml(m, t)).join('') || '<div class="os-col-e">—</div>'}</div>`;
    }).join('')}</div>`;
  }

  // ---- painel da tarefa
  function setPanel(tid, silent) {
    S.panel = tid;
    const p = Q('#osPanel'); if (!p) return;
    p.hidden = !tid; Q('#osScrim').hidden = !tid;
    Q('#osRoot').classList.toggle('panel-open', !!tid);
    if (!tid) { p.innerHTML = ''; p._h = null; }
    if (!silent) renderDetail();
  }

  function renderPanel() {
    const m = S.mission, p = Q('#osPanel');
    if (!S.panel || !m) return;
    const t = m.tasks.find((x) => x.id === S.panel); if (!t) return setPanel(null);
    const busy = BUSY_T.includes(t.status);
    const used = t.engineUsed && t.engineUsed !== t.engine ? ` <span class="muted" title="Rodou com outra IA (fallback)">→ ${E(engShort(t.engineUsed))}</span>` : '';
    const v = t.verdict;
    const verdict = v ? `<div class="os-verd ${v.pass ? 'pass' : 'fail'}">
        <div class="os-verd-h">${v.pass ? '✓ Aprovada' : '✗ Reprovada'} por ${engChip(v.engine)}</div>
        ${(v.checks || []).map((c) => `<div class="os-chk ${c.ok ? 'ok' : 'no'}"><b>${c.ok ? '✓' : '✗'}</b><span>${E(c.criterion || '')}${c.evidence ? `<em>${E(String(c.evidence).slice(0, 300))}</em>` : ''}</span></div>`).join('')}
        ${(v.issues || []).length ? `<div class="os-issues">${v.issues.map((i) => `<div>• ${E(i)}</div>`).join('')}</div>` : ''}
      </div>` : (t.status === 'verificando' ? `<div class="os-verd run"><span class="spin"></span> ${engChip(t.verifyEngine)} conferindo os critérios…</div>` : '');
    const k = (n) => m.id + ':' + t.id + ':' + n;
    patch(p, `<div class="os-tp-h"><span class="tid">${E(t.id)}</span>${engChip(t.engine, used)}${stBadge(T_ST, t.status)}<span style="flex:1"></span><button class="os-ib" data-a="closep" aria-label="Fechar">${IC.x}</button></div>
      <h3 class="os-tp-t">${E(t.title)}</h3>
      <div class="os-card-m">
        ${t.deps.length ? `<span>depende de ${t.deps.map((d) => { const x = m.tasks.find((y) => y.id === d); return `<button class="tid ${x && x.status === 'ok' ? 'okd' : ''}" data-node="${E(d)}">${E(d)}</button>`; }).join(' ')}</span>` : '<span class="muted">sem dependências</span>'}
        <span>${t.attempts || 0} tentativa${t.attempts === 1 ? '' : 's'}</span><span class="${t.fixes ? 's-warn' : ''}">${t.fixes || 0} correç${t.fixes === 1 ? 'ão' : 'ões'}</span>
      </div>
      <div class="os-tp-a">
        <button class="btn sm" data-a="live" data-tid="${t.id}" ${t.convId ? '' : 'disabled'}>${busy && t.status !== 'verificando' ? '<span class="os-dot s-run"></span>' : '👁'} Ver ao vivo</button>
        <button class="btn sm" data-a="vconv" data-tid="${t.id}" ${t.verifyConvId ? '' : 'disabled'}>${t.status === 'verificando' ? '<span class="os-dot s-run"></span>' : '🔍'} Verificação</button>
        <button class="btn sm" data-a="retry" data-tid="${t.id}" ${busy || t.status === 'pendente' || m.state === 'aguardando' ? 'disabled' : ''}>🔁 Refazer</button>
        <button class="btn sm" data-a="engine" data-tid="${t.id}" ${busy || m.state === 'aguardando' ? 'disabled' : ''}>⇄ Trocar IA</button>
      </div>
      ${t.error && !['ok', 'pendente'].includes(t.status) ? `<div class="os-err">${E(t.error)}</div>` : ''}
      ${verdict}
      ${t.acceptance && t.acceptance.length ? `<h4>Critérios de aceite</h4><ul class="os-acc">${t.acceptance.map((a) => `<li>${E(a)}</li>`).join('')}</ul>` : ''}
      ${t.files && t.files.length ? `<h4>Arquivos</h4><div class="os-files">${t.files.map((f) => `<code class="mono">${E(f)}</code>`).join('')}</div>` : ''}
      ${t.summary ? `<h4>Resultado</h4><div class="os-pre">${E(t.summary)}</div>` : ''}
      <details class="os-det" data-card="${k('p')}" ${S.openCards.has(k('p')) ? 'open' : ''}><summary>Instrução que a IA recebeu</summary><div class="os-pre os-small">${E(t.prompt || '')}</div></details>
      ${t.outputPreview ? `<details class="os-det" data-card="${k('o')}" ${S.openCards.has(k('o')) ? 'open' : ''}><summary>Saída da IA</summary><div class="os-pre os-small mono">${E(t.outputPreview)}</div></details>` : ''}`);
  }

  // ------------------------------------------------------------------ ações
  async function act(path, body, okMsg, id) {
    const mid = id || S.sel;
    try { await api('/api/missions/' + mid + path, { method: 'POST', body: body || {} }); if (okMsg) say(okMsg); }
    catch (e) { say(e.message); }
    loadDetail(); loadList();
  }

  // apagar: se a missão tem worktrees/branches, oferece apagar os branches também
  function delConfirm(m) {
    const g = m.git && !['aplicada', 'descartada'].includes(m.git.status) ? m.git : (m.gitStatus && !['aplicada', 'descartada'].includes(m.gitStatus) ? { branch: 'agentos/' + m.id.slice(0, 8) } : null);
    const extra = g ? `<label class="os-rm" style="display:flex;gap:8px;margin-top:12px"><input type="checkbox" id="osDelBr"> Apagar também os branches <code class="mono">${E(g.branch)}…</code> (os worktrees da missão são removidos de qualquer jeito)</label>` : '';
    sheet('Apagar missão?', `<div class="os-note" style="font-size:14px">A missão “${E(m.title)}” sai da lista. Os arquivos do projeto e as conversas das IAs não são apagados.${extra}</div><div class="btns" style="padding:0 10px 6px"><button class="btn primary" id="osCfOk">🗑 Apagar</button><button class="btn" data-close>Voltar</button></div>`, (ov) => {
      Q('#osCfOk', ov).onclick = () => { const br = !!(Q('#osDelBr', ov) && Q('#osDelBr', ov).checked); closeSheet(); delMission(m.id, br); };
    });
  }

  async function delMission(id, branches) {
    try { await api('/api/missions/' + id + (branches ? '?branches=1' : ''), { method: 'DELETE' }); say('Missão apagada'); delete S.cache[id]; if (S.sel === id) select(null); loadList(); }
    catch (er) { say(er.message); }
  }

  function confirmSheet(title, text, label, run) {
    sheet(title, `<div class="os-note" style="font-size:14px">${text}</div><div class="btns" style="padding:0 10px 6px"><button class="btn primary" id="osCfOk">${label}</button><button class="btn" data-close>Voltar</button></div>`, (ov) => {
      Q('#osCfOk', ov).onclick = () => { closeSheet(); run(); };
    });
  }

  function onDetailClick(e) {
    const n = e.target.closest('[data-node]');
    if (n) { setPanel(S.panel === n.dataset.node && n.classList.contains('os-node') ? null : n.dataset.node); return; }
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const m = S.mission; if (!m) return;
    const t = b.dataset.tid ? m.tasks.find((x) => x.id === b.dataset.tid) : null;
    switch (b.dataset.a) {
      case 'closep': return setPanel(null);
      case 'cancel': return confirmSheet('Cancelar missão?', 'As IAs que estão trabalhando serão interrompidas. O que já foi feito na pasta continua lá.', '⏹ Cancelar missão', () => act('/cancel', null, 'Missão cancelada'));
      case 'resume': return act('/resume', {}, 'Retomando a missão');
      case 'resumeAll': return act('/resume', { all: true }, 'Refazendo as tarefas que falharam');
      case 'arch': return openChat(m.planConvId);
      case 'files': if (state.files) { state.files.dir = m.cwd; state.files.tab = 'tree'; } return go('files');
      case 'del': return delConfirm(m);
      case 'limit': return pickLimit('Aumentar o limite de tokens', m.maxTokens, m.tokensUsed || 0, (n) => act('/limit', { maxTokens: n }, '🎯 Limite aumentado. Continuando a missão.'));
      case 'apply': return confirmSheet('Aplicar no projeto?', `Junta o branch <code class="mono">${E(m.git.branch)}</code> no branch atual da pasta <b>${E(baseName(m.cwd))}</b>${m.git.startBranch ? ` (<b>${E(m.git.startBranch)}</b>)` : ''}: fast-forward se der, senão um merge normal. Se houver conflito, nada é alterado e eu explico o motivo.`, '✅ Aplicar no projeto', () => act('/apply', {}, '✅ Resultado aplicado no projeto'));
      case 'discard': return confirmSheet(m.git.status === 'cancelada' ? 'Apagar os branches?' : 'Descartar o resultado?', `Remove os worktrees em <code class="mono">.agentos/wt</code> e os branches <code class="mono">${E(m.git.branch)}…</code> desta missão. Sua pasta e o seu branch não são alterados. Não dá para desfazer.`, '🗑 Descartar', () => act('/discard', { branches: true }, '🗑 Resultado descartado'));
      case 'approve': {
        const ed = S.approve[m.id] || {};
        const tasks = Object.entries(ed).map(([id, v]) => ({ id, engine: v.engine, remove: !!v.remove }));
        if (m.tasks.filter((x) => x.status === 'pendente').every((x) => ed[x.id] && ed[x.id].remove)) return say('Mantenha pelo menos uma tarefa.');
        delete S.approve[m.id];
        return act('/approve', { tasks }, '▶️ Plano aprovado. A equipe começou.');
      }
      case 'live': return t && openChat(t.convId);
      case 'vconv': return t && openChat(t.verifyConvId);
      case 'retry': return t && act('/tasks/' + t.id + '/retry', {}, `🔁 ${t.id} vai rodar de novo`);
      case 'engine': return t && pickTaskEngine(m, t);
    }
  }

  function onDetailChange(e) {
    const m = S.mission; if (!m) return;
    const el = e.target;
    const ed = S.approve[m.id] || (S.approve[m.id] = {});
    if (el.dataset.apEng) { (ed[el.dataset.apEng] = ed[el.dataset.apEng] || {}).engine = el.value; renderDetail(); }
    if (el.dataset.apRm) { (ed[el.dataset.apRm] = ed[el.dataset.apRm] || {}).remove = el.checked; renderDetail(); }
  }

  function pickTaskEngine(m, t) {
    const engs = (m.options && m.options.engines) || [];
    let rerun = t.status !== 'pendente';
    const draw = (ov) => {
      Q('.sheet-b', ov).innerHTML = `<div class="os-note">${E(t.id)} · ${E(t.title)}</div>` +
        engs.map((id) => optBtn(`data-e="${id}"`, E(engName(id)) + (id === t.engine ? ' · atual' : ''), E(S.strengths[id] || ''), id === t.engine, engDot(id))).join('') +
        (t.status !== 'pendente' ? `<div class="engrow" style="padding:10px"><div class="tx"><b>Refazer agora com a nova IA</b><span>Começa uma conversa nova para esta tarefa.</span></div><label class="sw"><input type="checkbox" id="osRerun" ${rerun ? 'checked' : ''}><i></i></label></div>` : '');
      const rr = Q('#osRerun', ov); if (rr) rr.onchange = () => { rerun = rr.checked; };
      QQ('[data-e]', ov).forEach((b) => b.onclick = async () => {
        const id = b.dataset.e; closeSheet();
        if (id === t.engine && !rerun) return;
        try {
          if (id !== t.engine) await api(`/api/missions/${m.id}/tasks/${t.id}/engine`, { method: 'POST', body: { engine: id } });
          if (rerun) await api(`/api/missions/${m.id}/tasks/${t.id}/retry`, { method: 'POST', body: {} });
          say(`${t.id} agora com ${engShort(id)}${rerun ? ' — rodando de novo' : ''}`);
        } catch (er) { say(er.message); }
        loadDetail(); loadList();
      });
    };
    sheet('Trocar IA da tarefa', '', draw);
  }

  async function sendMore() {
    const mo = Q('#osMore'); const text = mo.value.trim();
    if (!text) return mo.focus();
    if (Q('#osMoreGo').disabled) return say('Espere a etapa atual terminar.');
    try {
      await api('/api/missions/' + S.sel + '/message', { method: 'POST', body: { text } });
      mo.value = ''; ls.set('more.' + S.sel, '');
      say('💬 Pedido enviado. O Arquiteto vai planejar as novas tarefas.');
    } catch (e) { say(e.message); }
    loadDetail(); loadList();
  }

  // ------------------------------------------------------------------ chat da equipe (estilo WhatsApp)
  // ------------------------------------------------------------------ automações agendadas
  const AUTO_SUGS = [
    { label: 'Todo dia: rode os testes', name: 'Testes diários', kind: 'mission', goal: 'Rode os testes do projeto e corrija o que quebrar. Se tudo passar, não mude nada.', schedule: { type: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
    { label: 'Toda segunda: dependências', name: 'Revisar dependências', kind: 'mission', goal: 'Revise as dependências desatualizadas do projeto, atualize as seguras e rode os testes. Liste no relatório o que ficou para depois.', schedule: { type: 'daily', time: '09:00', days: [1] } },
  ];
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const AU = { list: [], at: 0, loaded: false, open: new Set() };
  const AUTO_ST = { rodando: ['Rodando', 'run'], ok: ['Ok', 'ok'], erro: ['Erro', 'err'], perdida: ['Perdida', 'warn'], pulada: ['Pulada', 'off'], interrompido: ['Interrompida', 'warn'], cancelado: ['Cancelada', 'off'], apagada: ['Missão apagada', 'off'] };
  const hState = (st) => AUTO_ST[st] || M_ST[st] || [st || '—', 'off'];
  function schedText(s) {
    if (!s) return '—';
    if (s.type === 'interval') return s.minutes % 1440 === 0 ? `A cada ${s.minutes / 1440} dia(s)` : s.minutes % 60 === 0 ? (s.minutes === 60 ? 'A cada hora' : `A cada ${s.minutes / 60} h`) : `A cada ${s.minutes} min`;
    if (s.type === 'daily') {
      const d = s.days || [];
      const days = d.length === 7 || !d.length ? 'Todo dia' : d.join() === '1,2,3,4,5' ? 'Dias úteis' : d.length === 1 ? 'Toda ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d[0]] : d.map((x) => DAYS[x]).join(', ');
      return `${days} às ${s.time}`;
    }
    if (s.type === 'once') return 'Uma vez em ' + dt(s.at);
    return '—';
  }

  async function loadAutos() {
    AU.at = Date.now();
    try { const d = await api('/api/automations'); AU.list = d.automations || []; AU.loaded = true; } catch { return; }
    renderAutos();
  }

  function renderAutos() {
    const el = Q('#osAutos'); if (!el) return;
    const n = AU.list.filter((a) => a.enabled).length;
    const nb = Q('#osAutoN'); if (nb) { nb.hidden = !n; nb.textContent = n; }
    if (!AU.list.length) { patch(el, `<div class="os-empty os-autoempty">${AU.loaded ? 'Nenhuma automação ainda. Agende uma missão ou um prompt para rodar sozinho — use uma das sugestões acima ou “+ Nova automação”.' : 'Carregando…'}</div>`); return; }
    patch(el, AU.list.map((a) => {
      const last = (a.history || [])[0];
      const [lT, lC] = last ? hState(last.state) : ['Nunca rodou', 'off'];
      const hist = (a.history || []).slice(0, 12).map((h) => {
        const [t, c] = hState(h.state);
        const link = h.missionId ? `<button class="os-alink" data-amis="${E(h.missionId)}">${E(h.title || 'Abrir missão')}</button>` : h.convId ? `<button class="os-alink" data-aconv="${E(h.convId)}">Abrir conversa</button>` : `<span class="muted">${E(h.error || '')}</span>`;
        return `<div class="os-ah"><span class="num muted">${E(dt(h.ts))}</span><span class="os-st s-${c}"><i></i>${E(t)}</span>${h.manual ? '<span class="muted">manual</span>' : ''}${link}</div>`;
      }).join('');
      const open = AU.open.has(a.id);
      return `<div class="os-auto ${a.enabled ? '' : 'off'}" data-auto="${a.id}">
        <div class="os-auto-h"><span class="os-auto-k">${a.kind === 'prompt' ? '💬 Prompt' : '🧠 Missão'}</span><b title="${E(a.name)}">${E(a.name)}</b>
          <label class="sw" title="${a.enabled ? 'Desligar' : 'Ligar'}"><input type="checkbox" data-atog="${a.id}" ${a.enabled ? 'checked' : ''}><i></i></label></div>
        <p class="os-auto-g" title="${E(a.goal)}">${E(a.goal)}</p>
        <div class="os-auto-m"><span>🗓 ${E(schedText(a.schedule))}</span><span>📁 ${E(baseName(a.cwd))}</span>${a.cheap !== false ? '<span>💸 econômico</span>' : ''}</div>
        <div class="os-auto-s"><div><span>Próximo disparo</span><b>${a.running ? '<span class="os-dot s-run"></span> rodando agora' : a.enabled && a.nextRun ? E(inTime(a.nextRun)) + `<em>${E(dt(a.nextRun))}</em>` : 'desligada'}</b></div>
          <div><span>Última execução</span><b>${last ? `<span class="os-st s-${lC}"><i></i>${E(lT)}</span><em>${E(when(last.ts))}</em>` : '<span class="muted">nunca</span>'}</b></div></div>
        <div class="os-auto-b"><button class="btn sm" data-arun="${a.id}" ${a.running ? 'disabled' : ''}>▶ Rodar agora</button><button class="btn sm" data-aedit="${a.id}">Editar</button>
          <button class="btn sm os-danger" data-adel="${a.id}">Apagar</button><span style="flex:1"></span>
          <button class="btn sm ghost" data-ahist="${a.id}" ${(a.history || []).length ? '' : 'disabled'}>Histórico${(a.history || []).length ? ' · ' + a.history.length : ''} ${open ? '▴' : '▾'}</button></div>
        ${open ? `<div class="os-ahist">${hist || '<span class="muted">Sem execuções.</span>'}</div>` : ''}
      </div>`;
    }).join(''));
  }

  async function onAutoClick(e) {
    const b = e.target.closest('[data-atog],[data-arun],[data-aedit],[data-adel],[data-ahist],[data-amis],[data-aconv]'); if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.atog) {
      try { await api(`/api/automations/${d.atog}/toggle`, { method: 'POST', body: { enabled: b.checked } }); say(b.checked ? '⏰ Automação ligada' : 'Automação desligada'); }
      catch (er) { say(er.message); }
      return loadAutos();
    }
    if (d.arun) {
      b.disabled = true;
      try { const r = await api(`/api/automations/${d.arun}/run`, { method: 'POST', body: {} }); say(r.entry && r.entry.state === 'erro' ? '⚠️ ' + (r.entry.error || 'falhou') : '▶ Automação disparada'); AU.open.add(d.arun); }
      catch (er) { say(er.message); }
      loadAutos(); return loadList();
    }
    if (d.aedit) return autoForm(AU.list.find((a) => a.id === d.aedit));
    if (d.adel) {
      const a = AU.list.find((x) => x.id === d.adel);
      return confirmSheet('Apagar automação?', `“${E(a ? a.name : '')}” para de rodar. As missões e conversas que ela já criou continuam.`, '🗑 Apagar', async () => {
        try { await api('/api/automations/' + d.adel, { method: 'DELETE' }); say('Automação apagada'); } catch (er) { say(er.message); }
        loadAutos();
      });
    }
    if (d.ahist) { if (AU.open.has(d.ahist)) AU.open.delete(d.ahist); else AU.open.add(d.ahist); return renderAutos(); }
    if (d.amis) return select(d.amis);
    if (d.aconv) return openChat(d.aconv);
  }

  // formulário de criar/editar (folha)
  function autoForm(a, sug) {
    const ws = (state.info && state.info.workspaces) || [];
    const base = a || sug || {};
    const pad = (n) => String(n).padStart(2, '0');
    const localIso = (ts) => { const x = new Date(ts); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`; };
    const f = {
      name: base.name || '', kind: base.kind || 'mission', goal: base.goal || '', cwd: base.cwd || S.opts.cwd || ws[0] || '',
      engines: (base.engines && base.engines.length ? base.engines : S.opts.engines).slice(), lead: base.lead || S.opts.lead,
      cheap: base.cheap !== false, skip: base.skip === true,
      schedule: JSON.parse(JSON.stringify(base.schedule || { type: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] })),
    };
    const draw = (ov) => {
      const s = f.schedule;
      const on = usable();
      Q('.sheet-b', ov).innerHTML = `<div class="os-aform">
        <label class="os-fl"><span>Nome</span><input id="afName" value="${E(f.name)}" placeholder="Ex.: Testes de toda manhã" maxlength="80"></label>
        <div class="os-fl"><span>Tipo</span><div class="seg" style="margin:0"><button data-ak="mission" class="${f.kind === 'mission' ? 'on' : ''}">🧠 Missão (equipe de IAs)</button><button data-ak="prompt" class="${f.kind === 'prompt' ? 'on' : ''}">💬 Prompt (uma IA)</button></div></div>
        <label class="os-fl"><span>${f.kind === 'prompt' ? 'Prompt' : 'Objetivo da missão'}</span><textarea id="afGoal" rows="3" placeholder="${f.kind === 'prompt' ? 'Ex.: Resuma os commits de ontem' : 'Ex.: Rode os testes e corrija o que quebrar'}">${E(f.goal)}</textarea></label>
        <label class="os-fl"><span>Pasta</span><input id="afCwd" class="mono" list="afCwdL" value="${E(f.cwd)}" placeholder="C:\\caminho\\do\\projeto"><datalist id="afCwdL">${ws.map((w) => `<option value="${E(w)}">`).join('')}</datalist></label>
        <div class="os-fl"><span>${f.kind === 'prompt' ? 'IA' : 'Equipe'}</span><div class="os-row" style="flex-wrap:wrap">${on.map((id) => `<button class="chip toggle ${(f.kind === 'prompt' ? f.lead === id : f.engines.includes(id)) ? 'on' : ''}" data-ae="${id}">${engDot(id)} ${E(engShort(id))}</button>`).join('') || '<span class="muted">Nenhuma IA ligada</span>'}</div></div>
        <div class="engrow" style="padding:4px 0"><div class="tx"><b>💸 Econômico</b><span>Usa o modelo mais barato de cada IA</span></div><label class="sw"><input type="checkbox" id="afCheap" ${f.cheap ? 'checked' : ''}><i></i></label></div>
        <div class="engrow" style="padding:4px 0"><div class="tx"><b>🔓 Liberar comandos</b><span>As IAs rodam comandos sem pedir permissão, sem ninguém olhando. Desligado, tarefas que precisam do terminal podem falhar</span></div><label class="sw"><input type="checkbox" id="afSkip" ${f.skip ? 'checked' : ''}><i></i></label></div>
        <div class="os-fl"><span>Agenda</span><div class="os-row" style="flex-wrap:wrap">
          <button class="chip" data-ap="hour">A cada hora</button><button class="chip" data-ap="day9">Todo dia às 09:00</button><button class="chip" data-ap="wk18">Dias úteis às 18:00</button><button class="chip" data-ap="once">Uma vez em…</button></div></div>
        <div class="seg" style="margin:0"><button data-at="interval" class="${s.type === 'interval' ? 'on' : ''}">Intervalo</button><button data-at="daily" class="${s.type === 'daily' ? 'on' : ''}">Diária</button><button data-at="once" class="${s.type === 'once' ? 'on' : ''}">Uma vez</button></div>
        ${s.type === 'interval' ? `<label class="os-fl"><span>A cada (minutos)</span><input id="afMin" type="number" min="1" value="${E(s.minutes || 60)}"></label>` : ''}
        ${s.type === 'daily' ? `<label class="os-fl"><span>Horário</span><input id="afTime" type="time" value="${E(s.time || '09:00')}"></label>
          <div class="os-row" style="flex-wrap:wrap">${DAYS.map((d, i) => `<button class="chip toggle ${(s.days || []).includes(i) ? 'on' : ''}" data-ad="${i}">${d}</button>`).join('')}</div>` : ''}
        ${s.type === 'once' ? `<label class="os-fl"><span>Data e hora</span><input id="afAt" type="datetime-local" value="${E(localIso(s.at || Date.now() + 3600e3))}"></label>` : ''}
        <p class="muted os-anext">🗓 ${E(schedText(s))}</p>
        <div class="btns"><button class="btn primary" id="afSave">${a ? 'Salvar' : 'Criar automação'}</button><button class="btn" data-close>Cancelar</button></div></div>`;
      const keep = () => {
        f.name = Q('#afName', ov).value; f.goal = Q('#afGoal', ov).value; f.cwd = Q('#afCwd', ov).value.trim();
        f.cheap = Q('#afCheap', ov).checked; f.skip = Q('#afSkip', ov).checked;
        if (Q('#afMin', ov)) f.schedule.minutes = Math.max(1, +Q('#afMin', ov).value || 60);
        if (Q('#afTime', ov)) f.schedule.time = Q('#afTime', ov).value || '09:00';
        if (Q('#afAt', ov)) f.schedule.at = new Date(Q('#afAt', ov).value).getTime();
      };
      QQ('[data-ak]', ov).forEach((b) => b.onclick = () => { keep(); f.kind = b.dataset.ak; draw(ov); });
      QQ('[data-ae]', ov).forEach((b) => b.onclick = () => {
        keep(); const id = b.dataset.ae;
        if (f.kind === 'prompt') f.lead = id;
        else if (f.engines.includes(id)) { if (f.engines.length > 1) f.engines = f.engines.filter((x) => x !== id); } else f.engines.push(id);
        draw(ov);
      });
      QQ('[data-at]', ov).forEach((b) => b.onclick = () => {
        keep(); const t = b.dataset.at;
        f.schedule = t === 'interval' ? { type: t, minutes: 60 } : t === 'daily' ? { type: t, time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } : { type: t, at: Date.now() + 3600e3 };
        draw(ov);
      });
      QQ('[data-ap]', ov).forEach((b) => b.onclick = () => {
        keep(); const p = b.dataset.ap;
        f.schedule = p === 'hour' ? { type: 'interval', minutes: 60 } : p === 'day9' ? { type: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }
          : p === 'wk18' ? { type: 'daily', time: '18:00', days: [1, 2, 3, 4, 5] } : { type: 'once', at: Math.ceil((Date.now() + 3600e3) / 300e3) * 300e3 };
        draw(ov);
      });
      QQ('[data-ad]', ov).forEach((b) => b.onclick = () => {
        keep(); const i = +b.dataset.ad, d = f.schedule.days || [];
        f.schedule.days = d.includes(i) ? (d.length > 1 ? d.filter((x) => x !== i) : d) : [...d, i].sort();
        draw(ov);
      });
      ['#afMin', '#afTime', '#afAt'].forEach((k) => { const i = Q(k, ov); if (i) i.onchange = () => { keep(); Q('.os-anext', ov).textContent = '🗓 ' + schedText(f.schedule); }; });
      Q('#afSave', ov).onclick = async () => {
        keep();
        if (!f.name.trim()) return say('Dê um nome para a automação.');
        if (!f.goal.trim()) return say(f.kind === 'prompt' ? 'Escreva o prompt.' : 'Escreva o objetivo.');
        const body = { name: f.name, kind: f.kind, goal: f.goal, cwd: f.cwd, engines: f.kind === 'prompt' ? [f.lead] : f.engines, lead: f.kind === 'prompt' ? f.lead : (f.engines.includes(f.lead) ? f.lead : f.engines[0]), cheap: f.cheap, skip: f.skip, schedule: f.schedule };
        try {
          await api(a ? '/api/automations/' + a.id : '/api/automations', { method: a ? 'PUT' : 'POST', body });
          closeSheet(); say(a ? 'Automação salva' : '⏰ Automação criada'); loadAutos();
        } catch (er) { say(er.message); }
      };
    };
    sheet(a ? 'Editar automação' : 'Nova automação', '', draw);
  }

  let DC = null; // chat do detalhe
  const AI_IDS = ['claude', 'codex', 'agy', 'opencode'];
  const seenMap = () => ls.get('seen', {});
  function markSeen(mid, ts) { const s = seenMap(); if (!ts || (s[mid] || 0) >= ts) return; s[mid] = ts; ls.set('seen', s); }
  const dayKey = (ts) => new Date(ts).toDateString();
  function dayLabel(ts) {
    const d = new Date(ts), t = new Date(); t.setHours(0, 0, 0, 0);
    if (d >= t) return 'Hoje';
    if (d >= new Date(+t - 864e5)) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
  }
  const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  function fmtMsg(text) {
    const inline = (l) => l.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/@(claude|codex|agy|opencode)\b/gi, (_, id) => `<span class="osc-men ${ecls(id.toLowerCase())}">@${id.toLowerCase()}</span>`);
    let out = '', list = false;
    for (const raw of E(text).split('\n')) {
      const li = raw.match(/^\s*(?:•|-|\*|\d+[.)])\s+(.*)/);
      if (li) { if (!list) { out += '<ul>'; list = true; } out += '<li>' + inline(li[1]) + '</li>'; continue; }
      if (list) { out += '</ul>'; list = false; }
      if (raw.trim()) out += '<p>' + inline(raw) + '</p>';
    }
    return out + (list ? '</ul>' : '');
  }
  const avatar = (id) => `<span class="osc-av ${ecls(id)}">${E(engShort(id)[0] || '?')}</span>`;

  function makeChat(host, opts) {
    const c = { host, opts, mid: null, msgs: [], ids: new Set(), last: 0, typing: [], meta: {}, at: 0, polling: false, atBottom: true, sending: false, ac: [], acSel: 0 };
    host.innerHTML = `<div class="osc">
      <div class="osc-scroll"><div class="osc-steps"></div><div class="osc-list"></div><div class="osc-typing"></div></div>
      <button class="osc-new" hidden>↓ novas mensagens</button>
      <div class="osc-comp"><div class="osc-ac" hidden></div>
        <textarea rows="1" placeholder="${isMobile() ? 'Fale com a equipe… (@ cita)' : 'Fale com a equipe… (@codex para citar)'}" aria-label="Mensagem para a equipe"></textarea>
        <button class="osc-send" aria-label="Enviar"><svg><use href="#i-send"/></svg></button></div>
    </div>`;
    const sc = Q('.osc-scroll', host), list = Q('.osc-list', host), typ = Q('.osc-typing', host), steps = Q('.osc-steps', host);
    const newb = Q('.osc-new', host), ta = Q('textarea', host), acEl = Q('.osc-ac', host);
    sc.addEventListener('scroll', () => { c.atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60; if (c.atBottom) newb.hidden = true; });
    newb.onclick = () => c.toBottom(true);
    c.toBottom = (smooth) => { sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); c.atBottom = true; newb.hidden = true; };
    steps.addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS') { ls.set('steps', e.target.open); steps._h = null; } }, true);

    c.set = (mid) => {
      if (c.mid === mid) return;
      c.mid = mid; c.msgs = []; c.ids = new Set(); c.last = 0; c.typing = []; c.meta = {}; c.at = 0;
      ta.value = mid ? ls.get('cdraft.' + mid, '') : '';
      list.innerHTML = mid ? '<div class="osc-sys"><span>Carregando conversa…</span></div>' : ''; list._h = null; typ.innerHTML = ''; typ._h = null; steps.innerHTML = ''; steps._h = null;
      if (mid) c.poll();
    };
    c.unread = () => { const s = seenMap()[c.mid] || 0; return c.msgs.filter((m) => m.ts > s && m.from !== 'user').length; };
    c.poll = async () => {
      const mid = c.mid; if (!mid || c.polling) return;
      c.polling = true; c.at = Date.now();
      try {
        const d = await api(`/api/missions/${mid}/chat?after=${c.last}`);
        if (mid !== c.mid) return;
        let added = 0;
        for (const m of d.chat || []) if (!c.ids.has(m.id)) { c.ids.add(m.id); c.msgs.push(m); added++; if (m.ts > c.last) c.last = m.ts; }
        if (c.msgs.length > 600) c.msgs.splice(0, c.msgs.length - 600);
        c.typing = d.typing || []; c.meta = d;
        if (added || !list._h || list._h.includes('Carregando')) c.renderList(added);
        c.renderTyping();
        if (c.opts.isVisible() && c.msgs.length) markSeen(mid, c.last);
        if (c.opts.onUpdate) c.opts.onUpdate(c);
      } catch (e) {
        if (mid === c.mid && /não encontrada|404/i.test(e.message)) { list.innerHTML = '<div class="osc-sys"><span>Missão não encontrada.</span></div>'; c.mid = null; if (c.opts.onGone) c.opts.onGone(); }
      } finally { c.polling = false; }
    };
    c.renderList = (added) => {
      const keepBottom = c.atBottom;
      let html = '', prev = null, day = '';
      for (const m of c.msgs) {
        const dk = dayKey(m.ts);
        if (dk !== day) { day = dk; prev = null; html += `<div class="osc-day"><span>${E(dayLabel(m.ts))}</span></div>`; }
        if (m.from === 'system') { prev = null; html += `<div class="osc-sys ${m.kind === 'error' ? 'err' : ''}"><span>${fmtMsg(m.text)}<em>${hm(m.ts)}</em></span></div>`; continue; }
        const me = m.from === 'user';
        const cont = prev && prev.from === m.from && prev.role === m.role && m.ts - prev.ts < 5 * 60e3;
        prev = m;
        const seal = m.kind === 'verdict' ? `<span class="osc-seal ${m.pass ? 'ok' : 'no'}">${m.pass ? '✓ Aprovada' : '✗ Reprovada'}</span>` : '';
        const chip = m.taskId ? `<button class="osc-task" data-node="${E(m.taskId)}" title="Abrir a tarefa">${E(m.taskId)}</button>` : '';
        const head = me ? (m.kind === 'goal' ? '<div class="osc-who"><b>🎯 Objetivo da missão</b></div>' : '')
          : (cont ? '' : `<div class="osc-who"><b class="${ecls(m.from)}">${E(engShort(m.from))}</b><span>· ${E(m.role || '')}</span>${chip}${seal}</div>`);
        const extra = !me && cont && (chip || seal) ? `<div class="osc-who sub">${chip}${seal}</div>` : '';
        html += `<div class="osc-msg ${me ? 'me' : 'ai'} ${cont ? 'cont' : ''} k-${E(m.kind || 'info')}">
          ${me ? '' : (cont ? '<span class="osc-av sp"></span>' : avatar(m.from))}
          <div class="osc-b ${me ? '' : ecls(m.from)}">${head}${extra}<div class="osc-t">${fmtMsg(m.text)}</div><span class="osc-tm">${hm(m.ts)}${me ? ' <i>✓✓</i>' : ''}</span></div>
        </div>`;
      }
      if (!c.msgs.length) html = '<div class="osc-sys"><span>Nenhuma mensagem ainda. Fale com a equipe aqui embaixo.</span></div>';
      patch(list, html);
      if (keepBottom || !added) { c.toBottom(); setTimeout(() => { if (c.atBottom) c.toBottom(); }, 60); }
      else if (added) newb.hidden = false;
    };
    c.renderTyping = () => {
      patch(typ, c.typing.map((t) => {
        const who = engShort(t.engine);
        const what = t.role === 'Arquiteto' ? `${who} (Arquiteto) está pensando…` : t.role === 'Verificador' ? `${who} está verificando a ${t.taskId}…` : `${who} está escrevendo a ${t.taskId}…`;
        return `<div class="osc-msg ai osc-ty">${avatar(t.engine)}<div class="osc-b ${ecls(t.engine)}"><span class="osc-dots"><i></i><i></i><i></i></span><span class="osc-tyt">${E(what)}</span></div></div>`;
      }).join(''));
      if (c.atBottom) sc.scrollTop = sc.scrollHeight;
    };
    c.renderSteps = () => {
      const m = c.opts.getMission && c.opts.getMission();
      if (!m || m.id !== c.mid || !m.tasks || !m.tasks.length) { patch(steps, ''); return; }
      const done = m.tasks.filter((t) => t.status === 'ok').length;
      const live = m.tasks.filter((t) => t.status !== 'removida');
      const finished = ['concluido', 'concluido_com_pendencias'].includes(m.state) && m.finishedAt;
      const ic = (t) => t.status === 'ok' ? '<b class="ok">✓</b>' : ['falhou', 'bloqueada'].includes(t.status) ? '<b class="no">✗</b>' : BUSY_T.includes(t.status) ? '<span class="spin"></span>' : ['cancelada', 'removida'].includes(t.status) ? '<b class="off">–</b>' : '<b class="off">○</b>';
      const open = ls.get('steps', false);
      patch(steps, `<details class="osc-stepcard" ${open ? 'open' : ''}><summary><span class="osc-sum">Passos da missão</span><span class="num">${done}/${live.length}</span>
          <span class="os-prog"><i style="width:${live.length ? done / live.length * 100 : 0}%"></i></span>
          ${finished ? `<span class="osc-fin">Tarefa concluída em ${E(dur(m.finishedAt - m.createdAt))}</span>` : ACTIVE.includes(m.state) ? '<span class="osc-fin run">em andamento</span>' : ''}</summary>
        <div class="osc-steplist">${m.tasks.map((t) => `<button class="osc-step" data-node="${E(t.id)}">${ic(t)}<span class="tid">${E(t.id)}</span><span class="tt">${E(t.title)}</span>${engDot(t.engine)}</button>`).join('')}</div></details>`);
    };
    // composer: Enter envia, Shift+Enter quebra linha, @ autocompleta
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
    const engs = () => (c.meta.engines && c.meta.engines.length ? c.meta.engines : AI_IDS);
    const acUpdate = () => {
      const pre = ta.value.slice(0, ta.selectionStart);
      const mm = pre.match(/(^|\s)@(\w*)$/);
      c.ac = mm ? engs().filter((id) => id.startsWith(mm[2].toLowerCase())) : [];
      c.acSel = Math.min(c.acSel, Math.max(0, c.ac.length - 1));
      acEl.hidden = !c.ac.length;
      acEl.innerHTML = c.ac.map((id, i) => `<button class="${i === c.acSel ? 'on' : ''}" data-ac="${id}">${avatar(id)}<b>@${id}</b><span>${E(engName(id))}${c.meta.lead === id ? ' · Arquiteto' : ''}</span></button>`).join('');
    };
    const acPick = (id) => {
      const pos = ta.selectionStart, pre = ta.value.slice(0, pos).replace(/@(\w*)$/, '@' + id + ' ');
      ta.value = pre + ta.value.slice(pos); ta.setSelectionRange(pre.length, pre.length);
      c.ac = []; acEl.hidden = true; ta.focus(); ls.set('cdraft.' + c.mid, ta.value);
    };
    acEl.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-ac]'); if (b) { e.preventDefault(); acPick(b.dataset.ac); } });
    ta.addEventListener('input', () => { grow(); acUpdate(); if (c.mid) ls.set('cdraft.' + c.mid, ta.value); });
    ta.addEventListener('blur', () => setTimeout(() => { acEl.hidden = true; }, 120));
    ta.addEventListener('keydown', (e) => {
      if (c.ac.length && !acEl.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); c.acSel = (c.acSel + (e.key === 'ArrowDown' ? 1 : c.ac.length - 1)) % c.ac.length; acUpdate(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acPick(c.ac[c.acSel]); return; }
        if (e.key === 'Escape') { acEl.hidden = true; c.ac = []; return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); c.send(); }
    });
    Q('.osc-send', host).onclick = () => c.send();
    c.send = async () => {
      const text = ta.value.trim();
      if (!text || !c.mid || c.sending) return;
      c.sending = true; Q('.osc-send', host).disabled = true;
      try {
        await api(`/api/missions/${c.mid}/chat`, { method: 'POST', body: { text } });
        ta.value = ''; grow(); ls.set('cdraft.' + c.mid, '');
        c.atBottom = true; await c.poll(); c.toBottom(true);
      } catch (e) { say(e.message); }
      finally { c.sending = false; Q('.osc-send', host).disabled = false; }
    };
    c.focus = () => ta.focus();
    return c;
  }

  // ------------------------------------------------------------------ popup flutuante global + mini-janela
  const P = { open: ls.get('pop.open', false), mid: ls.get('pop.mid', null), chat: null, mission: null, misAt: 0, mini: null, built: false };
  function popMissions() {
    const act = S.missions.filter((m) => ACTIVE.includes(m.state) || m.state === 'aguardando');
    const cur = S.missions.find((m) => m.id === P.mid);
    return cur && !act.includes(cur) ? [cur, ...act] : act;
  }
  function pickPopMission() {
    if (P.mini) return P.mini;
    if (P.mid && S.missions.some((m) => m.id === P.mid)) return P.mid;
    const a = S.missions.find((m) => ACTIVE.includes(m.state)) || S.missions[0];
    return a ? a.id : null;
  }
  function initFloat() {
    const mini = (location.search.match(/[?&]mini=([\w-]+)/) || [])[1] || null;
    P.mini = mini;
    const box = document.createElement('div');
    box.id = mini ? 'agyMini' : 'agyFloat';
    box.className = 'os-vars' + (mini ? ' mini' : '');
    box.innerHTML = `
      ${mini ? '' : `<button class="osf-run" id="osfRun" hidden><i></i><span>Agentes rodando</span><b class="num" id="osfRunN">0</b></button>
      <button class="osf-fab" id="osfFab" hidden aria-label="Abrir o chat da equipe"><span class="osf-stack" id="osfStack"></span><b class="osf-n" id="osfN" hidden>0</b></button>`}
      <section class="osf-pop" id="osfPop" ${mini ? '' : 'hidden'} aria-label="Chat da equipe">
        <header class="osf-h">
          <div class="osf-ht"><b id="osfTitle">Agente OS</b><div class="osf-sub"><span id="osfState"></span><span class="os-prog"><i id="osfProg"></i></span><span class="num" id="osfCount"></span><span class="osf-tok num" id="osfTok"></span></div>
            <select id="osfSel" hidden aria-label="Escolher missão"></select></div>
          <div class="osf-hb">
            ${mini ? '' : '<button class="os-ib" id="osfFull" title="Abrir a missão completa">⤢</button><button class="os-ib" id="osfMini" title="Janela flutuante">⧉</button>'}
            <button class="os-ib" id="osfClose" title="${mini ? 'Fechar janela' : 'Fechar'}">${IC.x}</button>
          </div>
        </header>
        <div class="osf-body" id="osfBody"></div>
      </section>`;
    document.body.appendChild(box);
    if (mini) document.body.classList.add('agy-mini');
    else { // selo "Agentes rodando" dentro da barra superior do app, se ela existir
      const run = Q('#osfRun'), anchor = Q('#tconn');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(run, anchor); else run.classList.add('fixed');
    }
    P.chat = makeChat(Q('#osfBody'), { getMission: () => P.mission, isVisible: () => (P.open || !!P.mini) && !document.hidden, onUpdate: renderFloat });
    Q('#osfBody').addEventListener('click', (e) => { const n = e.target.closest('[data-node]'); if (n) openTask(P.chat.mid, n.dataset.node); });
    Q('#osfClose').onclick = () => { if (P.mini) { window.close(); return; } setPop(false); };
    if (!mini) {
      Q('#osfFab').onclick = () => setPop(true);
      Q('#osfRun').onclick = () => setPop(true);
      Q('#osfFull').onclick = () => { const id = P.chat.mid; setPop(false); go('os'); const f = () => { if (!S.built) return setTimeout(f, 50); select(id); setTab('chat'); }; f(); };
      Q('#osfMini').onclick = () => openMini(P.chat.mid);
    }
    Q('#osfSel').onchange = (e) => { P.mid = e.target.value; ls.set('pop.mid', P.mid); P.mission = null; P.chat.set(P.mid); renderFloat(); };
    P.built = true;
    if (mini) { P.open = true; P.chat.set(mini); }
    else if (P.open) { Q('#osfPop').hidden = false; }
    loadList();
  }
  function setPop(open) {
    P.open = open; ls.set('pop.open', open);
    Q('#osfPop').hidden = !open;
    if (open) {
      const id = pickPopMission();
      if (id && id !== P.chat.mid) { P.mid = id; ls.set('pop.mid', id); P.mission = null; P.chat.set(id); }
      else if (P.chat.mid) { P.chat.poll(); P.chat.toBottom(); }
      setTimeout(() => P.chat.focus(), 80);
    }
    renderFloat();
  }
  function openPop(id) { if (id) { P.mid = id; ls.set('pop.mid', id); P.mission = null; P.chat.set(id); } setPop(true); }
  function openMini(id) {
    if (!id) return say('Escolha uma missão.');
    if (window.agyDesktop && typeof window.agyDesktop.openMini === 'function') { window.agyDesktop.openMini(id); return; }
    const w = window.open('/?mini=' + encodeURIComponent(id), 'agymini', 'width=420,height=680');
    if (!w) say('O navegador bloqueou a janela. Libere pop-ups para este endereço.');
  }
  function openTask(mid, tid) {
    if (!mid) return;
    if (P.mini) { window.open('/', '_blank'); return; }
    setPop(false); go('os');
    const f = () => {
      if (!S.built) return setTimeout(f, 50);
      if (S.sel !== mid) select(mid);
      setTab('ov');
      const g = () => { if (!S.mission || S.mission.id !== mid) return setTimeout(g, 120); setPanel(tid); };
      g();
    };
    f();
  }
  async function loadPopMission() {
    const id = P.chat && P.chat.mid; if (!id) return;
    P.misAt = Date.now();
    try { const d = await api('/api/missions/' + id); if (P.chat.mid === id) { P.mission = d.mission; P.chat.renderSteps(); renderFloat(); } } catch {}
  }
  function floatTick(now) {
    if (!P.built || !P.chat) return;
    const vis = (P.open || P.mini) && !document.hidden;
    if (!P.chat.mid && !P.mini && S.loaded) {
      const id = pickPopMission();
      if (id && (P.open || S.missions.some((m) => ACTIVE.includes(m.state)))) { P.mid = id; ls.set('pop.mid', id); P.chat.set(id); renderFloat(); }
    }
    if (P.chat.mid && now - P.chat.at >= (vis ? 1500 : 6000)) P.chat.poll();
    if (vis && P.chat.mid && now - P.misAt >= 4000) loadPopMission();
    if (P.mini && now - S.listAt >= 5000) loadList();
    if (ticks % 2 === 0) renderFloat();
  }
  function renderFloat() {
    if (!P.built) return;
    const act = S.missions.filter((m) => ACTIVE.includes(m.state));
    const c = P.chat;
    const sm = S.missions.find((m) => m.id === (c && c.mid));
    const pm = P.mission && c && P.mission.id === c.mid ? P.mission : null;
    // cabeçalho do popup
    const title = (pm && pm.title) || (sm && sm.title) || (c && c.meta.title) || 'Agente OS';
    const st = (pm && pm.state) || (sm && sm.state) || (c && c.meta.state);
    const done = c && c.meta.total != null ? c.meta.done : sm ? sm.done : 0, total = c && c.meta.total != null ? c.meta.total : sm ? sm.total : 0;
    Q('#osfTitle').textContent = c && c.mid ? title : 'Nenhuma missão';
    const [stT, stC] = M_ST[st] || ['', 'off'];
    Q('#osfState').innerHTML = st ? `<span class="os-st s-${stC}"><i></i>${E(stT)}</span>` : '';
    Q('#osfProg').style.width = (total ? done / total * 100 : 0) + '%';
    Q('#osfCount').textContent = total ? `${done}/${total}` : '';
    const tu = c && c.meta.tokensUsed != null ? c.meta.tokensUsed : sm ? sm.tokensUsed : null, tm = c && c.meta.maxTokens != null ? c.meta.maxTokens : sm ? sm.maxTokens : null;
    const tt = c && c.mid && tu != null ? '🎯 ' + tok(tu) + ' / ' + limTxt(tm) : '';
    Q('#osfTok').textContent = tt; Q('#osfTok').title = 'Tokens usados / limite da missão'; Q('#osfTok').classList.toggle('over', !!(tm && tu >= tm));
    const opts = popMissions();
    const sel = Q('#osfSel');
    sel.hidden = P.mini || opts.length < 2;
    const oh = opts.map((m) => `<option value="${m.id}" ${c && m.id === c.mid ? 'selected' : ''}>${E((M_ST[m.state] || [''])[0])} · ${E(m.title.slice(0, 50))}</option>`).join('');
    if (sel._h !== oh) { sel.innerHTML = oh; sel._h = oh; }
    if (P.mini) { document.title = '💬 ' + title; return; }
    if (!c || !c.mid) { Q('#osfBody').classList.add('empty'); } else Q('#osfBody').classList.remove('empty');
    // selo "Agentes rodando" e botão flutuante
    const running = act.reduce((a, m) => a + (m.running || 0), 0) || act.length;
    Q('#osfRun').hidden = !act.length || P.open;
    Q('#osfRunN').textContent = running;
    const unread = c && c.mid ? c.unread() : 0;
    const inOsChat = state.view === 'os' && S.sel && S.tab === 'chat';
    const showFab = !P.open && !inOsChat && (act.length > 0 || unread > 0);
    Q('#osfFab').hidden = !showFab;
    const engs = [...new Set((act.length ? act : sm ? [sm] : []).flatMap((m) => m.engines || []))].slice(0, 3);
    const stack = (engs.length ? engs : ['claude']).map((id) => avatar(id)).join('');
    if (Q('#osfStack')._h !== stack) { Q('#osfStack').innerHTML = stack; Q('#osfStack')._h = stack; }
    Q('#osfN').hidden = !unread; Q('#osfN').textContent = unread > 99 ? '99+' : unread;
    Q('#osfFab').classList.toggle('live', act.length > 0);
  }

  // ------------------------------------------------------------------ ciclo de atualização
  let ticks = 0;
  function tick() {
    if (typeof state === "undefined" || !state.token) return; // espera o app obter o token (evita 401 no carregamento)
    if (document.hidden) return;
    const now = Date.now();
    ticks++;
    const anyActive = S.missions.some((m) => ACTIVE.includes(m.state));
    if (visible() && S.built) {
      if (S.sel && now - S.detAt >= 2000) loadDetail();
      if (now - S.listAt >= 5000) loadList();
      if (!S.sel && now - AU.at >= 10000) loadAutos();
      else if (!S.sel && ticks % 20 === 0) renderAutos();
      if (!S.sel && ticks % 8 === 0 && Q('#osCar')) { S.carousel++; paintCarousel(); }
    } else if (now - S.listAt >= (anyActive || P.open ? 5000 : 30000)) loadList(); // badge, selo e popup
    if (DC && DC.mid && DC.opts.isVisible() && now - DC.at >= 1500) DC.poll();
    floatTick(now);
  }

  async function open() {
    if (!S.built && !build()) return;
    if (!state.token) { setTimeout(open, 300); return; }
    if (!state.info) { try { state.info = await api('/api/info'); } catch {} }
    if (!(state.engines || []).length) { try { const d = await api('/api/engines'); state.engines = d.engines || []; } catch {} }
    renderPills(); renderTeam(); renderList(); renderAutos(); loadAutos();
    select(S.sel || null);
    S.statsAt = 0; loadList();
  }

  function prefill(text) {
    if (state.view !== 'os') go('os'); else open();
    const fill = () => { if (!S.built) return setTimeout(fill, 50); newMission(String(text || '')); };
    fill();
  }

  setInterval(tick, 500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { S.listAt = 0; S.detAt = 0; tick(); } });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.panel && state.view === 'os' && !Q('#layer .overlay')) setPanel(null); });
  window.AgentOS = { open, prefill, openChat: (id) => openPop(id), refresh: () => { loadList(); loadDetail(); } };
  try { if (typeof state !== 'undefined' && state.view === 'os') open(); } catch {}
  try { initFloat(); } catch (e) { console.warn('Agente OS: popup', e); }
  setTimeout(loadList, 1500); // badge inicial
})();
