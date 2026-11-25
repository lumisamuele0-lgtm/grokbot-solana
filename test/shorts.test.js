const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const P = require('../src/perps');
const S = require('../src/strategy');
const K = require('../src/knowledge');
const { DEFAULTS, sanitize, migrateConfig } = require('../src/config');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');
const ETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now();
  e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.market.prices[ETH] = { usd: 3000, ts: now };
  e.lastPriceOk = now;
  return e;
}
const setPx = (e, m, usd) => { e.market.prices[m] = { usd, ts: Date.now() }; };
function candles(n, drift, amp) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 100 * (1 + drift * i) + amp * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
const plan = { slPct: 2, tpPct: 4, trailPct: 1.4 };

test('perps: codifica identica ad Anchor e indirizzi PDA reali di mainnet', () => {
  const owner = new PublicKey('H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS');
  const inc = P.increaseShortIx({ owner, market: 'SOL', sizeUsd6: 14000000, collateral6: 7000000, minPrice6: 1, counter: 12345 });
  assert.strictEqual(inc.ix.data.toString('hex'), 'b855c71869ab9c38809fd50000000000c0cf6a0000000000020100000000000000003930000000000000');
  assert.strictEqual(inc.ix.keys.length, 16); assert.ok(inc.ix.keys[0].isSigner);
  const dec = P.decreaseShortIx({ owner, market: 'SOL', entire: true, maxPrice6: 100000000000, counter: 777 });
  assert.strictEqual(dec.ix.data.toString('hex'), '4ac6c356c163014f0000000000000000000000000000000000e87648170000000001010903000000000000');
  // posizione short SOL reale trovata su mainnet il 25/11/2026
  const pda = P.positionPda(new PublicKey('8vXZp5DRsAKGv6QwfqKjZ2MQgMT6arfYYpoCqAN2b9aw'), P.CUSTODY.SOL, 'short');
  assert.strictEqual(pda.toBase58(), '13pmELWTxfCxLnKSSeNUH1eevMQVHTZr8vqDEiSDBT5');
  assert.throws(() => P.increaseShortIx({ owner, market: 'DOGE', sizeUsd6: 1, collateral6: 1, minPrice6: 1, counter: 1 }), /non supportato/);
  assert.strictEqual(P.REAL_SHORTS_ENABLED, false, 'short reali spenti finché il keeper non è verificato con fondi veri');
});

test('short: PnL, commissioni 0,06% e prestito orario', () => {
  const m = P.openShortModel({ marginUsd: 70, lev: 2, priceUsd: 100 });
  assert.strictEqual(m.sizeUsd, 140); assert.ok(Math.abs(m.openFeeUsd - 0.084) < 1e-9); assert.ok(Math.abs(m.collateralUsd - 69.916) < 1e-9);
  const p = { entryPrice: 100, sizeUsd: 140, collateralUsd: m.collateralUsd, borrowUsd: 0, openedAt: 0, lastAccrual: 0 };
  const st = P.shortState(p, 95, 10 * 3.6e6); // −5% dopo 10 ore
  assert.ok(Math.abs(st.grossPnl - 7) < 1e-9, 'guadagno = esposizione × calo');
  assert.ok(Math.abs(st.borrowUsd - 140 * 0.00001 * 10) < 1e-9, 'prestito 0,001%/h');
  assert.ok(Math.abs(st.closeFeeUsd - 0.084) < 1e-9);
  assert.ok(Math.abs(st.valueUsd - (69.916 + 7 - 0.014 - 0.084)) < 1e-9);
  const up = P.shortState(p, 105, 0); assert.ok(up.valueUsd < 70 - 7 + 0.01, 'il rialzo fa perdere il doppio con 2x');
});

test('short: liquidazione ~+49,7% a 2x, stop-loss sempre molto prima', () => {
  const m = P.openShortModel({ marginUsd: 100, lev: 2, priceUsd: 100 });
  const liq = P.liquidationPrice({ entryPrice: 100, ...m });
  assert.ok(liq > 149.5 && liq < 149.8, `liq ${liq}`);
  assert.strictEqual(S.shortStopCap(6, 100, liq), 6);
  assert.ok(S.shortStopCap(40, 100, liq) <= 0.4 * 49.8, 'stop limitato al 40% della distanza dalla liquidazione');
});

test('leva: solo 2x / 5x / 10x, limite rigido 10x (impostazioni e motore)', () => {
  assert.strictEqual(sanitize({ leverage: 50 }, DEFAULTS).leverage, 10);
  assert.strictEqual(sanitize({ leverage: 0.2 }, DEFAULTS).leverage, 2);
  assert.strictEqual(sanitize({ leverage: 4 }, DEFAULTS).leverage, 5);
  assert.strictEqual(sanitize({ leverage: 8 }, DEFAULTS).leverage, 10);
  assert.strictEqual(DEFAULTS.leverage, 2, 'default resta 2x');
  assert.strictEqual(DEFAULTS.perpLongs, false, 'long con leva spenti di default');
  const e = mkEngine(); e.cfg.leverage = 50; assert.strictEqual(e.leverage(), 10);
  e.cfg.leverage = 5; assert.strictEqual(e.leverage(), 5);
  assert.strictEqual(migrateConfig({ cfgVersion: 5, leverage: 2 }).cfg.leverage, 2, 'nessuna migrazione verso leve più alte');
});

test('liquidazione a 5x e 10x (short e long) e stop sempre dentro', () => {
  const exp = { 2: 49.68, 5: 19.68, 10: 9.68 };
  for (const lev of [2, 5, 10]) {
    const d = P.liqDistancePct(lev); assert.ok(Math.abs(d - exp[lev]) < 0.01, `${lev}x → ${d}`);
    const m = P.openShortModel({ marginUsd: 100, lev, priceUsd: 100 });
    const liqS = P.liquidationPrice({ entryPrice: 100, side: 'SHORT', ...m });
    const liqL = P.liquidationPrice({ entryPrice: 100, side: 'LONG', ...m });
    assert.ok(Math.abs(liqS - (100 + d)) < 1e-9 && Math.abs(liqL - (100 - d)) < 1e-9);
    for (const sl of [1, 3, 6, 20]) { const c = S.shortStopCap(sl, 100, liqS); assert.ok(c <= d * 0.4 + 1e-9 && c <= sl); assert.ok(Math.abs(S.shortStopCap(sl, 100, liqL) - c) < 1e-9, 'stesso limite per i long'); }
    // al prezzo di liquidazione il valore netto è ~ il margine di mantenimento (size/500), mai sotto zero
    const st = P.shortState({ entryPrice: 100, side: 'SHORT', ...m, openedAt: 0, lastAccrual: 0 }, liqS, 0);
    assert.ok(Math.abs(st.valueUsd - m.sizeUsd / 500) < 1e-6);
  }
  assert.ok(Math.abs(S.shortStopCap(6, 100, 100 + P.liqDistancePct(10)) - 3.872) < 0.01, '10x: stop max ~3,87%');
});

test('SIMULAZIONE 10x: stop stretto, prese parziali più vicine, chiusura prima della liquidazione', async () => {
  const e = mkEngine(); e.cfg.leverage = 10;
  await e.openShort({ m: ETH, s: { symbol: 'ETH' }, a: { atrPct: 0.5 } }, 70, { slPct: 6, tpPct: 12, trailPct: 4 });
  const p = e.book.positions[0];
  assert.strictEqual(p.lev, 10); assert.strictEqual(p.sizeUsd, 700, 'margine 7% invariato, esposizione 70%');
  assert.ok(p.slPct <= 3.88, `stop ${p.slPct}`); assert.ok(p.liqPrice > 3000 * 1.096 && p.liqPrice < 3000 * 1.097);
  const L = S.exitLevels(p, e.cfg); assert.ok(L.tp1 <= 3.88 && L.trailDist <= p.slPct, 'prese e trailing scalano con lo stop');
  // salto improvviso oltre lo stop e oltre l'80% della distanza: chiude comunque, senza arrivare a zero
  setPx(e, ETH, 3000 * 1.08); await e.monitor();
  assert.strictEqual(e.book.positions.length, 0); const t = e.book.trades[0];
  assert.match(t.reason, /liquidazione|Stop-loss/); assert.ok(t.outBase > 0, 'mai liquidato');
});

test('SIMULAZIONE: long con leva 5x su SOL (perps) e REALE ancora bloccato', async () => {
  const e = mkEngine(); e.cfg.leverage = 5;
  await e.openShort({ m: SOL, s: { symbol: 'SOL' }, a: { atrPct: 0.5 } }, 70, plan, 'LONG');
  const p = e.book.positions[0]; assert.strictEqual(p.side, 'LONG'); assert.ok(p.perp); assert.ok(p.liqPrice < 100 * 0.81 && p.liqPrice > 100 * 0.80);
  setPx(e, SOL, 102.1); await e.monitor(); // +2,1% → TP1
  assert.ok(p.tp1Done); assert.ok(e.book.realizedPnl > 0);
  setPx(e, SOL, 99.5); await e.monitor(); // sotto il pareggio → chiude
  assert.strictEqual(e.book.positions.length, 0); const t = e.book.trades[0]; assert.strictEqual(t.side, 'LONG'); assert.strictEqual(t.lev, 5);
  assert.ok(Math.abs(e.equity() - (1000 + e.book.realizedPnl)) < 1e-6);
  const e3 = mkEngine(); e3.cfg.mode = 'REAL'; e3.st.books.REAL = newBook(1000, e3.cfg); e3.cfg.leverage = 10;
  await e3.openShort({ m: SOL, s: { symbol: 'SOL' }, a: {} }, 70, plan, 'LONG');
  assert.strictEqual(e3.book.positions.length, 0, 'perps reali spenti');
});

test('migrazione v5: attiva gli short a 2x e non tocca il resto', () => {
  const r = migrateConfig({ cfgVersion: 4, maxTradePct: 5, budget: 33, shortsOn: false, leverage: 1, scanMemes: false });
  assert.strictEqual(r.changed, true); assert.strictEqual(r.cfg.cfgVersion, 5);
  assert.strictEqual(r.cfg.shortsOn, true); assert.strictEqual(r.cfg.leverage, 2);
  assert.strictEqual(r.cfg.maxTradePct, 5); assert.strictEqual(r.cfg.budget, 33);
  const again = migrateConfig(r.cfg); assert.strictEqual(again.changed, false);
  const off = migrateConfig({ ...r.cfg, shortsOn: false }); assert.strictEqual(off.cfg.shortsOn, false, 'dopo la migrazione la scelta di Samuele resta');
});

test('analista: segnale SHORT speculare al LONG', () => {
  const dn = S.analyze(candles(200, -0.0005, 0.3)); assert.strictEqual(dn.short.signal, true); assert.notStrictEqual(dn.signal, 'LONG');
  const upA = S.analyze(candles(200, 0.0005, 0.3)); assert.strictEqual(upA.short.signal, false); assert.strictEqual(upA.signal, 'LONG');
});

test('uscite furbe specchiate per gli short: TP1, pareggio, trailing, rimbalzo', () => {
  const cfg = { ...DEFAULTS };
  const pos = { side: 'SHORT', entryPrice: 100, qty: 1, initQty: 1, slPct: 2, tpPct: 4, openedAt: Date.now() - 10 * 60000, core: true, atrPct: 0.5 };
  assert.match(S.exitPlan({ ...pos }, 102.1, Date.now(), cfg).reason, /Stop-loss/);
  const p1 = { ...pos }; const r1 = S.exitPlan(p1, 97.9, Date.now(), cfg);
  assert.strictEqual(r1.action, 'partial'); assert.strictEqual(r1.stage, 1);
  // trailing: il prezzo scende a 97 → stop reale sopra il minimo, mai sopra l'entrata dopo il pareggio
  const p2 = { ...pos, tp1Done: true, beStop: 100 * 1.003 };
  S.exitPlan(p2, 97, Date.now(), cfg);
  const stop = S.effectiveStop(p2); assert.ok(stop > 97 && stop < 100, `stop ${stop}`);
  assert.match(S.exitPlan(p2, stop + 0.01, Date.now(), cfg).reason, /Trailing stop/);
  const r4 = S.exitPlan({ ...pos }, 100.5, Date.now(), cfg, { m5: 3.5, ema9: 100.2 });
  assert.match(r4.reason, /Rimbalzo rapido \(\+3\.50% in 5 min\)/);
});

test('SIMULAZIONE: short aperto, presa parziale, chiusura e saldo coerente', async () => {
  const e = mkEngine();
  await e.openShort({ m: SOL, s: { symbol: 'SOL' }, a: { atrPct: 0.5 }, feat: ['lato:short'] }, 70, plan);
  const b = e.book; const p = b.positions[0];
  assert.strictEqual(p.side, 'SHORT'); assert.strictEqual(p.lev, 2); assert.strictEqual(p.sizeUsd, 140);
  assert.ok(p.liqPrice > 149 && p.liqPrice < 150);
  const eq0 = e.equity(); assert.ok(Math.abs(eq0 - (1000 - 0.084 * 2 - p.feesBase)) < 0.01, `equity ${eq0}`);
  setPx(e, SOL, 97.9); await e.monitor(); // −2,1% → TP1 40%
  assert.strictEqual(b.positions.length, 1); assert.ok(p.tp1Done); assert.ok(Math.abs(p.sizeUsd - 84) < 1e-6);
  setPx(e, SOL, 100.5); await e.monitor(); // torna sopra il pareggio → chiude
  assert.strictEqual(b.positions.length, 0);
  const t = b.trades[0]; assert.strictEqual(t.side, 'SHORT'); assert.ok(t.pnl > 0, 'la presa parziale ha bloccato un guadagno');
  assert.ok(Math.abs(e.equity() - (1000 + b.realizedPnl)) < 1e-6, 'saldo = budget + PnL realizzato');
  assert.ok(t.perpFeesUsd > 0.16, 'commissioni perps contabilizzate');
});

test('SIMULAZIONE: stop-loss dello short sul rialzo', async () => {
  const e = mkEngine({ smartExits: false });
  await e.openShort({ m: ETH, s: { symbol: 'ETH' }, a: { atrPct: 0.5 } }, 70, plan);
  setPx(e, ETH, 3070); await e.monitor(); // +2,33%
  const t = e.book.trades[0]; assert.match(t.reason, /Stop-loss/); assert.ok(t.pnl < 0);
  assert.ok(t.pnlPct > -6 && t.pnlPct < -4.5, `perdita sul margine ~2× il movimento: ${t.pnlPct}`);
});

test('pipeline: short su SOL in ribasso, mai long e short insieme, REALE bloccato', async () => {
  const e = mkEngine({ maxTradePct: 7 });
  e.market.candles[SOL] = candles(200, -0.0005, 0.3);
  setPx(e, SOL, e.market.candles[SOL][199].c);
  e.refreshBalances = async () => {};
  await e.pipeline();
  const b = e.book; assert.strictEqual(b.positions.length, 1); const p = b.positions[0];
  assert.strictEqual(p.side, 'SHORT'); assert.strictEqual(p.mint, SOL);
  assert.ok(Math.abs(p.costBase - 70) < 0.01, 'margine = 7% del capitale'); assert.ok(Math.abs(p.sizeUsd - 140) < 0.1, 'esposizione 14%');
  await e.pipeline(); assert.strictEqual(b.positions.filter((x) => x.mint === SOL).length, 1, 'nessun secondo trade sullo stesso asset');
  // con un LONG su SOL aperto non si apre lo short
  const e2 = mkEngine(); e2.market.candles[SOL] = e.market.candles[SOL]; setPx(e2, SOL, p.entryPrice); e2.refreshBalances = async () => {};
  e2.book.positions.push({ id: 'x', mint: SOL, symbol: 'SOL', qty: 0.1, qtyRaw: '100000000', decimals: 9, costBase: 10, feesBase: 0, entryPrice: 100, slPct: 2, tpPct: 4, openedAt: Date.now() });
  await e2.pipeline(); assert.ok(!e2.book.positions.some((x) => x.side === 'SHORT'));
  // REALE: gli short non partono
  const e3 = mkEngine(); e3.cfg.mode = 'REAL'; e3.st.books.REAL = newBook(1000, e3.cfg);
  await e3.openShort({ m: SOL, s: { symbol: 'SOL' }, a: {} }, 70, plan);
  assert.strictEqual(e3.book.positions.length, 0);
});

test('MENTORE: il lato (long/short) è una caratteristica separata', () => {
  const fs_ = K.featuresOf({ side: 'short', a: { rsi: 40, m15: -1, atrPct: 1, short: { checks: { a: true } } }, f: { score: -0.5 }, core: true });
  assert.ok(fs_.includes('lato:short')); assert.ok(fs_.every((k) => k === 'lato:short' || k.startsWith('short.')));
  assert.ok(K.featuresOf({ a: { rsi: 60 }, core: true }).includes('lato:long'));
});

test('pipeline: con "long con leva" attivo, un LONG su SOL va su Jupiter Perps alla leva scelta', async () => {
  const e = mkEngine({ cfgVersion: 5, perpLongs: true, leverage: 5 }); e.refreshBalances = async () => {};
  e.market.candles[SOL] = candles(200, 0.0005, 0.3); setPx(e, SOL, e.market.candles[SOL][199].c);
  e.market.stats[SOL] = { symbol: 'SOL', buys1h: 60, sells1h: 40, volume1h: 1e6, volume6h: 6e6, decimals: 9 };
  e.watch.set(SOL, { symbol: 'SOL', core: true });
  await e.pipeline();
  const p = e.book.positions[0]; assert.ok(p, 'posizione aperta'); assert.strictEqual(p.side, 'LONG'); assert.ok(p.perp); assert.strictEqual(p.lev, 5);
  assert.ok(Math.abs(p.costBase - 70) < 0.01 && Math.abs(p.sizeUsd - 350) < 0.1, 'margine 7%, esposizione 35%');
  assert.ok(p.feat.includes('leva:5x'));
});
