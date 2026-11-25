'use strict';
// CSRF: header personalizzato + Origin/Sec-Fetch-Site + token legato alla sessione su ogni POST
const test = require('node:test'); const assert = require('node:assert');
const { boot, req, post, login } = require('./helpers');

test('POST senza x-sb, senza token CSRF, con token sbagliato o di un\'altra sessione → 403; con tutto giusto → 200', async () => {
  const s = await boot();
  try {
    const a = await login(s.base, undefined, { ip: '198.51.100.1' }); const b = await login(s.base, undefined, { ip: '198.51.100.2' });
    const body = JSON.stringify({ on: false });
    const raw = (headers) => req(s.base, '/api/trading', { method: 'POST', raw: body, cookie: a.cookie, headers: { 'content-type': 'application/json', ...headers } });
    assert.strictEqual((await raw({ 'x-csrf': a.csrf })).status, 403, 'manca x-sb (form di un altro sito)');
    assert.strictEqual((await raw({ 'x-sb': '1' })).status, 403, 'manca il token CSRF');
    assert.strictEqual((await raw({ 'x-sb': '1', 'x-csrf': 'f'.repeat(64) })).status, 403, 'token inventato');
    assert.strictEqual((await raw({ 'x-sb': '1', 'x-csrf': b.csrf })).status, 403, 'token di un\'altra sessione');
    assert.strictEqual((await raw({ 'x-sb': '1', 'x-csrf': a.csrf, origin: 'https://evil.example' })).status, 403, 'Origin di un altro sito');
    assert.strictEqual((await raw({ 'x-sb': '1', 'x-csrf': a.csrf, 'sec-fetch-site': 'cross-site' })).status, 403, 'Sec-Fetch-Site cross-site');
    assert.strictEqual((await raw({ 'x-sb': '1', 'x-csrf': a.csrf, origin: 'null' })).status, 403, 'Origin null (iframe sandbox)');
    const ok = await raw({ 'x-sb': '1', 'x-csrf': a.csrf, origin: s.base, 'sec-fetch-site': 'same-origin' }); assert.strictEqual(ok.status, 200);
    // form HTML classico di un altro sito: niente JSON, niente header → bloccato
    const form = await req(s.base, '/api/kill', { method: 'POST', raw: 'x=1', cookie: a.cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.ok(form.status === 403 || form.status === 415);
    assert.ok(!s.engine.book.killed, 'nessun kill switch da un altro sito');
  } finally { await s.close(); }
});

test('anche login e logout rifiutano richieste da altri siti', async () => {
  const s = await boot();
  try {
    const r = await post(s.base, '/api/auth/login', { pin: '482913' }, { headers: { origin: 'https://evil.example' } }); assert.strictEqual(r.status, 403); assert.ok(!r.token);
    const r2 = await req(s.base, '/api/auth/login', { method: 'POST', body: { pin: '482913' } }); assert.strictEqual(r2.status, 403, 'senza x-sb');
  } finally { await s.close(); }
});
