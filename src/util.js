'use strict';
// Utility condivise: fetch con timeout/retry, coda a velocità limitata, formattazione.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TLS obbligatorio per ogni chiamata di rete in uscita (API, RPC, notizie): solo https, tranne localhost per i test
function assertTls(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error('URL non valido'); }
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.toString();
  throw new Error(`connessione non cifrata rifiutata (${u.protocol}//${u.hostname}): serve https`);
}
async function fetchJson(url, opts = {}) {
  assertTls(url);
  const { timeout = 12000, retries = 1, method = 'GET', body, headers = {} } = opts;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${(json && (json.error || json.message)) || text.slice(0, 160)}`);
        err.status = res.status; err.body = json;
        if (res.status === 429 || res.status >= 500) { lastErr = err; await sleep(800 * (i + 1)); continue; }
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (i < retries) await sleep(600 * (i + 1));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

// Testo (RSS/XML) con timeout; segue i redirect
async function fetchText(url, { timeout = 12000, headers = {} } = {}) {
  assertTls(url);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (grokbot-solana)', accept: 'application/rss+xml, application/xml, text/xml, */*', ...headers }, redirect: 'follow', signal: ctrl.signal });
    if (res.url) assertTls(res.url); // anche dopo un redirect
    const text = await res.text();
    if (!res.ok) { const e = new Error(`HTTP ${res.status} ${url.split('?')[0]}`); e.status = res.status; throw e; }
    return text;
  } finally { clearTimeout(t); }
}

// Coda che esegue al massimo una chiamata ogni `gapMs` (per API gratuite con limiti).
function rateQueue(gapMs) {
  let chain = Promise.resolve();
  let last = 0;
  return function run(fn) {
    const p = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = p.catch(() => {});
    return p;
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (x, d = 6) => { const m = 10 ** d; return Math.round(x * m) / m; };
const short = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');
const nowIso = () => new Date().toISOString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = { assertTls, sleep, fetchJson, fetchText, rateQueue, clamp, round, short, nowIso, uid };
