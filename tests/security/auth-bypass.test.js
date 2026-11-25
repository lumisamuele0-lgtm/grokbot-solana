'use strict';
// Tentativi di entrare senza PIN su OGNI rotta /api, token falsi, percorsi per leggere i file dati
const test = require('node:test'); const assert = require('node:assert');
const { boot, req, post, routes, login } = require('./helpers');

const PUBLIC = new Set(['GET /api/research/status', 'GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/setup', 'POST /api/auth/logout']);

test('ogni rotta /api privata risponde 401 senza sessione, con token inventati o malformati', async () => {
  const s = await boot();
  try {
    const all = routes(s.app); assert.ok(all.length >= 20, `rotte trovate: ${all.length}`);
    const fakes = [undefined, 'a'.repeat(64), 'f'.repeat(64), '0'.repeat(63), 'g'.repeat(64), "' OR 1=1 --", '../../auth.json'];
    for (const r of all) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      for (const c of fakes) {
        const o = { headers: { 'x-sb': '1', cookie: c === undefined ? '' : `sb_session=${c}` } };
        const res = r.method === 'GET' ? await req(s.base, r.path, o) : await req(s.base, r.path, { method: 'POST', body: {}, ...o });
        assert.strictEqual(res.status, 401, `${r.method} ${r.path} con cookie ${String(c).slice(0, 10)} → ${res.status}`);
        assert.ok(!/publicKey|positions|walletEncJson|secret/.test(res.text), `${r.path}: nessun dato senza accesso`);
      }
    }
    // rotte inesistenti: nessuna informazione
    assert.strictEqual((await req(s.base, '/api/../api/state')).status, 401);
    assert.strictEqual((await req(s.base, '/api/admin')).status, 401);
  } finally { await s.close(); }
});

test('rotte pubbliche: nessun dato sensibile', async () => {
  const s = await boot();
  try {
    const st = await req(s.base, '/api/auth/status'); assert.strictEqual(st.status, 200); assert.strictEqual(st.json.setup, true); assert.strictEqual(st.json.loggedIn, false); assert.ok(!('csrf' in st.json));
    const rs = await req(s.base, '/api/research/status'); assert.strictEqual(rs.status, 200); assert.ok(!/pinHash|salt|wallet|publicKey|sessions/.test(rs.text));
  } finally { await s.close(); }
});

test('percorsi (path traversal): i file dati, la chiave e il codice non sono mai serviti', async () => {
  const s = await boot();
  try {
    const paths = ['/data/auth.json', '/auth.json', '/config.json', '/state.json', '/.sb-datakey', '/wallet.enc.json', '/../data/auth.json', '/..%2fdata%2fauth.json', '/%2e%2e/%2e%2e/etc/passwd', '/..%5c..%5cserver.js',
      '/server.js', '/package.json', '/src/auth.js', '/src/store.js', '/.git/config', '/.env', '/node_modules/express/package.json', '/public/../server.js', '/vendor/../server.js', '/%00', '/index.html%00.js'];
    for (const p of paths) {
      const r = await req(s.base, p);
      assert.ok(r.status === 404 || r.status === 400 || r.status === 403, `${p} → ${r.status}`);
      assert.ok(!/pinHash|sbenc|"ct"|require\(|root:x:|"dependencies"/.test(r.text), `${p}: contenuto riservato servito`);
    }
    assert.strictEqual((await req(s.base, '/')).status, 200); // l'app si apre normalmente
  } finally { await s.close(); }
});

test('con la sessione giusta le rotte rispondono (controllo di non regressione)', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); assert.strictEqual(l.status, 200); assert.ok(l.cookie && l.csrf);
    assert.strictEqual((await req(s.base, '/api/state', { cookie: l.cookie })).status, 200);
    assert.strictEqual((await post(s.base, '/api/trading', { on: false }, { cookie: l.cookie, headers: { 'x-csrf': l.csrf } })).status, 200);
  } finally { await s.close(); }
});
