'use strict';
// Utilità per la suite di sicurezza: avvia l'app vera (src/app.js) su una porta libera con una cartella dati temporanea.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { once } = require('events');
const { createApp } = require('../../src/app');

const PIN = '482913';
function quietLogger() { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }; }
async function boot(env = {}, dir = null) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sbsec-'));
  const logger = quietLogger();
  const ctx = createApp({ dataDir: d, env: { SETUP_PIN: PIN, ...env }, logger });
  const server = ctx.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, ctx, dir: d, base, logger, async close() { await new Promise((r) => server.close(r)); server.closeAllConnections && server.closeAllConnections(); ctx.engine.stop(); } };
}
async function req(base, p, { method = 'GET', body, cookie, headers = {}, raw, ip } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = `sb_session=${cookie}`;
  if (ip) h['x-forwarded-for'] = ip;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); if (!h['content-type']) h['content-type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  const sc = r.headers.get('set-cookie') || ''; const m = /sb_session=([a-f0-9]{64})/.exec(sc);
  return { status: r.status, headers: r.headers, text, json, setCookie: sc, token: m ? m[1] : null };
}
const post = (base, p, body, o = {}) => req(base, p, { method: 'POST', body, ...o, headers: { 'x-sb': '1', ...(o.headers || {}) } });
async function login(base, pin = PIN, o = {}) {
  const r = await post(base, '/api/auth/login', { pin }, o);
  return { ...r, cookie: r.token, csrf: r.json && r.json.csrf };
}
// POST autenticato con tutti gli header giusti
const apost = (base, s, p, body, o = {}) => post(base, p, body, { cookie: s.cookie, ...o, headers: { 'x-csrf': s.csrf, ...(o.headers || {}) } });
// tutte le rotte /api registrate nell'app (per i test di accesso senza sessione)
function routes(app) {
  const out = [];
  for (const l of app._router.stack) if (l.route && l.route.path.startsWith('/api')) for (const m of Object.keys(l.route.methods)) if (m !== '_all') out.push({ method: m.toUpperCase(), path: l.route.path });
  return out;
}
module.exports = { PIN, boot, req, post, apost, login, routes, quietLogger };
