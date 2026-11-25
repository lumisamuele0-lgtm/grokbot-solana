'use strict';
// Intestazioni di sicurezza (stile helmet) su pagine, API e errori
const test = require('node:test'); const assert = require('node:assert');
const { boot, req, login } = require('./helpers');

function checkCommon(h, where) {
  const csp = h.get('content-security-policy') || '';
  for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(csp.includes(d), `${where}: CSP senza ${d}`);
  assert.ok(!/script-src[^;]*unsafe-(inline|eval)/.test(csp), `${where}: niente script inline/eval`);
  assert.strictEqual(h.get('x-frame-options'), 'DENY', where);
  assert.strictEqual(h.get('x-content-type-options'), 'nosniff', where);
  assert.strictEqual(h.get('referrer-policy'), 'no-referrer', where);
  assert.match(h.get('permissions-policy') || '', /camera=\(\).*geolocation=\(\)/, where);
  assert.strictEqual(h.get('cross-origin-opener-policy'), 'same-origin', where);
  assert.strictEqual(h.get('cross-origin-resource-policy'), 'same-origin', where);
  assert.strictEqual(h.get('x-powered-by'), null, `${where}: niente X-Powered-By`);
  assert.strictEqual(h.get('access-control-allow-origin'), null, `${where}: niente CORS`);
}

test('pagine, API, 404 ed errori hanno tutte le intestazioni di sicurezza', async () => {
  const s = await boot();
  try {
    for (const p of ['/', '/app.js', '/healthz', '/api/auth/status', '/api/state', '/nonesiste', '/api/research/status']) checkCommon((await req(s.base, p)).headers, p);
    const l = await login(s.base);
    const api = await req(s.base, '/api/state', { cookie: l.cookie }); checkCommon(api.headers, 'api'); assert.match(api.headers.get('cache-control'), /no-store/);
    const bad = await req(s.base, '/api/auth/login', { method: 'POST', raw: '{bad', headers: { 'content-type': 'application/json', 'x-sb': '1' } }); checkCommon(bad.headers, 'errore');
    assert.strictEqual(api.headers.get('strict-transport-security'), null, 'HSTS solo su HTTPS');
  } finally { await s.close(); }
});

test('HSTS (2 anni, sottodomini) e redirect a https con FORCE_HTTPS', async () => {
  const s = await boot({ FORCE_HTTPS: '1' });
  try {
    const r = await req(s.base, '/', { headers: { 'x-forwarded-proto': 'https' } }); assert.match(r.headers.get('strict-transport-security') || '', /max-age=63072000; includeSubDomains/);
    const h = await req(s.base, '/', { headers: { 'x-forwarded-proto': 'http' } }); assert.strictEqual(h.status, 301); assert.match(h.headers.get('location'), /^https:\/\//);
  } finally { await s.close(); }
});

test('metodi non ammessi (PUT, DELETE, PATCH, OPTIONS, TRACE) → 405', async () => {
  const s = await boot();
  try { for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) { const r = await req(s.base, '/api/state', { method: m }); assert.strictEqual(r.status, 405, m); } } finally { await s.close(); }
});
