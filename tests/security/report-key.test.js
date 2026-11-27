'use strict';
// Chiave «resoconto»: sola lettura, token mostrato una volta, sul server solo l'hash, revoca, limiti di frequenza
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { boot, req, post, apost, login } = require('./helpers');
const { readJson } = require('../../src/store');
const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

test('chiave resoconto: creata solo con il PIN, mostrata una volta, salvata solo come hash; GET /api/report in sola lettura', async () => {
  const s = await boot();
  try {
    assert.strictEqual((await req(s.base, '/api/report-key')).status, 401, 'stato chiave: serve la sessione');
    assert.strictEqual((await post(s.base, '/api/report-key', {})).status, 401, 'creare la chiave: serve la sessione');
    const l = await login(s.base);
    assert.deepStrictEqual((await req(s.base, '/api/report-key', { cookie: l.cookie })).json, { active: false });
    const c = await apost(s.base, l, '/api/report-key', {}); assert.strictEqual(c.status, 200);
    const tok = c.json.token; assert.match(tok, /^sbr_[A-Za-z0-9_-]{43}$/); assert.strictEqual(c.headers.get('cache-control'), 'no-store');
    // lo stato non ridà mai il token
    const st = await req(s.base, '/api/report-key', { cookie: l.cookie }); assert.strictEqual(st.json.active, true); assert.ok(!st.text.includes(tok) && !('token' in st.json) && !('hash' in st.json));
    assert.ok(!(await req(s.base, '/api/state', { cookie: l.cookie })).text.includes(tok));
    // su disco: file cifrato, e anche decifrato contiene solo l'HMAC (mai il token)
    const raw = fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8'); assert.ok(!raw.includes(tok) && !raw.includes(tok.slice(4)));
    const data = readJson(path.join(s.dir, 'auth.json'), null); assert.ok(data.report && /^[a-f0-9]{64}$/.test(data.report.hash)); assert.ok(!JSON.stringify(data).includes(tok.slice(4)));
    for (const f of fs.readdirSync(s.dir)) { const p = path.join(s.dir, f); if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).toString('latin1').includes(tok.slice(4)), `${f} non contiene il token`); }
    assert.ok(!s.logger.lines.join('\n').includes(tok.slice(4)), 'il token non finisce nei log');
    // resoconto
    const r = await req(s.base, '/api/report', bearer(tok)); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    for (const k of ['mode', 'running', 'paused', 'equity', 'pnl', 'tradesToday', 'open', 'brains', 'lab', 'why', 'pace']) assert.ok(k in r.json, `campo ${k}`);
    assert.ok(['today', 'total'].every((k) => k in r.json.pnl)); assert.ok(['count', 'winRate'].every((k) => k in r.json.tradesToday)); assert.ok(['promotions', 'rejections'].every((k) => k in r.json.lab.today));
    assert.ok(Object.keys(r.json.brains.bots).length >= 2); for (const b of Object.values(r.json.brains.bots)) assert.ok('valAcc' in b && 'baseline' in b);
    assert.ok(!/publicKey|walletEncJson|secret|pinHash|salt|sessions|rpcUrl|"mint"|withdraw|csrf/.test(r.text), 'nessun dato sensibile nel resoconto');
    // storico dei trade chiusi: solo dati di mercato (niente mint, firme, indirizzi)
    s.engine.book.trades.unshift({ id: 'x1', bot: 'alpha', symbol: 'SOL', side: 'SHORT', lev: 5, perp: true, mint: 'So11111111111111111111111111111111111111112', sigOpen: 'SIGOPEN123', sigClose: 'SIGCLOSE456', openedAt: 1, closedAt: 600001, entryPrice: 100, exitPrice: 101, costBase: 0.05, pnl: -0.003, pnlPct: -6, fees: 0.0002, reason: 'Stop-loss', consensus: 0.3, slPct: 1.2, atrPct: 0.4, mfe: 0.1, mae: -1.3, votes: [{ id: 'trend', dir: -1, conf: 1 }], feat: ['a'] });
    const r2 = await req(s.base, '/api/report', bearer(tok)); const t0 = r2.json.trades[0];
    assert.deepStrictEqual([t0.bot, t0.side, t0.lev, t0.holdMin, t0.reason, t0.votes], ['alpha', 'SHORT', 5, 10, 'Stop-loss', 'trend-']);
    assert.ok(!/So1111|SIGOPEN|SIGCLOSE|"mint"|"sig/.test(r2.text), 'niente mint né firme nello storico');
    assert.ok(!r.setCookie, 'nessun cookie di sessione dalla chiave');
    // sola lettura: la chiave non apre nessun'altra rotta né i POST
    assert.strictEqual((await req(s.base, '/api/state', bearer(tok))).status, 401);
    assert.strictEqual((await post(s.base, '/api/trading', { on: true }, bearer(tok))).status, 401);
    assert.strictEqual((await post(s.base, '/api/report', {}, bearer(tok))).status, 401, 'POST /api/report non esiste per la chiave');
    assert.strictEqual((await req(s.base, '/api/report', { method: 'DELETE', ...bearer(tok) })).status === 200, false);
    assert.strictEqual(s.engine.cfg.trading, false, 'nulla è cambiato');
    // token sbagliati / formati strani / senza Bearer
    for (const bad of ['sbr_' + 'A'.repeat(43), tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'), tok + 'x', 'x', '']) assert.strictEqual((await req(s.base, '/api/report', { ...bearer(bad), ip: '10.0.0.9' })).status, 401);
    assert.strictEqual((await req(s.base, '/api/report', { headers: { authorization: tok } })).status, 401, 'serve lo schema Bearer');
    assert.strictEqual((await req(s.base, '/api/report', { cookie: l.cookie })).status, 401, 'la sessione del PIN non basta: serve la chiave');
    // nuova chiave: la vecchia smette di funzionare; revoca: nessuna funziona
    const c2 = await apost(s.base, l, '/api/report-key', {}); assert.notStrictEqual(c2.json.token, tok);
    assert.strictEqual((await req(s.base, '/api/report', bearer(tok))).status, 401);
    assert.strictEqual((await req(s.base, '/api/report', bearer(c2.json.token))).status, 200);
    assert.strictEqual((await apost(s.base, l, '/api/report-key/revoke', {})).status, 200);
    assert.strictEqual((await req(s.base, '/api/report', bearer(c2.json.token))).status, 401);
    assert.deepStrictEqual((await req(s.base, '/api/report-key', { cookie: l.cookie })).json, { active: false });
  } finally { await s.close(); }
});

test('chiave resoconto: limiti di frequenza (30 letture / 10 min; 10 chiavi sbagliate → 429 per quell\'IP)', async () => {
  const s = await boot();
  try {
    const l = await login(s.base); const tok = (await apost(s.base, l, '/api/report-key', {})).json.token;
    for (let i = 0; i < 10; i++) assert.strictEqual((await req(s.base, '/api/report', { ...bearer('sbr_' + String(i).padStart(43, 'Z')), ip: '10.1.1.1' })).status, 401);
    const blocked = await req(s.base, '/api/report', { ...bearer(tok), ip: '10.1.1.1' }); assert.strictEqual(blocked.status, 429, 'dopo 10 errori anche la chiave giusta aspetta'); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.strictEqual((await req(s.base, '/api/report', { ...bearer(tok), ip: '10.1.1.2' })).status, 200, 'altri IP non sono toccati');
    let st = 0; for (let i = 0; i < 29; i++) st = (await req(s.base, '/api/report', { ...bearer(tok), ip: '10.1.1.3' })).status; assert.strictEqual(st, 200);
    assert.strictEqual((await req(s.base, '/api/report', { ...bearer(tok), ip: '10.1.1.3' })).status, 200);
    assert.strictEqual((await req(s.base, '/api/report', { ...bearer(tok), ip: '10.1.1.3' })).status, 429, 'oltre 30 letture in 10 minuti');
  } finally { await s.close(); }
});

test('chiave resoconto: unità Auth (hash HMAC, confronto a tempo costante, revoca)', () => {
  const os = require('os'); const { Auth } = require('../../src/auth');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrep-')); const a = new Auth(path.join(d, 'auth.json')); a.setup('482913');
  assert.strictEqual(a.verifyReport('sbr_' + 'a'.repeat(43)), false, 'nessuna chiave: tutto rifiutato');
  const t = a.createReportKey(); assert.strictEqual(a.verifyReport(t), true); assert.notStrictEqual(a.data.report.hash, t); assert.strictEqual(a.data.report.hash, a.reportHash(t));
  assert.strictEqual(a.verifyReport(null), false); assert.strictEqual(a.verifyReport({}), false); assert.strictEqual(a.verifyReport(t.toUpperCase() === t ? t.toLowerCase() : t.toUpperCase()), false);
  const a2 = new Auth(path.join(d, 'auth.json')); assert.strictEqual(a2.verifyReport(t), true, 'sopravvive al riavvio (hash cifrato su disco)');
  a2.revokeReport(); assert.strictEqual(a2.verifyReport(t), false); assert.deepStrictEqual(a2.reportStatus(), { active: false });
});
