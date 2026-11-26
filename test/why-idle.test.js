'use strict';
// Regressione (t61u «Perché non fa trading?»): il pannello «Perché non entra» spiega il blocco reale, e la selettività del
// MENTORE non blocca più per sempre una cripto/direzione nella sala operativa (prima chiedeva consenso ≥ 83%, mai raggiungibile).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { Mentor } = require('../src/mentor');
const D = require('../src/desk');
const P = require('../src/perps');
const { SOL, USDC } = require('../src/tokens');

function candles(n = 200, drift = 0.0005, base = 1) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = base * (1 + drift * i) + base * 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbwhy-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 12, spotLongs: false, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  for (const m of Object.keys(P.SHORT_MARKETS)) { e.market.candles[m] = candles(200, 0.0004, 100); e.market.prices[m] = { usd: 100, ts: now }; }
  return e;
}
const vote = (id, dir, conf = 0.8) => ({ id, dir, conf, why: 'test' });

test('in pausa dopo il riavvio → «premi Avvia»; kill switch → «Riarma»', () => {
  const e = mkEngine();
  let w = e.snapshot().why; assert.strictEqual(w.code, 'paused'); assert.match(w.text, /Avvia/); assert.strictEqual(w.action, 'start');
  e.cfg.trading = true; e.book.killed = true; e.book.killReason = 'Perdita totale 21% ≥ limite 20%';
  w = e.whyIdle(); assert.strictEqual(w.code, 'kill'); assert.match(w.text, /Riarma/); assert.strictEqual(w.action, 'rearm');
});

test('REALE con spot spento e leva in attesa → nessuna operazione possibile, spiegato', () => {
  const e = mkEngine({ spotLongs: true }); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.cfg.trading = true;
  assert.strictEqual(e.whyIdle().code, 'locked');
  e.ks.kp = {}; const w = e.whyIdle(); assert.strictEqual(w.code, 'real-block'); assert.match(w.text, /spot disattivato/);
  e.cfg.realSpot = true; assert.notStrictEqual(e.whyIdle().code, 'real-block');
  assert.strictEqual(P.REAL_SHORTS_ENABLED, false, 'blocchi REALE invariati');
});

test('limite di perdita giornaliera e posizioni massime spiegati', () => {
  const e = mkEngine(); e.cfg.trading = true; e.book.dayStartEquity = 1300; // −23% oggi
  assert.strictEqual(e.whyIdle().code, 'breaker'); assert.match(e.whyIdle().text, /Limite perdita giornaliera/);
});

test('consenso sotto soglia → «Consenso X% < Y% su SOL» con i migliori candidati del giro', async () => {
  const e = mkEngine({ cfgVersion: 14, pace: 'normale' }); e.cfg.trading = true;
  e.desk.analyze = () => [vote('trend', 1, 0.3), vote('macro', -1, 0.3), vote('news', 0, 0), vote('funding', 0, 0)];
  e.desk.pickCoins(); assert.strictEqual((await e.desk.turn()).length, 0);
  const w = e.whyIdle(); assert.ok(['consensus', 'agree', 'against'].includes(w.code), w.code); assert.match(w.text, /SOL|BTC|ETH/);
  assert.ok(e.desk.scan.evaluated >= 3 && e.desk.scan.best.length >= 1 && e.desk.scan.best[0].thr === 0.22);
});

test('soglie della sala operativa: Alpha 22% / 2 analisti, Omega 30% / 3 analisti; Omega resta più selettivo', () => {
  const al = D.EXECUTORS.find((x) => x.id === 'alpha'), om = D.EXECUTORS.find((x) => x.id === 'omega');
  assert.deepStrictEqual([al.thr, al.minAgree, om.thr, om.minAgree], [0.22, 2, 0.3, 3]);
});

test('MENTORE selettività 1–2: nella sala operativa alza la soglia di qualche punto, non blocca per sempre', async () => {
  const m = new Mentor(); const t = m.tune('SOL', 'LONG'); t.level = 2;
  const old = m.entryCheck({ symbol: 'SOL', side: 'LONG', conf: 0.45, flowStrict: true });
  assert.strictEqual(old.ok, false, 'vecchi segnali: comportamento invariato');
  const c = m.entryCheck({ symbol: 'SOL', side: 'LONG', conf: 0.45, flowStrict: false, consensus: true });
  assert.deepStrictEqual([c.ok, c.raise], [true, 0.08]);
  t.level = 3; assert.strictEqual(m.entryCheck({ symbol: 'SOL', side: 'LONG', conf: 0.9, flowStrict: false, consensus: true }).ok, false);
  // giro completo: con il livello 1 su tutte le direzioni dei perps e un consenso buono Alpha entra comunque
  const e = mkEngine({ cfgVersion: 14, pace: 'normale' }); e.cfg.trading = true;
  for (const s of ['SOL', 'BTC', 'ETH']) for (const side of ['LONG', 'SHORT']) e.mentor.tune(s, side).level = 1;
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf'].map((id) => vote(id, 1, 0.7));
  e.openShort = async (c, margin, plan, side, lev) => { const p = { id: 'x' + Math.random(), mint: c.m, symbol: c.s.symbol, side, lev, costBase: margin, feesBase: 0, entryPrice: 100, openedAt: Date.now(), perp: true, bot: c.bot }; e.book.positions.push(p); return p; };
  e.desk.pickCoins(); const opened = await e.desk.turn();
  assert.ok(opened.length >= 1, 'entra nonostante la selettività 1/3'); assert.ok(e.desk.scan.best[0].thr > 0.22, 'soglia alzata dal Mentore');
  assert.strictEqual(e.whyIdle().code, 'trading');
});

test('interfaccia: pannello «Perché non entra» in Home, collegato a s.why, con Avvia/Riarma', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'); const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="whyBox"/); assert.match(html, /Perché non entra/); assert.match(js, /function renderWhy\(s\)/); assert.match(js, /data-a="rearm"/); assert.match(js, /a === 'rearm'/);
});
