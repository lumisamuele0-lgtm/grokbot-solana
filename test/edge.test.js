'use strict';
// TREND 4H (Alpha): candele 4h allineate, segnale EMA 20/100 + EMA 200, rischio fisso, uscite (stop, trailing dopo +1R, niente stop a tempo),
// integrazione con la sala: con edgeOn Alpha entra solo sul lato del segnale; kill switch, limite giornaliero, REALE e contante sempre rispettati.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const C = require('../src/config');
const E = require('../src/edge');
const S = require('../src/strategy');
const P = require('../src/perps');
const { SOL, USDC } = require('../src/tokens');

const H1 = 3600e3;
function candles(n = 200, drift = 0.0005, base = 100) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = base * (1 + drift * i) + base * 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 }); } return out; }
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbedge-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  e.market.candles[SOL] = candles(200, 0.0008, 100); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: now };
  return e;
}
const sig = (side, px, o = {}) => ({ dir: side === 'LONG' ? 1 : -1, side, atrPct: 1.5, slPct: 4.5, trailPct: 7.5, close: px, barT: Date.now() - 5 * H1, closeT: Date.now() - H1, ...o });
const vote = (id, dir, conf = 0.9) => ({ id, dir, conf, why: 'test' });

test('to4h: blocchi allineati a UTC, scarta il blocco iniziale incompleto e quello non ancora chiuso', () => {
  const t0 = Date.UTC(2026, 0, 1, 1); const K = []; for (let i = 0; i < 4 + 8 + 2; i++) K.push({ t: t0 + i * H1, o: i, h: i + 1, l: i - 1, c: i + 0.5 });
  const now = t0 + 14 * H1; const B = E.to4h(K, now);
  assert.strictEqual(B.length, 2, 'solo i due blocchi completi e chiusi (01:00–04:00 incompleto, 12:00 non chiuso)');
  for (const b of B) assert.strictEqual(b.t % E.H4, 0);
  assert.deepStrictEqual(B[0], { t: Date.UTC(2026, 0, 1, 4), o: 3, h: 7, l: 2, c: 6.5 });
});

test('segnale: LONG all\'incrocio EMA20 sopra EMA100 con prezzo sopra EMA200; stop 3 ATR (entro il 40% della liquidazione), trailing 5 ATR', () => {
  const B = []; let p = 100; const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 600; i++) { p *= i < 360 ? 0.999 : 1.006; const w = p * 0.01; B.push({ t: t0 + i * E.H4, o: p, h: p + w, l: p - w, c: p }); }
  const X = E.prep(B); let i = 0; let sg = null; for (i = E.P.trend + 5; i < B.length; i++) { sg = E.signalAt(X, i, 5, 19.7); if (sg) break; }
  assert.ok(sg, 'un segnale nel rialzo'); assert.strictEqual(sg.side, 'LONG'); assert.ok(X.c[i] > X.tr[i] && X.f[i] > X.s[i]);
  assert.ok(Math.abs(sg.slPct - Math.min(3 * sg.atrPct, 19.7 * 0.4)) < 1e-9); assert.ok(Math.abs(sg.trailPct - 5 * sg.atrPct) < 1e-9);
  assert.strictEqual(sg.closeT, B[i].t + E.H4);
  assert.strictEqual(E.signalAt(X, i + 1, 5, 19.7), null, 'solo sulla candela dell\'incrocio');
  assert.ok(E.fresh(sg, sg.close * 1.001, sg.closeT + 60e3)); assert.ok(!E.fresh(sg, sg.close, sg.closeT + E.H4 + 1), 'scaduto dopo 4h');
  assert.ok(!E.fresh(sg, sg.close * (1 + sg.atrPct / 100), sg.closeT + 60e3), 'niente inseguimenti oltre 0,5 ATR');
});

test('rischio fisso: perdita allo stop ≈ riskPerTradePct% del capitale, mai oltre il margine massimo', () => {
  const f = E.riskFrac({ maxTradePct: 20, riskPerTradePct: 2 }, 6, 5); assert.ok(Math.abs(f - 0.02 / 0.3 / 0.2) < 1e-9);
  const cap = 1000, margin = cap * 0.2 * f; assert.ok(Math.abs(margin * 5 * 0.06 - 20) < 1e-6, 'allo stop si perdono ~20 su 1000');
  assert.strictEqual(E.riskFrac({ maxTradePct: 20, riskPerTradePct: 5 }, 1, 10), 1, 'mai oltre il margine massimo');
  assert.strictEqual(E.riskFrac({ maxTradePct: 100, riskPerTradePct: 0.5 }, 7.9, 5), 0.05, 'minimo 5% del massimo');
});

test('uscite TREND 4H: stop, trailing solo dopo +1R, nessuno stop a tempo, tempo massimo 21 giorni; short specchiato', () => {
  const now = Date.now(); const mk = (o = {}) => ({ entryPrice: 100, highest: 100, slPct: 6, openedAt: now, edge: { trailPct: 10 }, ...o });
  let p = mk(); assert.strictEqual(S.exitPlan(p, 95, now + 3 * 3600e3, C.DEFAULTS).action, 'none', 'nessuna uscita a tempo dopo 3 ore in perdita');
  assert.strictEqual(S.exitPlan(p, 100.1, now + 2 * 864e5, C.DEFAULTS).action, 'none', 'nemmeno dopo 2 giorni piatti');
  let r = S.exitPlan(mk(), 93.9, now, C.DEFAULTS); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /^Stop-loss/);
  p = mk(); r = S.exitPlan(p, 105, now, C.DEFAULTS); assert.ok(!p.trailStop, 'trailing non ancora attivo sotto +1R');
  r = S.exitPlan(p, 107, now, C.DEFAULTS); assert.ok(Math.abs(p.trailStop - 96.3) < 1e-9, 'trailing a 10% dal massimo'); assert.strictEqual(r.action, 'none');
  r = S.exitPlan(p, 96.2, now, C.DEFAULTS); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /^Trailing stop/);
  r = S.exitPlan(mk(), 101, now + 21 * 864e5, C.DEFAULTS); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /Tempo massimo/);
  r = S.exitPlan(mk({ side: 'SHORT' }), 106.1, now, C.DEFAULTS); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /Stop-loss/);
  r = S.exitPlan(mk({ side: 'SHORT' }), 94, now, C.DEFAULTS); assert.strictEqual(r.action, 'none');
});

test('migrazione v15: TREND 4H acceso, rischio 2% per operazione, Omega spot in pausa; leva, margine, limiti, REALE invariati', () => {
  const r = C.migrateConfig({ cfgVersion: 14, leverage: 10, maxTradePct: 35, dailyLossPct: 15, spotLongs: true, realSpot: false, mode: 'SIM' });
  assert.strictEqual(r.cfg.edgeOn, true); assert.strictEqual(r.cfg.riskPerTradePct, 2); assert.strictEqual(r.cfg.spotLongs, false);
  assert.strictEqual(r.cfg.leverage, 10); assert.strictEqual(r.cfg.maxTradePct, 35); assert.strictEqual(r.cfg.dailyLossPct, 15); assert.strictEqual(r.cfg.realSpot, false); assert.strictEqual(r.cfg.mode, 'SIM');
  assert.strictEqual(C.migrateConfig(r.cfg).changed, false);
  assert.strictEqual(C.sanitize({ riskPerTradePct: 50 }, r.cfg).riskPerTradePct, 5); assert.strictEqual(C.sanitize({ riskPerTradePct: 0 }, r.cfg).riskPerTradePct, 0.5);
  assert.strictEqual(C.sanitize({ edgeOn: false }, r.cfg).edgeOn, false);
});

test('sala con TREND 4H: Alpha entra solo sul lato del segnale (ignora il consenso a 1 minuto), stop dal segnale, rischio fisso, margine ≤ contante', async () => {
  const e = mkEngine(); assert.strictEqual(e.cfg.edgeOn, true);
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf', 'flow'].map((id) => vote(id, 1)); // tutti LONG a 1 minuto
  const px = e.market.usd(SOL); e.edge.signal = (sym) => (sym === 'SOL' ? sig('SHORT', px) : null);
  e.desk.pickCoins(); const opened = await e.desk.turn();
  const p = opened.find((x) => x.mint === SOL); assert.ok(p, 'aperto'); assert.strictEqual(p.side, 'SHORT', 'lato del segnale 4h, non del consenso');
  assert.strictEqual(p.bot, 'alpha'); assert.strictEqual(p.edge.kind, 'trend4h'); assert.strictEqual(p.edge.trailPct, 7.5);
  assert.ok(Math.abs(p.slPct - 4.5) < 1e-9, 'stop = 3 ATR del segnale'); assert.ok(p.slPct <= P.liqDistancePct(p.lev) * 0.4 + 1e-9);
  const lossAtStop = p.costBase * p.lev * p.slPct / 100; assert.ok(lossAtStop <= 1000 * 0.02 * 1.05, `perdita allo stop ≈ 2% (${lossAtStop.toFixed(2)})`);
  assert.ok(p.costBase <= 1000 * e.cfg.maxTradePct / 100 + 1e-6); assert.ok(e.book.cash >= 0, 'margine mai oltre il contante');
  assert.ok(!opened.some((x) => x.mint === SOL && x.side === 'LONG'));
  const rep = e.report(); assert.strictEqual(rep.trend4h.on, true); assert.strictEqual(rep.trend4h.assets.length, 3);
});

test('sala con TREND 4H: senza segnale nessun ingresso perps (anche con consenso forte), spiegato in «Perché non entra»', async () => {
  const e = mkEngine(); e.cfg.trading = true;
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf', 'flow'].map((id) => vote(id, -1));
  e.edge.signal = () => null; e.desk.pickCoins();
  assert.strictEqual((await e.desk.turn()).filter((x) => x.perp).length, 0);
  assert.ok(e.desk.scan.reasons.trend4h >= 1); assert.strictEqual(e.whyIdle().code, 'trend4h');
});

test('TREND 4H rispetta kill switch, limite giornaliero e blocco perps REALE', async () => {
  const run = async (prep) => { const e = mkEngine(); e.desk.analyze = () => [vote('trend', 1)]; const px = e.market.usd(SOL); e.edge.signal = (s) => (s === 'SOL' ? sig('LONG', px) : null); prep(e); e.desk.pickCoins(); await e.desk.turn(); return e.book.positions.filter((x) => x.perp).length; };
  assert.strictEqual(await run((e) => { e.book.killed = true; }), 0, 'kill switch');
  assert.strictEqual(await run((e) => { e.book.cash = 840; }), 0, 'limite di perdita giornaliera');
  assert.strictEqual(await run((e) => { e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(1000, e.cfg); }), 0, 'perps reali bloccati'); assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  assert.strictEqual(await run(() => {}), 1, 'in simulazione entra');
});

test('Edge.signal: un segnale già usato da una posizione o da un trade aperto dopo il segnale non riapre', () => {
  const e = mkEngine(); const B = []; let p = 100; const t0 = Math.floor(Date.now() / E.H4) * E.H4 - 599 * E.H4;
  for (let i = 0; i < 599; i++) { p *= i < 595 ? 0.999 : 1.08; B.push({ t: t0 + i * E.H4, o: p, h: p * 1.01, l: p * 0.99, c: p }); }
  e.edge.X.SOL = E.prep(B); const sg = e.edge.last('SOL');
  assert.ok(sg && sg.side === 'LONG', 'incrocio sull\'ultima candela chiusa');
  e.market.prices[SOL] = { usd: sg.close, ts: Date.now() }; const now = sg.closeT + 60e3;
  assert.ok(e.edge.signal('SOL', now)); e.book.trades.unshift({ perp: true, market: 'SOL', symbol: 'SOL', openedAt: sg.closeT + 1 });
  assert.strictEqual(e.edge.signal('SOL', now), null);
});
