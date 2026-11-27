// Regras de rede e pareamento (funções puras, sem efeitos colaterais).
'use strict';

// Acesso pela rede local só com opt-in: AGY_REMOTE_LAN=1 ou "lan": true no config.json.
// A variável de ambiente, quando definida, vale mais que o arquivo.
function lanEnabled(env, config) {
  const v = String(env.AGY_REMOTE_LAN || '').trim().toLowerCase();
  if (v) return v === '1' || v === 'true';
  return config.lan === true;
}

// Contra DNS rebinding: um site malicioso chega com o domínio dele no Host. Aceitamos só IP literal,
// localhost, o nome deste PC, nomes do Tailscale e o que estiver em "allowedHosts" no config.json.
function isTrustedHost(hostHeader, hostname, extra) {
  const m = String(hostHeader || '').toLowerCase().match(/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(:\d{1,5})?$/);
  if (!m) return false;
  const h = m[1], me = String(hostname || '').toLowerCase();
  if (h.startsWith('[') || h === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
  if (me && (h === me || h === me + '.local')) return true;
  if (h.endsWith('.ts.net')) return true;
  return Array.isArray(extra) && extra.some((x) => String(x).toLowerCase() === h);
}

// Contra CSRF: se o navegador mandar Origin, ele tem que ser o próprio endereço do servidor.
function isSameOrigin(origin, hostHeader) {
  if (!origin) return true;
  try { return new URL(origin).host === String(hostHeader || '').toLowerCase(); } catch { return false; }
}

// Limite de tentativas de pareamento: por endereço (um aparelho não trava os outros) e global
// (a força bruta continua limitada mesmo trocando de endereço).
function createPairLimiter({ perAddress = 10, global = 50, windowMs = 10 * 60 * 1000 } = {}) {
  const attempts = [];
  return function allow(address, now = Date.now()) {
    while (attempts.length && now - attempts[0].at > windowMs) attempts.shift();
    if (attempts.length >= global || attempts.filter((a) => a.address === address).length >= perAddress) return false;
    attempts.push({ at: now, address });
    return true;
  };
}

module.exports = { lanEnabled, isTrustedHost, isSameOrigin, createPairLimiter };
