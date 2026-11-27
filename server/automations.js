// Automações agendadas do Agy Remote (como as Automations do Codex e o /schedule do Antigravity).
//
// store.automations = [{ id, name, kind:'mission'|'prompt', goal, cwd, engines, lead, cheap, skip,
//   schedule: {type:'interval', minutes} | {type:'daily', time:'HH:MM', days:[0-6]} | {type:'once', at:ts},
//   enabled, lastRun, nextRun, history:[{ts, missionId|convId, state}] }]
//
// O agendador confere a cada 30 s. 'mission' cria uma missão do Agente OS (agentOS.start); 'prompt' roda um
// prompt avulso numa conversa nova (startRun), com o modelo mais barato da IA se `cheap`.
// Nunca roda a mesma automação duas vezes ao mesmo tempo. Ao reiniciar o servidor o nextRun é recalculado
// sem disparar o que já passou ('once' perdido fica marcado como "perdida").
'use strict';

const fs = require('fs');
const crypto = require('crypto');

module.exports = function createAutomations(d) {
  const { store, persist, agentOS, startRun, ENGINES, usableEngines, broadcast } = d;
  if (!Array.isArray(store.automations)) store.automations = [];
  const A = store.automations;
  const now = () => Date.now();
  const MIN = 60e3;
  const ACTIVE_M = new Set(['planejando', 'executando', 'verificando', 'integrando', 'aguardando', 'pausado_limite']);

  // ---------------------------------------------------------------- agenda
  function parseTime(s) { const mm = String(s || '').match(/^(\d{1,2}):(\d{2})$/); if (!mm) return null; const h = +mm[1], m = +mm[2]; return h < 24 && m < 60 ? [h, m] : null; }
  function cleanSchedule(s) {
    s = s || {};
    if (s.type === 'interval') { const minutes = Math.round(Number(s.minutes)); if (!(minutes >= 1 && minutes <= 60 * 24 * 31)) throw new Error('Intervalo inválido (1 min a 31 dias).'); return { type: 'interval', minutes }; }
    if (s.type === 'daily') {
      if (!parseTime(s.time)) throw new Error('Horário inválido (use HH:MM).');
      const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter((x) => x >= 0 && x <= 6))].sort();
      return { type: 'daily', time: String(s.time).padStart(5, '0'), days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
    }
    if (s.type === 'once') { const at = typeof s.at === 'string' && !/^\d+$/.test(s.at) ? Date.parse(s.at) : Number(s.at); if (!(at > 0)) throw new Error('Data inválida.'); return { type: 'once', at }; }
    throw new Error('Agenda inválida.');
  }
  // próximo disparo estritamente depois de `from`
  function computeNext(a, from) {
    const s = a.schedule || {};
    if (s.type === 'interval') {
      const step = s.minutes * MIN;
      if (a.lastRun) { let n = a.lastRun + step; if (n <= from) n += Math.ceil((from - n + 1) / step) * step; return n; }
      return from + step;
    }
    if (s.type === 'daily') {
      const [h, m] = parseTime(s.time) || [9, 0];
      const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
      const base = new Date(from);
      for (let i = 0; i <= 8; i++) {
        const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
        if (c.getTime() > from && days.includes(c.getDay())) return c.getTime();
      }
      return null;
    }
    if (s.type === 'once') return s.at > from ? s.at : null; // depois do disparo agendado ela é desligada
    return null;
  }

  // ---------------------------------------------------------------- execução
  const running = new Set(); // ids disparados nesta execução do servidor e ainda rodando
  function isRunning(a) {
    if (running.has(a.id)) return true;
    const h = (a.history || [])[0];
    if (h && h.missionId && store.missions && store.missions[h.missionId] && ACTIVE_M.has(store.missions[h.missionId].state)) return true;
    return false;
  }
  function push(a, entry) {
    (a.history || (a.history = [])).unshift(entry);
    if (a.history.length > 30) a.history.length = 30;
  }
  function pickEngine(a) {
    const usable = usableEngines();
    const list = (Array.isArray(a.engines) && a.engines.length ? a.engines : usable).filter((e) => usable.includes(e));
    if (a.lead && list.includes(a.lead)) return a.lead;
    return list[0] || usable[0] || null;
  }

  async function fire(a, manual) {
    if (isRunning(a)) throw new Error('Esta automação ainda está rodando.');
    running.add(a.id);
    a.lastRun = now();
    if (!manual) a.nextRun = computeNext(a, a.lastRun);
    if (a.schedule && a.schedule.type === 'once' && !manual) { a.enabled = false; a.nextRun = null; }
    const entry = { ts: a.lastRun, state: 'rodando', manual: !!manual };
    push(a, entry); persist();
    try {
      if (!fs.existsSync(a.cwd)) throw new Error('Pasta não existe: ' + a.cwd);
      if (a.kind === 'mission') {
        const m = await agentOS.start({ goal: a.goal, cwd: a.cwd, engines: a.engines, lead: a.lead, cheap: a.cheap !== false, skip: a.skip === true,
          verify: a.verify !== false, parallel: a.parallel || 2, title: '⏰ ' + a.name, isolate: a.isolate, maxTokens: a.maxTokens, automationId: a.id, device: 'automacao' });
        entry.missionId = m.id; entry.state = m.state;
        running.delete(a.id); // a partir daqui "rodando" vem do estado da missão
      } else {
        const engine = pickEngine(a);
        if (!engine) throw new Error('Nenhuma IA ligada e instalada.');
        const model = a.cheap !== false && ENGINES[engine] && ENGINES[engine].cheap ? ENGINES[engine].cheap : undefined;
        const r = startRun({ prompt: a.goal, cwd: a.cwd, engine, model, mode: a.skip === true ? undefined : 'edit', skipPermissions: a.skip === true,
          device: 'automacao', title: '⏰ ' + a.name, label: '⏰ ' + a.name });
        entry.convId = r.convId; entry.engine = engine;
        const c = store.conversations[r.convId]; if (c) c.automationId = a.id;
        const done = (res) => {
          running.delete(a.id);
          entry.state = res.status === 'SUCCESS' ? 'ok' : res.status === 'CANCELLED' ? 'cancelado' : 'erro';
          entry.text = String(res.text || res.error || '').replace(/\s+/g, ' ').slice(0, 240);
          entry.finishedAt = now(); persist();
        };
        if (r.done) { const last = c && c.messages[c.messages.length - 1]; done({ status: last ? last.status : 'ERROR', text: last ? last.text : '' }); }
        else r.onDone = done;
      }
    } catch (e) {
      running.delete(a.id);
      entry.state = 'erro'; entry.error = String(e.message || e).slice(0, 300);
      broadcast({ type: 'blocked', title: '⏰ ' + a.name, status: 'erro', text: 'Automação falhou: ' + entry.error, denied: [] });
    }
    persist();
    return entry;
  }

  function refreshStates() {
    let changed = false;
    for (const a of A) for (const h of a.history || []) {
      if (!h.missionId) continue;
      const m = store.missions && store.missions[h.missionId];
      const st = m ? m.state : 'apagada';
      if (h.state !== st) { h.state = st; changed = true; }
    }
    if (changed) persist();
  }

  function tick() {
    const t = now();
    refreshStates();
    for (const a of A) {
      if (!a.enabled || !a.nextRun || a.nextRun > t) continue;
      if (isRunning(a)) {
        push(a, { ts: t, state: 'pulada', error: 'A execução anterior ainda estava rodando' });
        a.nextRun = computeNext(a, t); persist();
        continue;
      }
      fire(a, false).catch(() => {});
    }
  }

  // ao reiniciar: recalcula sem disparar o que já passou
  (function boot() {
    const t = now();
    for (const a of A) {
      for (const h of a.history || []) if (h.state === 'rodando' && h.convId) h.state = 'interrompido';
      if (!a.enabled) { a.nextRun = null; continue; }
      if (a.schedule && a.schedule.type === 'once' && a.schedule.at <= t) {
        push(a, { ts: t, state: 'perdida', error: 'O servidor estava desligado na hora marcada' });
        a.enabled = false; a.nextRun = null; continue;
      }
      a.nextRun = computeNext(a, t);
    }
    persist();
  })();
  const timer = setInterval(tick, 30e3);
  if (timer.unref) timer.unref();
  setTimeout(tick, 5000).unref?.();

  // ---------------------------------------------------------------- API
  function clean(b, prev) {
    const o = Object.assign({}, prev || {});
    if (b.name !== undefined || !prev) { o.name = String(b.name || '').trim().slice(0, 80); if (!o.name) throw new Error('Dê um nome para a automação.'); }
    if (b.kind !== undefined || !prev) o.kind = b.kind === 'prompt' ? 'prompt' : 'mission';
    if (b.goal !== undefined || !prev) { o.goal = String(b.goal || '').trim().slice(0, 8000); if (!o.goal) throw new Error(o.kind === 'prompt' ? 'Escreva o prompt.' : 'Escreva o objetivo da missão.'); }
    if (b.cwd !== undefined || !prev) { o.cwd = String(b.cwd || '').trim(); if (!o.cwd || !fs.existsSync(o.cwd)) throw new Error('Pasta não existe: ' + (o.cwd || '(vazia)')); }
    if (b.engines !== undefined) o.engines = (Array.isArray(b.engines) ? b.engines : []).filter((e) => ENGINES[e]);
    if (b.lead !== undefined) o.lead = ENGINES[b.lead] ? b.lead : null;
    for (const k of ['cheap', 'skip', 'verify', 'isolate']) if (b[k] !== undefined) o[k] = !!b[k];
    if (!prev) { if (o.cheap === undefined) o.cheap = true; if (o.skip === undefined) o.skip = false; }
    if (b.maxTokens !== undefined) o.maxTokens = Math.max(0, Math.round(Number(b.maxTokens) || 0)) || undefined;
    if (b.parallel !== undefined) o.parallel = Math.max(1, Math.min(4, Number(b.parallel) || 2));
    if (b.schedule !== undefined || !prev) o.schedule = cleanSchedule(b.schedule);
    if (b.enabled !== undefined) o.enabled = !!b.enabled; else if (!prev) o.enabled = true;
    return o;
  }
  function view(a) {
    return { ...a, running: isRunning(a),
      history: (a.history || []).map((h) => ({ ...h, title: h.missionId && store.missions && store.missions[h.missionId] ? store.missions[h.missionId].title : undefined })) };
  }

  async function route(req, res, url, p, readBody, send) {
    if (p === '/api/automations' && req.method === 'GET') {
      refreshStates();
      return send(res, 200, { automations: A.map(view), now: now() }), true;
    }
    if (p === '/api/automations' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const a = clean(b, null);
        a.id = crypto.randomBytes(6).toString('hex'); a.createdAt = now(); a.lastRun = null; a.history = [];
        a.nextRun = a.enabled ? computeNext(a, now()) : null;
        if (a.schedule.type === 'once' && !a.nextRun) throw new Error('Escolha uma data no futuro.');
        A.push(a); persist();
        return send(res, 200, { automation: view(a) }), true;
      } catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    const mm = p.match(/^\/api\/automations\/([\w-]+)(?:\/(run|toggle))?$/);
    if (!mm) return false;
    const i = A.findIndex((x) => x.id === mm[1]);
    if (i < 0) return send(res, 404, { error: 'Automação não encontrada' }), true;
    const a = A[i];
    const act = mm[2];
    if (!act && req.method === 'GET') return send(res, 200, { automation: view(a) }), true;
    if (!act && req.method === 'DELETE') { A.splice(i, 1); running.delete(a.id); persist(); return send(res, 200, { ok: true }), true; }
    if (!act && req.method === 'PUT') {
      try {
        const b = await readBody(req);
        const o = clean(b, a);
        Object.assign(a, o);
        a.nextRun = a.enabled ? computeNext(a, now()) : null;
        if (a.enabled && !a.nextRun && a.schedule.type === 'once') { a.enabled = false; }
        a.updatedAt = now(); persist();
        return send(res, 200, { automation: view(a) }), true;
      } catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não suportado' }), true;
    if (act === 'toggle') {
      const b = await readBody(req).catch(() => ({}));
      a.enabled = b && b.enabled !== undefined ? !!b.enabled : !a.enabled;
      a.nextRun = a.enabled ? computeNext(a, now()) : null;
      if (a.enabled && !a.nextRun) { a.enabled = false; persist(); return send(res, 400, { error: 'A data marcada já passou. Edite a automação para escolher outra.' }), true; }
      persist();
      return send(res, 200, { automation: view(a) }), true;
    }
    if (act === 'run') {
      try { const entry = await fire(a, true); return send(res, 200, { ok: true, entry, automation: view(a) }), true; }
      catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    return false;
  }

  return { route, tick, list: () => A.map(view) };
};
