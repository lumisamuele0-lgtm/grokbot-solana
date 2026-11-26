const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const S = require('../src/strategy');
const { DEFAULTS, migrateConfig } = require('../src/config');
const jup = require('../src/jupiter');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const MEME = 'Meme1111111111111111111111111111111111111111';

const pos = (o = {}) => ({ entryPrice: 1, slPct: 4, tpPct: 7.2, trailPct: 2.8, openedAt: 0, qty: 100, initQty: 100, core: true, atrPct: 1, ...o });

test('livelli: scalati su volatilità, meme più stretti, trailing mai più largo dello stop', () => {
  const c = S.exitLevels(pos(), DEFAULTS); const m = S.exitLevels(pos({ core: false }), DEFAULTS);
  assert.strictEqual(c.tp1, 4); assert.strictEqual(c.tp2, 8); assert.strictEqual(c.trailDist, 1.5);
  assert.ok(m.tp1 < c.tp1 && m.trailDist < c.trailDist);
  assert.strictEqual(S.exitLevels(pos({ atrPct: 10 }), DEFAULTS).trailDist, 4, 'limitato allo stop iniziale');
});

test('prese parziali: 40% a TP1, poi 30% dell\'iniziale a TP2', () => {
  const p = pos();
  assert.strictEqual(S.exitPlan(p, 1.02, 1, DEFAULTS).action, 'none');
  const r1 = S.exitPlan(p, 1.041, 1, DEFAULTS); assert.strictEqual(r1.action, 'partial'); assert.strictEqual(r1.stage, 1); assert.ok(Math.abs(r1.frac - 0.4) < 1e-9);
  p.tp1Done = true; p.qty = 60; p.beStop = 1.003;
  assert.strictEqual(S.exitPlan(p, 1.06, 1, DEFAULTS).action, 'none');
  const r2 = S.exitPlan(p, 1.081, 1, DEFAULTS); assert.strictEqual(r2.stage, 2); assert.ok(Math.abs(r2.frac - 0.5) < 1e-9, '30/60 della quantità attuale');
});

test('trailing: si attiva dopo +1R, sale col massimo, non scende mai; stop a pareggio dopo TP1', () => {
  const p = pos();
  let r = S.exitPlan(p, 1.03, 1, DEFAULTS); assert.ok(!p.trailStop);
  r = S.exitPlan(p, 1.045, 1, { ...DEFAULTS, partialTp: false }); assert.ok(p.trailStop); assert.strictEqual(r.events[0].type, 'trail');
  const t1 = p.trailStop; assert.ok(Math.abs(t1 - 1.045 * 0.985) < 1e-9);
  S.exitPlan(p, 1.10, 1, { ...DEFAULTS, partialTp: false }); const t2 = p.trailStop; assert.ok(t2 > t1);
  S.exitPlan(p, 1.09, 1, { ...DEFAULTS, partialTp: false }); assert.strictEqual(p.trailStop, t2, 'non scende');
  r = S.exitPlan(p, 1.08, 1, { ...DEFAULTS, partialTp: false }); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /Trailing/);
  const q = pos({ tp1Done: true, beStop: 1.003, qty: 60 });
  r = S.exitPlan(q, 1.002, 1, DEFAULTS); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /pareggio/);
  r = S.exitPlan(pos(), 0.959, 1, DEFAULTS); assert.match(r.reason, /Stop-loss/);
});

test('uscita a tempo e inversione rapida', () => {
  assert.match(S.exitPlan(pos(), 1.001, 91 * 60000, DEFAULTS).reason, /Ferma da 90 min/);
  assert.strictEqual(S.exitPlan(pos(), 1.001, 91 * 60000, { ...DEFAULTS, timeStopOn: false }).action, 'none');
  assert.strictEqual(S.exitPlan(pos({ tp1Done: true, beStop: 0.99 }), 1.001, 91 * 60000, DEFAULTS).action, 'none', 'dopo una presa non scatta');
  assert.match(S.exitPlan(pos(), 1.0, 5 * 60000, DEFAULTS, { m5: -3.5, ema9: 1.02 }).reason, /Inversione/);
  assert.strictEqual(S.exitPlan(pos(), 1.0, 60000, DEFAULTS, { m5: -3.5, ema9: 1.02 }).action, 'none', 'non nei primi 3 minuti');
  assert.match(S.exitPlan(pos({ core: false }), 1.0, 5 * 60000, DEFAULTS, { flow: { tot: 60, ratio: -0.6 } }).reason, /vendite/);
  assert.strictEqual(S.exitPlan(pos(), 1.0, 5 * 60000, { ...DEFAULTS, reversalExit: false }, { m5: -9 }).action, 'none');
});

test('migrazione v3: attiva le uscite furbe senza toccare il resto', () => {
  const { cfg } = migrateConfig({ cfgVersion: 2, maxTradePct: 5, smartExits: false, budget: 3 });
  assert.strictEqual(cfg.smartExits, true); assert.strictEqual(cfg.partialTp, true); assert.strictEqual(cfg.tp1Pct, 40);
  assert.strictEqual(cfg.maxTradePct, 20, 'v12: 20% per operazione'); assert.strictEqual(cfg.budget, 3);
});

function mkEngine() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 100 }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now();
  e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.market.prices[JUP] = { usd: 0.5, ts: now }; e.market.prices[MEME] = { usd: 1, ts: now };
  e.lastPriceOk = now;
  jup.quote = async (inp, out, amt) => { // senza costi per conti esatti
    const dec = { [USDC]: 6, [SOL]: 9, [JUP]: 6, [MEME]: 6 };
    const v = (Number(amt) / 10 ** dec[inp]) * e.market.prices[inp].usd;
    return { inputMint: inp, outputMint: out, outAmount: String(Math.floor((v / e.market.prices[out].usd) * 10 ** dec[out])), priceImpactPct: '0' };
  };
  return e;
}
const setPx = (e, m, v) => { e.market.prices[m] = { usd: v, ts: Date.now() }; };

test('SIMULAZIONE: presa parziale, trailing e chiusura con PnL realizzato/aperto corretto e trade unico al MENTORE', async () => {
  const e = mkEngine(); const b = e.book;
  const fee = e.solToBase((5000 + e.cfg.simPriorityLamports) / LAMPORTS_PER_SOL);
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 }, a: { atrPct: 1 } }, 20, { slPct: 4, tpPct: 7.2, trailPct: 2.8 });
  const p = b.positions[0]; assert.strictEqual(p.qty, 40); assert.strictEqual(p.initQty, 40);
  const n0 = e.kb.n;
  setPx(e, JUP, 0.5 * 1.05); await e.monitor(); // +5% → TP1 (40%)
  assert.strictEqual(b.positions.length, 1); assert.ok(p.tp1Done); assert.ok(Math.abs(p.qty - 24) < 1e-9);
  assert.ok(Math.abs(p.costBase - 12) < 1e-9, 'costo residuo 60%');
  const part = 16 * 0.525 - 8 - fee * 0.4 - fee;
  assert.ok(Math.abs(b.realizedPnl - part) < 1e-9, 'PnL realizzato della parte venduta');
  assert.strictEqual(b.trades.length, 0); assert.strictEqual(e.kb.n, n0, 'MENTORE non impara dai parziali');
  assert.ok(e.st.log.some((l) => /presa parziale 40% su \$JUP a \+5\.0%/.test(l.text)));
  const snap = e.snapshot(); const unreal = snap.positions[0].pnl;
  assert.ok(Math.abs(unreal - (24 * 0.525 - 12 - fee * 0.6)) < 1e-9, 'PnL aperto solo sul resto');
  assert.ok(Math.abs(snap.pnlBox.total - (snap.pnlBox.realized + snap.pnlBox.unrealized)) < 1e-6, 'totale = realizzato + aperto');
  assert.ok(p.beStop > p.entryPrice, 'stop a pareggio');
  setPx(e, JUP, 0.5 * 1.10); await e.monitor(); // +10% → TP2 e trailing attivo
  assert.ok(p.tp2Done); assert.ok(Math.abs(p.qty - 12) < 1e-9); assert.ok(p.trailStop > p.beStop);
  assert.ok(e.st.log.some((l) => /trailing stop (attivato|alzato)/.test(l.text)));
  setPx(e, JUP, 0.5 * 1.05); await e.monitor(); // torna giù → trailing stop chiude il resto
  assert.strictEqual(b.positions.length, 0); assert.strictEqual(b.trades.length, 1);
  const t = b.trades[0];
  assert.match(t.reason, /Trailing stop .* · 2 prese parziali/); assert.strictEqual(t.partials.length, 2);
  assert.ok(Math.abs(t.pnl - b.realizedPnl) < 1e-9, 'trade = somma di parziali + resto');
  assert.ok(Math.abs(t.pnlPct - (t.pnl / 20) * 100) < 1e-9);
  assert.ok(Math.abs(e.equity() - (100 + t.pnl)) < 1e-6, 'saldo coerente');
  assert.strictEqual(e.kb.n, n0 + 1); assert.strictEqual(b.wins, 1);
});

test('presa parziale troppo piccola: salta ma attiva lo stop a pareggio; resto minuscolo → vende tutto', async () => {
  const e = mkEngine(); const b = e.book;
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 } }, 3, { slPct: 4, tpPct: 7.2, trailPct: 2.8 });
  setPx(e, JUP, 0.525); await e.monitor(); // resto 60% di 3 = 1,8 < 2 → vende tutto
  assert.strictEqual(b.positions.length, 0); assert.strictEqual(b.trades.length, 1);
});
