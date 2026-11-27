'use strict';
// TREND 2–4H (Alpha perps SOL/BTC/ETH + Omega spot CORE): parametri, candele 4h, segnali, rischio fisso, uscite,
// integrazione con la sala (solo segnali a 4h, analisti a 1 minuto informativi) e tutti i blocchi di sicurezza invariati.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const C = require('../src/config');
const T = require('../src/trend');
const S = require('../src/strategy');
const P = require('../src/perps');
const jup = require('../src/jupiter');
const { SOL, USDC, CORE } = require('../src/tokens');

const H1 = 3600e3, H4 = 4 * H1;
const JUP = CORE.find((t) => t.symbol === 'JUP').mint;
function candles(n = 200, drift = 0.0005, base = 100) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = base * (1 + drift * i) + base * 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1000 }); } return out; }
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbtrend-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.candles[SOL] = candles(200, 0.0008, 100); e.market.prices[SOL] = { usd: 100, ts: now };
  e.market.prices[JUP] = { usd: 0.5, ts: now }; e.market.stats[JUP] = { symbol: 'JUP', decimals: 6 };
  e.market.safety[JUP] = { ts: now, rugScore: 1, danger: [], holderRisk: false, mintAuthority: null, freezeAuthority: null, token2022Ext: false, decimals: 6 };
  e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
const sig = (side, px, o = {}) => ({ dir: side === 'LONG' ? 1 : -1, side, atrPct: 1.5, slPct: 6, trailPct: 12, close: px, barT: Date.now() - 5 * H1, closeT: Date.now() - H1, tf: '4h', ...o });
const stubQuote = (e, M) => async (i, o, amt) => (i === USDC ? { outAmount: String(Math.floor((Number(amt) / 1e6 / e.market.prices[M].usd) * 1e6)), priceImpactPct: '0.001' } : { outAmount: '1000', priceImpactPct: '0' });

test('parametri scelti dalla ricerca: perps 4h EMA 20/100 + EMA 200, stop 4 ATR, trailing 8 ATR; spot 4h EMA 10/30 + EMA 200, stop 1,5 ATR, trailing 8 ATR, solo long', () => {
  assert.deepStrictEqual(T.PARAMS.perp, { tf: '4h', fast: 20, slow: 100, trend: 200, atrN: 14, slAtr: 4, trailAtr: 8, act: 1, maxHoldDays: 21, longOnly: false });
  assert.deepStrictEqual(T.PARAMS.spot, { tf: '4h', fast: 10, slow: 30, trend: 200, atrN: 14, slAtr: 1.5, trailAtr: 8, act: 1, maxHoldDays: 21, longOnly: true });
  assert.deepStrictEqual(T.PERP_ASSETS, ['SOL', 'BTC', 'ETH']); for (const a of T.SPOT_ASSETS) assert.ok(CORE.some((t) => t.symbol === a), `${a} è una cripto CORE`);
  assert.strictEqual(C.DEFAULTS.trendOn, true); assert.strictEqual(C.DEFAULTS.riskPerTradePct, 1); assert.deepStrictEqual(C.LIMITS.riskPerTradePct, [0.5, 3]); assert.deepStrictEqual(C.LIMITS.maxTradePct, [1, 20]);
});

test('candele 4h allineate a UTC: blocco iniziale incompleto e blocco non chiuso scartati', () => {
  const t0 = Date.UTC(2026, 0, 1, 1); const K = []; for (let i = 0; i < 14; i++) K.push({ t: t0 + i * H1, o: i, h: i + 1, l: i - 1, c: i + 0.5 });
  const B = T.resampleTf(K, H4, t0 + 14 * H1); assert.strictEqual(B.length, 2); assert.deepStrictEqual(B[0], { t: Date.UTC(2026, 0, 1, 4), o: 3, h: 7, l: 2, c: 6.5 });
});

function series(n, turn, up = true) { const B = []; let p = 100; const t0 = Math.floor(Date.now() / H4) * H4 - n * H4; for (let i = 0; i < n; i++) { p *= i < turn ? (up ? 0.999 : 1.001) : (up ? 1.006 : 0.994); B.push({ t: t0 + i * H4, o: p, h: p * 1.01, l: p * 0.99, c: p }); } return B; }
test('segnali: LONG/SHORT perps all\'incrocio nel verso della EMA 200; spot mai short; stop entro il 40% della liquidazione', () => {
  for (const up of [true, false]) {
    const X = T.prep(series(600, 360, up), T.PARAMS.perp); let sg = null, i;
    for (i = 210; i < 600 && !sg; i++) sg = T.signalAt(X, i, 19.7);
    assert.ok(sg); assert.strictEqual(sg.side, up ? 'LONG' : 'SHORT'); assert.ok(Math.abs(sg.slPct - Math.min(4 * sg.atrPct, 7.88)) < 1e-9); assert.ok(Math.abs(sg.trailPct - 8 * sg.atrPct) < 1e-9);
  }
  const Xs = T.prep(series(600, 360, false), T.PARAMS.spot); for (let i = 0; i < 600; i++) { const s = T.signalAt(Xs, i); assert.ok(!s || s.side === 'LONG', 'spot solo long'); }
  const s = sig('LONG', 100); assert.ok(T.fresh(s, 100.5, s.closeT + 60e3)); assert.ok(!T.fresh(s, 100, s.closeT + H4 + 1), 'scade dopo una candela'); assert.ok(!T.fresh(s, 93.9, s.closeT + 60e3), 'prezzo già oltre lo stop');
});

test('rischio fisso: perdita allo stop ≈ riskPerTradePct% del capitale, mai oltre il margine massimo', () => {
  const f = T.riskFrac({ maxTradePct: 20, riskPerTradePct: 1 }, 6, 5); assert.ok(Math.abs(1000 * 0.2 * f * 5 * 0.06 - 10) < 1e-6);
  assert.strictEqual(T.riskFrac({ maxTradePct: 20, riskPerTradePct: 3 }, 2, 1), 1, 'spot con stop stretto: tetto 20%');
});

test('uscite: stop, trailing solo dopo +1R, nessuno stop a tempo né target, durata massima 21 giorni; short specchiato', () => {
  const now = Date.now(); const mk = (o = {}) => ({ entryPrice: 100, highest: 100, slPct: 6, openedAt: now, edge: { kind: 'trend', trailPct: 10, act: 1, maxHoldDays: 21 }, ...o });
  assert.strictEqual(S.exitPlan(mk(), 95, now + 5 * H1, C.DEFAULTS).action, 'none'); assert.strictEqual(S.exitPlan(mk(), 130, now, C.DEFAULTS).action, 'none', 'nessun target fisso');
  assert.match(S.exitPlan(mk(), 93.9, now, C.DEFAULTS).reason, /^Stop-loss/);
  const p = mk(); S.exitPlan(p, 105, now, C.DEFAULTS); assert.ok(!p.trailStop); S.exitPlan(p, 110, now, C.DEFAULTS); assert.ok(Math.abs(p.trailStop - 99) < 1e-9);
  assert.match(S.exitPlan(p, 98.9, now, C.DEFAULTS).reason, /^Trailing stop/);
  assert.match(S.exitPlan(mk(), 101, now + 21 * 864e5, C.DEFAULTS).reason, /Tempo massimo/);
  assert.strictEqual(S.exitPlan(mk({ side: 'SHORT' }), 106.1, now, C.DEFAULTS).action, 'close'); assert.strictEqual(S.exitPlan(mk({ side: 'SHORT' }), 94, now, C.DEFAULTS).action, 'none');
  assert.strictEqual(S.exitPlan({ entryPrice: 100, highest: 100, slPct: 2, tpPct: 4, trailPct: 1.4, openedAt: now - 100 * 60e3 }, 100.1, now, C.DEFAULTS).action, 'close', 'le posizioni senza TREND usano le uscite di prima');
});

test('Alpha: entra solo sul lato del segnale 4h (ignora il consenso a 1 minuto), stop dal segnale, rischio ~1%, margine ≤ 20% e ≤ contante', async () => {
  const e = mkEngine(); assert.strictEqual(e.cfg.trendOn, true);
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf', 'flow'].map((id) => ({ id, dir: 1, conf: 0.9, why: 't' }));
  e.trend.signal = (a) => (a === 'SOL' ? { ...sig('SHORT', 100), sym: 'SOL', mint: SOL, kind: 'perp' } : null);
  e.desk.pickCoins(); const opened = await e.desk.turn();
  assert.strictEqual(opened.length, 1); const p = opened[0];
  assert.strictEqual(p.side, 'SHORT'); assert.strictEqual(p.bot, 'alpha'); assert.ok(p.perp); assert.strictEqual(p.edge.kind, 'trend'); assert.strictEqual(p.edge.trailPct, 12);
  assert.ok(Math.abs(p.slPct - 6) < 1e-9); const loss = p.costBase * p.lev * p.slPct / 100; assert.ok(loss <= 10.5 && loss >= 9, `perdita allo stop ≈ 1% (${loss.toFixed(2)})`);
  assert.ok(p.costBase <= 200 + 1e-6); assert.ok(e.book.cash >= 0);
  const r = e.report(); assert.strictEqual(r.trend.on, true); assert.strictEqual(r.trend.assets.length, 11); assert.ok(r.trend.nextCheck > Date.now());
});

test('Omega: compra spot CORE solo sul segnale LONG a 4h, con controlli anti-truffa e via di vendita; mai short spot', async () => {
  const e = mkEngine(); e.desk.analyze = () => [];
  e.trend.signal = (a) => (a === 'JUP' ? { ...sig('LONG', 0.5, { slPct: 6, trailPct: 20 }), sym: 'JUP', mint: JUP, kind: 'spot' } : null);
  const real = jup.quote; jup.quote = stubQuote(e, JUP);
  try {
    e.desk.pickCoins(); const [p] = await e.desk.turn();
    assert.ok(p, 'acquisto'); assert.strictEqual(p.mint, JUP); assert.strictEqual(p.bot, 'omega'); assert.strictEqual(p.lev, 1); assert.ok(!p.perp); assert.strictEqual(p.edge.kind, 'trend'); assert.ok(Math.abs(p.slPct - 6) < 1e-9);
    assert.ok(p.costBase <= 200 + 0.01, 'margine ≤ 20%'); assert.ok(Math.abs(p.costBase * 0.06 - 10) < 0.5, `rischio ~1% (${p.costBase})`);
  } finally { jup.quote = real; }
  const e2 = mkEngine(); e2.desk.analyze = () => []; e2.market.safety[JUP].mintAuthority = 'x'.repeat(44); e2.market.safety[JUP].danger = ['mint']; e2.market.safety[JUP].rugScore = 99;
  e2.trend.signal = (a) => (a === 'JUP' ? { ...sig('LONG', 0.5), sym: 'JUP', mint: JUP, kind: 'spot' } : null);
  jup.quote = stubQuote(e2, JUP); try { e2.desk.pickCoins(); assert.strictEqual((await e2.desk.turn()).length, 0, 'token rischioso scartato'); } finally { jup.quote = real; }
});

test('senza segnale nessun ingresso (anche con consenso fortissimo), spiegato in «Perché non entra»', async () => {
  const e = mkEngine(); e.cfg.trading = true; e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf'].map((id) => ({ id, dir: -1, conf: 1, why: 't' }));
  e.trend.signal = () => null; e.desk.pickCoins();
  assert.strictEqual((await e.desk.turn()).length, 0); const w = e.whyIdle(); assert.strictEqual(w.code, 'trend'); assert.match(w.text, /Prossima candela a 4h/);
});

test('kill switch, limite giornaliero, perps REALE bloccati, Spot REALE spento, lati disattivati: nessun ingresso', async () => {
  const run = async (prep, sym = 'SOL') => { const e = mkEngine(); e.desk.analyze = () => []; e.trend.signal = (a) => (a === sym ? { ...sig('LONG', sym === 'SOL' ? 100 : 0.5), sym, mint: sym === 'SOL' ? SOL : JUP, kind: sym === 'SOL' ? 'perp' : 'spot' } : null); prep(e);
    const real = jup.quote; jup.quote = stubQuote(e, sym === 'SOL' ? SOL : JUP); try { e.desk.pickCoins(); await e.desk.turn(); } finally { jup.quote = real; } return e.book.positions.length; };
  assert.strictEqual(await run((e) => { e.book.killed = true; }), 0, 'kill switch');
  assert.strictEqual(await run((e) => { e.book.cash = 840; }), 0, 'limite giornaliero');
  assert.strictEqual(await run((e) => { e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(1000, e.cfg); }), 0, 'perps reali bloccati'); assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  assert.strictEqual(await run((e) => { e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(1000, e.cfg); }, 'JUP'), 0, 'spot reale spento'); assert.strictEqual(C.DEFAULTS.realSpot, false);
  assert.strictEqual(await run((e) => { e.cfg.perpLongs = false; }), 0, 'long con leva spenti');
  assert.strictEqual(await run((e) => { e.cfg.spotLongs = false; }, 'JUP'), 0, 'Omega spento');
  assert.strictEqual(await run(() => {}), 1, 'in simulazione entra');
});

test('Trend.signal: un segnale già usato non riapre; view con 11 cripto', () => {
  const e = mkEngine(); const B = []; let p = 100; const t0 = Math.floor(Date.now() / H4) * H4 - 599 * H4;
  for (let i = 0; i < 599; i++) { p *= i < 595 ? 0.999 : 1.08; B.push({ t: t0 + i * H4, o: p, h: p * 1.01, l: p * 0.99, c: p }); }
  e.trend.X.SOL = T.prep(B, T.PARAMS.perp); const sg = e.trend.last('SOL'); assert.ok(sg && sg.side === 'LONG');
  e.market.prices[SOL] = { usd: sg.close, ts: Date.now() }; const now = sg.closeT + 60e3;
  assert.ok(e.trend.signal('SOL', now)); e.book.trades.unshift({ perp: true, mint: SOL, symbol: 'SOL', openedAt: sg.closeT + 1 }); assert.strictEqual(e.trend.signal('SOL', now), null);
  const v = e.trend.view(now); assert.strictEqual(v.length, 11); assert.ok(v.find((x) => x.asset === 'SOL').ready); assert.ok(!v.find((x) => x.asset === 'JUP').ready);
});
