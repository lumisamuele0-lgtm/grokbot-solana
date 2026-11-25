'use strict';
// Input malevoli: corpi enormi, JSON rotto, tipi sbagliati, prototype pollution, annidamenti, stringhe lunghissime, parametri iniettati
const test = require('node:test'); const assert = require('node:assert');
const { boot, req, apost, login } = require('./helpers');
const { checkBody, V } = require('../../src/app');

const noStack = (r) => assert.ok(!/at .+\(.*\.js:\d+|node_modules|\/workspace|\/src\/|SyntaxError|TypeError/.test(r.text), `nessun dettaglio interno: ${r.text.slice(0, 200)}`);

test('corpo oltre 32 KB → 413, JSON rotto → 400, formato non JSON → 415, corpo non oggetto → 400 (mai lo stack)', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); const h = { 'content-type': 'application/json', 'x-sb': '1', 'x-csrf': l.csrf };
    const big = await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: h, raw: JSON.stringify({ x: 'a'.repeat(40000) }) });
    assert.strictEqual(big.status, 413); noStack(big);
    const bad = await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: h, raw: '{"a":' }); assert.strictEqual(bad.status, 400); noStack(bad);
    const txt = await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: { ...h, 'content-type': 'text/plain' }, raw: '{}' }); assert.strictEqual(txt.status, 415);
    for (const raw of ['[1,2]', '"x"', '123', 'null', 'true']) { const r = await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: h, raw }); assert.strictEqual(r.status, 400, raw); noStack(r); }
    const preLogin = await req(s.base, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sb': '1' }, raw: JSON.stringify({ pin: 'x'.repeat(40000) }) }); assert.strictEqual(preLogin.status, 413);
  } finally { await s.close(); }
});

test('prototype pollution, chiavi lunghe, annidamenti profondi, stringhe/array enormi → rifiutati, nessun inquinamento', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); const h = { 'content-type': 'application/json', 'x-sb': '1', 'x-csrf': l.csrf };
    for (const raw of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}', '{"a":{"__proto__":{"polluted":true}}}']) {
      const r = await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: h, raw }); assert.strictEqual(r.status, 400, raw);
    }
    assert.strictEqual(({}).polluted, undefined); assert.strictEqual(s.engine.cfg.polluted, undefined);
    let deep = '1'; for (let i = 0; i < 20; i++) deep = `{"a":${deep}}`;
    assert.strictEqual((await req(s.base, '/api/config', { method: 'POST', cookie: l.cookie, headers: h, raw: deep })).status, 400);
    assert.strictEqual((await apost(s.base, l, '/api/config', { ['k'.repeat(100)]: 1 })).status, 400);
    assert.strictEqual((await apost(s.base, l, '/api/config', { x: 'a'.repeat(5000) })).status, 400);
    assert.strictEqual((await apost(s.base, l, '/api/config', { x: new Array(400).fill(1) })).status, 400);
    assert.throws(() => checkBody(JSON.parse('{"x":[{"__proto__":1}]}')));
    assert.doesNotThrow(() => checkBody({ maxPositions: 3, coins: ['SOL', 'JUP'] }));
  } finally { await s.close(); }
});

test('validazione dei parametri: indirizzi, importi, firme, id posizione, mint delle candele, modalità', async () => {
  const s = await boot();
  try {
    const l = await login(s.base);
    for (const a of ['', 'abc', '0'.repeat(44), "'; DROP TABLE--", '<script>alert(1)</script>', { $ne: 1 }, ['x'], 'O'.repeat(44)]) {
      const r = await apost(s.base, l, '/api/user-wallet', { address: a }); assert.strictEqual(r.status, 400, JSON.stringify(a)); noStack(r);
    }
    for (const id of ['../../etc', '<img src=x>', 'a'.repeat(100), { x: 1 }, '']) { const r = await apost(s.base, l, '/api/close', { id }); assert.strictEqual(r.status, 400, JSON.stringify(id)); }
    const sig = await apost(s.base, l, '/api/deposit/confirm', { signature: '"><script>' }); assert.strictEqual(sig.status, 400);
    for (const m of ['../x', '<script>', "1' OR '1'='1", 'So11111111111111111111111111111111111111112%00']) {
      const r = await req(s.base, `/api/candles?mint=${encodeURIComponent(m)}`, { cookie: l.cookie }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, []);
    }
    const arr = await req(s.base, '/api/candles?mint=a&mint=b', { cookie: l.cookie }); assert.deepStrictEqual(arr.json, []);
    // la modalità REALE non si attiva con valori strani: resta SIM
    await apost(s.base, l, '/api/mode', { mode: { toString: 'REAL' } }); assert.strictEqual(s.engine.cfg.mode, 'SIM');
    // validatori
    assert.throws(() => V.num('1e999', { min: 0, max: 10 })); assert.throws(() => V.num(NaN, { min: 0, max: 10 })); assert.throws(() => V.num(-1, { min: 0, max: 10 }));
    assert.throws(() => V.pass('short')); assert.throws(() => V.pass('x'.repeat(300)));
    // XSS: il testo salvato non diventa mai HTML eseguibile lato server (la UI usa textContent/esc) e gli errori non riflettono HTML
    const x = await apost(s.base, l, '/api/close', { id: '<svg/onload=alert(1)>' }); assert.ok(!x.text.includes('<svg'));
  } finally { await s.close(); }
});
