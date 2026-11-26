'use strict';
// Long e short simmetrici: con mercato in salita Alpha va LONG, in discesa SHORT; il flusso ordini non ha bias ribassista.
// Margine per operazione regolabile fino al 100%: contante, esposizione, perdita giornaliera, kill switch e REALE restano attivi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('../src/strategy'); const C = require('../src/config'); const P = require('../src/perps'); const D = require('../src/desk');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore');
const SOL = 'So11111111111111111111111111111111111111112'; const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const series = (n, sign) => { let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); const out = []; let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + sign * (0.0004 + (rnd() - 0.5) * 0.002); out.push({ t: Date.now() - (n - i) * 60e3, o: p, h: p * 1.0008, l: p * 0.9992, c: p, v: 1 }); } return out; };
function mkEngine(sign, cfg = {}, stats = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbls-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: C.CFG_VERSION, spotLongs: false, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  for (const m of Object.keys(P.SHORT_MARKETS)) { const c = series(400, sign); e.market.candles[m] = c; e.market.prices[m] = { usd: c[c.length - 1].c, ts: now };
    e.market.stats[m] = { change1h: sign * 2.4, change6h: sign * 5, change5m: sign * 0.3, liquidityUsd: 5e7, volume24h: 1e9, ...stats }; }
  e.market.prices[SOL] = e.market.prices[SOL] || { usd: 100, ts: now };
  return e;
}

test('flusso ordini: punteggio speculare (acquisti ↔ vendite) a ogni volume; volume in calo con flusso neutro = nessun segnale', () => {
  for (const va of [0.3, 0.5, 1, 1.5, 2.5]) for (const [b, s] of [[600, 400], [520, 480], [900, 100], [500, 500]]) {
    const v6 = 6e7, v1 = (va * v6) / 6;
    const up = S.flowScore({ buys1h: b, sells1h: s, volume1h: v1, volume6h: v6 }), dn = S.flowScore({ buys1h: s, sells1h: b, volume1h: v1, volume6h: v6 });
    assert.ok(Math.abs(up.score + dn.score) < 1e-12, `simmetria b=${b} s=${s} volAccel=${va}`);
  }
  assert.strictEqual(S.flowScore({ buys1h: 500, sells1h: 500, volume1h: 2e6, volume6h: 6e7 }).score, 0, 'volume in calo non è un voto SHORT');
  // prima: 480 acquisti / 520 vendite con volume dimezzato votava SHORT, 520/480 non votava LONG
  const flow = D.ANALYSTS.find((a) => a.id === 'flow');
  const ctx = (b, s) => ({ f: S.flowScore({ buys1h: b, sells1h: s, volume1h: 5e6, volume6h: 6e7 }) });
  assert.strictEqual(flow.fn(ctx(480, 520)).dir, 0); assert.strictEqual(flow.fn(ctx(520, 480)).dir, 0);
  assert.strictEqual(flow.fn(ctx(800, 200)).dir, 1); assert.strictEqual(flow.fn(ctx(200, 800)).dir, -1);
  assert.strictEqual(flow.fn(ctx(0, 2)).dir, 0, 'troppo pochi scambi (2): nessun voto');
});

test('scenario rialzista → Alpha apre LONG; ribassista → SHORT (stessa forza, consenso speculare)', async () => {
  const res = {};
  for (const [k, sign] of [['up', 1], ['down', -1]]) {
    const e = mkEngine(sign, {}, { buys1h: sign > 0 ? 600 : 400, sells1h: sign > 0 ? 400 : 600, volume1h: 1e7, volume6h: 6e7 });
    e.desk.pickCoins(Date.now(), false); await e.desk.turn();
    res[k] = { sides: e.book.positions.map((p) => p.side || 'LONG'), score: e.desk.scan.best[0].score };
    assert.ok(res[k].sides.length >= 1, `${k}: almeno un ingresso`);
  }
  assert.ok(res.up.sides.every((s) => s === 'LONG'), 'in salita solo LONG: ' + res.up.sides);
  assert.ok(res.down.sides.every((s) => s === 'SHORT'), 'in discesa solo SHORT: ' + res.down.sides);
  assert.ok(Math.abs(res.up.score - res.down.score) < 0.05, `consenso simile (${res.up.score} vs ${res.down.score})`);
});

test('margine al 100%: mai oltre il contante, esposizione massima e limiti di rischio sempre attivi; predefinito 20%', async () => {
  assert.strictEqual(C.DEFAULTS.maxTradePct, 20); assert.deepStrictEqual(C.LIMITS.maxTradePct, [1, 100]);
  const vote = (id) => ({ id, dir: 1, conf: 0.95, why: 't' });
  const e = mkEngine(1, { maxTradePct: 100, maxExposurePct: 1000 });
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf', 'macro'].map(vote); e.desk.pickCoins(Date.now(), false);
  await e.desk.turn();
  assert.ok(e.book.positions.length >= 1); const p = e.book.positions[0];
  assert.ok(p.costBase <= 1000 + 1e-9, 'margine ≤ capitale'); assert.ok(e.book.cash >= 0, 'contante mai negativo: ' + e.book.cash);
  assert.ok(p.slPct <= P.liqDistancePct(p.lev) * 0.4 + 1e-9, 'stop sempre prima della liquidazione');
  // esposizione: con 400% e 5x il primo trade al 100% viene ridotto a 80% del capitale
  const e2 = mkEngine(1, { maxTradePct: 100, maxExposurePct: 400 }); e2.desk.analyze = e.desk.analyze; e2.desk.pickCoins(Date.now(), false); await e2.desk.turn();
  const tot = e2.book.positions.reduce((a, q) => a + q.costBase * (q.lev || 1), 0); assert.ok(tot <= 4000 + 1e-6, 'esposizione entro il 400%: ' + tot);
  // perdita giornaliera: nessun nuovo ingresso
  const e3 = mkEngine(1, { maxTradePct: 100 }); e3.desk.analyze = e.desk.analyze; e3.book.cash = 800; e3.desk.pickCoins(Date.now(), false);
  assert.strictEqual((await e3.desk.turn()).length, 0); assert.strictEqual(e3.book.positions.length, 0);
  // REALE: i perps restano bloccati (REAL_SHORTS_ENABLED=false)
  assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  const e4 = mkEngine(1, { maxTradePct: 100 }); e4.cfg.mode = 'REAL'; assert.ok(e4.perpBlock());
  // kill switch: nessun ingresso
  const e5 = mkEngine(1, { maxTradePct: 100 }); e5.desk.analyze = e.desk.analyze; e5.book.killed = true; e5.desk.pickCoins(Date.now(), false);
  assert.strictEqual((await e5.desk.turn()).length, 0);
});

test('interfaccia: cursore fino al 100% con avviso rosso sopra il 20%', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(js, /k: 'maxTradePct'[^\n]*max: 100/); assert.match(js, /Rischio molto alto: una sola operazione può azzerare il capitale/);
  assert.match(js, /maxTradePct > 20/);
});
