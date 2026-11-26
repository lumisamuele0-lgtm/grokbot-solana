'use strict';
// Osservatorio: la pausa di un singolo pianeta (bot) accetta solo id noti e un booleano.
const test = require('node:test'); const assert = require('node:assert');
const { boot, apost, login, post, req } = require('./helpers');

test('POST /api/bot/pause: id sconosciuti o malformati e valori non booleani → 400; senza sessione → 401; valido → 200 e persistito', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); assert.strictEqual(l.status, 200);
    const bad = [{ id: 'zeus', paused: true }, { id: '../nova', paused: true }, { id: 'NOVA', paused: true }, { id: { $ne: 1 }, paused: true }, { id: 'nova', paused: 'true' }, { id: 'nova', paused: 1 }, { id: 'nova' }, { paused: true }, { id: '__proto__', paused: true }, { id: 'a'.repeat(500), paused: true }];
    for (const b of bad) { const r = await apost(s.base, l, '/api/bot/pause', b); assert.strictEqual(r.status, 400, JSON.stringify(b)); assert.ok(!/at .*\.js/.test(r.text), 'nessuno stack'); }
    assert.strictEqual((await post(s.base, '/api/bot/pause', { id: 'nova', paused: true })).status, 401);
    const ok = await apost(s.base, l, '/api/bot/pause', { id: 'nova', paused: true }); assert.strictEqual(ok.status, 200);
    assert.strictEqual(s.engine.galaxy.isPaused('nova'), true);
    const st = await req(s.base, '/api/state', { cookie: l.cookie }); assert.strictEqual(st.status, 200);
    const nova = st.json.galaxy.bots.find((b) => b.id === 'nova'); assert.strictEqual(nova.paused, true);
    assert.ok(!('match' in st.json), 'niente più partita nello stato');
    assert.strictEqual((await apost(s.base, l, '/api/bot/pause', { id: 'nova', paused: false })).status, 200);
    assert.strictEqual(s.engine.galaxy.isPaused('nova'), false);
    for (const p of ['/api/match/new', '/api/match/end']) assert.notStrictEqual((await apost(s.base, l, p, {})).status, 200, p + ' rimossa');
  } finally { await s.close(); }
});
