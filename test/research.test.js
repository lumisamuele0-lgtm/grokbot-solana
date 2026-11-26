const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ST = require('../src/strategies');
const B = require('../src/backtest');
const P = require('../src/perps');
const { Research, evaluate } = require('../src/research');
const { DEFAULTS } = require('../src/config');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
// candele sintetiche da una lista di prezzi di chiusura (apertura = chiusura precedente)
function bars(closes, { tf = 15, wick = 0 } = {}) { const t0 = Date.UTC(2026, 9, 1); return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: t0 + i * tf * 60000, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, v: 1000 }; }); }
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function randomWalk(n, seed, vol = 0.004) { const r = rng(seed); const out = [100]; for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (r() - 0.5) * 2 * vol)); return out; }
const cfg = { ...DEFAULTS };

test('indicatori: EMA, RSI di Wilder, Donchian senza guardare il futuro', () => {
  const e = ST.emaS([1, 2, 3, 4, 5], 3); assert.strictEqual(e[1], null); assert.ok(near(e[4], 4.0625));
  const up = ST.rsiS([1, 2, 3, 4, 5, 6], 3); assert.strictEqual(up[5], 100);
  const x = ST.context(bars([1, 2, 3, 4, 5, 10]));
  assert.strictEqual(x.hi(3)[5], Math.max(x.h[2], x.h[3], x.h[4]), 'il massimo Donchian usa solo le candele PRECEDENTI');
  assert.ok(x.adx(14).every((v) => v == null || (v >= 0 && v <= 100)));
});

test('strategie: il segnale alla candela i non cambia se si aggiungono candele future (nessun lookahead)', () => {
  const cl = randomWalk(700, 7);
  const a = ST.context(bars(cl.slice(0, 500)), { dayBars: 96 }); const b = ST.context(bars(cl), { dayBars: 96 });
  for (const s of ST.STRATEGIES.filter((q) => !['funding', 'fng'].includes(q.id))) {
    const sa = ST.signals(s, a, s.grid[0]); const sb = ST.signals(s, b, s.grid[0]);
    assert.deepStrictEqual(sa, sb.slice(0, 500), s.id);
  }
  // dati esterni: si usa solo il valore già pubblicato alla chiusura della candela
  const k = bars([1, 2, 3]); const x = ST.context(k, { tfMs: 15 * 60000, fng: [{ t: k[1].t + 15 * 60000, value: 10 }, { t: k[2].t + 16 * 60000, value: 90 }] });
  assert.strictEqual(x.at(x.fng, 0, 'value'), null); assert.strictEqual(x.at(x.fng, 1, 'value'), 10); assert.strictEqual(x.at(x.fng, 2, 'value'), 10);
});

test('backtest: commissioni Jupiter (0,06% + 0,06%) + slittamento + prestito, moltiplicati per la leva', () => {
  assert.ok(near(B.feePctOnMargin(5, 0), 5 * (0.12 + 0.06)), 'a 5x: 0,9% del margine');
  assert.ok(near(B.feePctOnMargin(10, 10), 10 * (0.18 + 0.001 * 10)));
  // stop sempre entro il 40% della distanza di liquidazione, mai oltre il 6%
  assert.ok(B.riskFor(20, cfg, 10).slPct <= P.liqDistancePct(10) * 0.4 + 1e-9);
  assert.ok(B.riskFor(20, cfg, 5).slPct <= 6);
  assert.strictEqual(B.riskFor(0.1, cfg, 5).slPct, cfg.slMinPct);
});

test('backtest: stop-loss LONG = −leva × stop − costi; gap oltre lo stop esce all\'apertura', () => {
  const lev = 5; const c = { ...cfg, partialTp: false, trailOn: false };
  const k = bars([...Array(30).fill(100), 100, 100, 97, 97, 97]); // l'ATR è ~0 → stop al minimo (1,5%)
  const x = ST.context(k); const sig = new Array(k.length).fill(0); sig[30] = 1;
  const tr = B.simulate(x, sig, { cfg: c, lev, tfMin: 15 });
  assert.strictEqual(tr.length, 1); const t = tr[0];
  // ingresso all'apertura della candela 31 = 100; la candela 32 apre a 100 e tocca 97 → stop a 98,5
  const exp = lev * -0.015 - B.feePctOnMargin(lev, 0.5) / 100; // costi contati dalla candela del segnale (prudente)
  assert.ok(near(t.r, exp, 1e-9), `${t.r} vs ${exp}`);
  // gap: la candela apre già sotto lo stop → si esce al prezzo di apertura (peggiore)
  const k2 = bars([...Array(30).fill(100), 100, 100]); k2.push({ t: k2[31].t + 900000, o: 96, h: 96, l: 95, c: 95.5, v: 1 });
  const g = B.simulate(ST.context(k2), [...sig.slice(0, 33)], { cfg: c, lev, tfMin: 15 })[0];
  assert.ok(near(g.r, lev * -0.04 - B.feePctOnMargin(lev, 0.5) / 100, 1e-9));
});

test('backtest: lo SHORT guadagna in ribasso (specchio del LONG), mai più del margine perso', () => {
  const lev = 10; const c = { ...cfg, partialTp: false, trailOn: false };
  const k = bars([...Array(30).fill(100), 100, 100, 99, 98, 97, 96, 95, 94, 93, 92]);
  const sig = new Array(k.length).fill(0); sig[30] = -1;
  const t = B.simulate(ST.context(k), sig, { cfg: c, lev, tfMin: 15 })[0];
  assert.ok(t && t.dir === -1 && t.r > 0, 'short in guadagno');
  // target classico = stop × rischio/rendimento
  const sl = B.riskFor(0, c, lev).slPct / 100; assert.ok(t.r >= lev * sl * c.rewardRisk - B.feePctOnMargin(lev, 10) / 100 - 1e-9);
  const crash = bars([...Array(30).fill(100), 100, 100]); crash.push({ t: crash[31].t + 900000, o: 300, h: 300, l: 300, c: 300, v: 1 });
  const t2 = B.simulate(ST.context(crash), sig, { cfg: c, lev, tfMin: 15 })[0]; assert.strictEqual(t2.r, -1, 'perdita limitata al margine');
});

test('backtest: presa parziale a 1R e stop a pareggio', () => {
  const lev = 5; const c = { ...cfg, trailOn: false, partialTp: true, smartExits: true };
  const R = c.slMinPct / 100; const tp1 = 100 * (1 + R * c.tp1R);
  const k = bars([...Array(30).fill(100), 100, 100, tp1 + 0.01, 100, 99]);
  const sig = new Array(k.length).fill(0); sig[30] = 1;
  const t = B.simulate(ST.context(k), sig, { cfg: c, lev, tfMin: 15 })[0];
  const be = c.beBufferPct / 100;
  const gross = (c.tp1Pct / 100) * R * c.tp1R + (1 - c.tp1Pct / 100) * be;
  assert.ok(near(t.r, lev * gross - B.feePctOnMargin(lev, ((t.j - t.i) * 15) / 60) / 100, 1e-9));
});

test('statistiche: drawdown sul capitale (margine per operazione), shrinkage, profit factor', () => {
  const s = B.stats([{ r: 0.1 }, { r: -0.2 }, { r: 0.1 }], { marginPct: 7 });
  const e1 = 1.007, e2 = e1 * 0.986; assert.ok(near(s.ddPct, ((e1 - e2) / e1) * 100, 1e-9));
  assert.ok(near(s.expPct, 0), 'media zero'); assert.ok(near(s.pf, 1));
  const g = B.stats(Array(5).fill({ r: 0.02 })); assert.ok(near(g.shrunkPct, (2 * 5) / 25), 'con poche operazioni il rendimento atteso si riduce');
  assert.strictEqual(B.passes(g), false, '5 operazioni non bastano');
});

test('walk-forward: su un mercato casuale (senza vantaggio) quasi nessuna strategia passa il test fuori campione', () => {
  const cl = randomWalk(2000, 42); const x = ST.context(bars(cl), { dayBars: 96 });
  let active = 0;
  for (const s of ST.STRATEGIES.filter((q) => !['funding', 'fng'].includes(q.id))) {
    const w = B.walkForward(s, x, { cfg, lev: 5, tfMin: 15 });
    assert.ok(w.oos.n >= 0 && Number.isFinite(w.isScore)); assert.ok(s.grid.includes(w.params));
    if (B.passes(w.oos)) active++;
  }
  assert.ok(active <= 1, `attive per caso: ${active}`);
});

test('ricerca: il timeframe si sceglie in campione, attiva/scartata si decide fuori campione', () => {
  const mk = (isScore, oos) => ({ isScore, oos: { n: 20, winRate: 60, expPct: 1, shrunkPct: 0.5, tstat: 2, pf: 1.5, retPct: 2, ddPct: 2, sharpe: 1, ...oos }, byRegime: { rialzo: { n: 6, shrunkPct: -0.2 }, ribasso: { n: 2, shrunkPct: 1 }, laterale: { n: 0, shrunkPct: 0 } }, params: {}, longs: 10, shorts: 10 });
  const r = evaluate({ '5m': mk(1, { shrunkPct: -1, expPct: -1 }), '1h': mk(0.2, {}) });
  assert.strictEqual(r.tf, '5m', 'scelto sul train, anche se fuori campione va peggio'); assert.strictEqual(r.active, false);
  const ok = evaluate({ '1h': mk(0.2, {}) }); assert.ok(ok.active); assert.deepStrictEqual(ok.regimeOff, ['rialzo']); assert.ok(ok.weight >= 0.5 && ok.weight <= 1.5);
});

test('ricerca: segnale al CAPO solo da strategie attive, non scadute e non perdenti nel regime attuale', () => {
  const r = new Research({ dataDir: null });
  const now = Date.now();
  r.st.results.SOL = { funding: { active: true, weight: 1.2, regimeOff: [] }, squeeze: { active: true, weight: 0.8, regimeOff: ['ribasso'] }, macd: { active: false, weight: 0, regimeOff: [] } };
  r.st.live.SOL = { regime: 'ribasso', signals: [
    { id: 'funding', dir: -1, until: now + 6e5, atrPct: 1.1 }, { id: 'squeeze', dir: -1, until: now + 6e5 }, { id: 'macd', dir: -1, until: now + 6e5 }, { id: 'funding', dir: 1, until: now - 1 },
  ] };
  const s = r.signalFor('SOL', 'SHORT'); assert.ok(near(s.score, 1.2)); assert.deepStrictEqual(s.strategies, ['funding']); assert.strictEqual(s.atrPct, 1.1);
  const l = r.signalFor('SOL', 'LONG'); assert.strictEqual(l.score, 0); assert.ok(near(l.against, 1.2));
  assert.strictEqual(r.signalFor('BONK', 'LONG').score, 0);
  const ps = new Research({ dataDir: null }).publicStatus(); assert.ok(ps.strategies.length === ST.STRATEGIES.length); assert.ok(!JSON.stringify(ps).match(/wallet|secret|pin/i));
});

function mkEngine(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 7, ...extra }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  const cs = []; const t = now - 200 * 60000; for (let i = 0; i < 200; i++) { const c = 100 + 0.05 * Math.sin(i / 3); cs.push({ t: t + i * 60000, o: c, h: c * 1.0005, l: c * 0.9995, c, v: 1 }); }
  e.market.candles[SOL] = cs; e.market.prices[SOL] = { usd: cs[199].c, ts: now };
  return e;
}
test('pipeline: le strategie attive del MENTORE possono far entrare il CAPO; quelle contrarie bloccano', async () => {
  const e0 = mkEngine(); await e0.pipeline(); assert.strictEqual(e0.book.positions.length, 0, 'mercato piatto: il CAPO da solo non entra');
  const e = mkEngine();
  e.research.signalFor = (sym, side) => (side === 'SHORT' ? { score: 1.2, against: 0, strategies: ['funding'], opposite: [], atrPct: 1 } : { score: 0, against: 1.2, strategies: [], opposite: ['funding'], atrPct: null });
  await e.pipeline();
  const p = e.book.positions[0]; assert.ok(p, 'short aperto sul segnale delle strategie'); assert.strictEqual(p.side, 'SHORT'); assert.ok(p.perp); assert.strictEqual(p.lev, 5);
  assert.ok(Math.abs(p.costBase - 200) < 0.01, 'margine pieno 20% (consenso massimo)'); assert.ok(p.feat.includes('short.strat:funding'));
  assert.ok(p.slPct <= P.liqDistancePct(5) * 0.4, 'stop prima della liquidazione');
  assert.ok(e.st.log.some((l) => l.agent === 'MENTORE' && /Funding contrarian/.test(l.text)));
  assert.ok(e.snapshot().research.strategies.length === ST.STRATEGIES.length);
});
