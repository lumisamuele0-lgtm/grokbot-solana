'use strict';
// Sala operativa: la pausa di un trader o di un analista accetta solo id noti e un booleano.
const test = require('node:test'); const assert = require('node:assert');
const { boot, apost, login, post, req } = require('./helpers');

test('POST /api/bot/pause: id sconosciuti o malformati e valori non booleani → 400; senza sessione → 401; valido → 200 e persistito', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); assert.strictEqual(l.status, 200);
    const bad = [{ id: 'zeus', paused: true }, { id: 'nova', paused: true }, { id: '../alpha', paused: true }, { id: 'ALPHA', paused: true }, { id: { $ne: 1 }, paused: true }, { id: 'alpha', paused: 'true' }, { id: 'alpha', paused: 1 }, { id: 'alpha' }, { paused: true }, { id: '__proto__', paused: true }, { id: 'a'.repeat(500), paused: true }];
    for (const b of bad) { const r = await apost(s.base, l, '/api/bot/pause', b); assert.strictEqual(r.status, 400, JSON.stringify(b)); assert.ok(!/at .*\.js/.test(r.text), 'nessuno stack'); }
    assert.strictEqual((await post(s.base, '/api/bot/pause', { id: 'alpha', paused: true })).status, 401);
    for (const id of ['alpha', 'trend']) assert.strictEqual((await apost(s.base, l, '/api/bot/pause', { id, paused: true })).status, 200);
    assert.strictEqual(s.engine.desk.isPaused('alpha'), true);
    const st = await req(s.base, '/api/state', { cookie: l.cookie }); assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.desk.execs.find((b) => b.id === 'alpha').paused, true); assert.strictEqual(st.json.desk.analysts.find((b) => b.id === 'trend').paused, true);
    assert.strictEqual(st.json.desk.analysts.length, 12); assert.strictEqual(st.json.desk.execs.length, 2);
    assert.ok(!('galaxy' in st.json) && !('match' in st.json), 'niente più galassia né partita nello stato');
    assert.strictEqual((await apost(s.base, l, '/api/bot/pause', { id: 'alpha', paused: false })).status, 200);
    assert.strictEqual(s.engine.desk.isPaused('alpha'), false);
    for (const p of ['/api/match/new', '/api/match/end']) assert.notStrictEqual((await apost(s.base, l, p, {})).status, 200, p + ' rimossa');
  } finally { await s.close(); }
});
