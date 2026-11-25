'use strict';
// Forza bruta sul PIN: blocco per indirizzo, blocchi crescenti, limite di richieste, rallentamento globale; il proprietario non resta chiuso fuori
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { boot, login, PIN } = require('./helpers');
const { Auth, LOCK } = require('../../src/auth');

test('5 PIN errati dallo stesso indirizzo → blocco (anche col PIN giusto); un altro indirizzo entra', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) { const r = await login(s.base, '000000', { ip: '203.0.113.9' }); assert.strictEqual(r.status, 400); assert.match(r.json.error, /PIN errato/); assert.ok(!r.token); }
    const blocked = await login(s.base, PIN, { ip: '203.0.113.9' }); assert.strictEqual(blocked.status, 400); assert.match(blocked.json.error, /Troppi tentativi/); assert.ok(!blocked.token);
    const owner = await login(s.base, PIN, { ip: '198.51.100.7' }); assert.strictEqual(owner.status, 200); assert.ok(owner.token, 'il proprietario da un altro indirizzo entra');
  } finally { await s.close(); }
});

test('blocchi crescenti (5, 10, 20 min… max 1 ora) e azzeramento dopo il PIN giusto', () => {
  const a = new Auth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbbf-')), 'auth.json')); a.setup(PIN);
  let now = 1e12; const durs = [];
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < LOCK.FAILS; i++) assert.throws(() => a.login('111111', 'x', now), /PIN errato/);
    const left = a.lockState('x', now); durs.push(left); assert.throws(() => a.login(PIN, 'x', now), /Troppi tentativi/);
    now += left + 1;
  }
  assert.deepStrictEqual(durs.map((d) => d / 60e3), [5, 10, 20, 40, 60, 60]);
  assert.ok(a.login(PIN, 'x', now)); assert.strictEqual(a.lockState('x', now), 0);
  // PIN non numerici, troppo lunghi, oggetti: rifiutati senza eccezioni strane
  for (const bad of [{ $gt: '' }, ['482913'], '482913 ', '4829130000000000', null, true]) assert.throws(() => a.login(bad, 'y', now), /PIN errato|Troppi/);
});

test('limite di richieste sul login (20 al minuto per indirizzo) e rallentamento in caso di attacco distribuito', async () => {
  const s = await boot();
  try {
    let limited = 0;
    for (let i = 0; i < 9; i++) { const r = await login(s.base, '999999', { ip: `192.0.2.${i % 3}` }); if (r.status === 429) limited++; }
    assert.ok(limited === 0, 'il limite è per indirizzo'); s.auth.globalFails = [];
    const many = []; for (let i = 0; i < 22; i++) many.push(await login(s.base, '999999', { ip: '192.0.2.200' }));
    assert.ok(many.some((r) => r.status === 429), '429 oltre 20 richieste al minuto'); assert.ok(many.find((r) => r.status === 429).headers.get('retry-after')); s.auth.globalFails = [];
    const a = s.auth; for (let i = 0; i < LOCK.GLOBAL_FAILS; i++) a.globalFails.push(Date.now());
    assert.ok(a.underAttack());
    const t = Date.now(); const ok = await login(s.base, PIN, { ip: '198.51.100.50' }); assert.strictEqual(ok.status, 200, 'mai bloccato del tutto'); assert.ok(Date.now() - t >= 1900, 'ma rallentato');
  } finally { await s.close(); }
});
