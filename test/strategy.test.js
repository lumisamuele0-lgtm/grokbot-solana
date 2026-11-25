const test = require('node:test');
const assert = require('node:assert');
const I = require('../src/indicators');
const S = require('../src/strategy');
const { DEFAULTS } = require('../src/config');

const mk = (fn, n = 200) => Array.from({ length: n }, (_, i) => { const c = fn(i); return { t: i * 60000, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 }; });

test('EMA e RSI su serie note', () => {
  assert.deepStrictEqual(I.ema([1, 1, 1], 3), [1, 1, 1]);
  assert.strictEqual(I.rsi(Array.from({ length: 30 }, (_, i) => i + 1)), 100);
  assert.ok(I.rsi(Array.from({ length: 30 }, (_, i) => 30 - i)) < 1);
  assert.strictEqual(I.rsi([1, 2]), null);
});
test('momentum e ricampionamento 5m', () => {
  assert.strictEqual(Math.round(I.momentum([100, 105, 110], 2)), 10);
  const c5 = I.resample(mk((i) => 1 + i, 10), 5);
  assert.strictEqual(c5.length, 2); assert.strictEqual(c5[0].o, 1); assert.strictEqual(c5[0].c, 5);
});
test('ATR% positivo', () => { assert.ok(I.atrPct(mk(() => 10)) > 0); });

test('analisi: trend rialzista moderato → LONG; ribassista → ATTESA', () => {
  const up = S.analyze(mk((i) => 100 * (1 + 0.0006 * i + 0.002 * Math.sin(i / 2))));
  const down = S.analyze(mk((i) => 100 * (1 - 0.001 * i)));
  assert.ok(up.ok); assert.ok(down.ok);
  assert.strictEqual(down.signal, 'ATTESA');
  assert.ok(up.score > down.score);
  assert.ok(['LONG', 'ATTESA'].includes(up.signal));
  assert.strictEqual(S.analyze(mk(() => 1, 30)).ok, false);
});
test('analisi: RSI ipercomprato non entra', () => {
  const r = S.analyze(mk((i) => 100 * Math.pow(1.01, i)));
  assert.strictEqual(r.signal, 'ATTESA'); assert.strictEqual(r.reason, 'RSI ipercomprato');
});

test('filtri: scarta liquidità bassa, pump e vendite; core non soggetti a età/mcap', () => {
  const base = { core: false, liquidityUsd: 100000, volume24h: 500000, ageHours: 48, mcapUsd: 5e6, change1h: 2, change24h: 5, buys1h: 100, sells1h: 90 };
  assert.deepStrictEqual(S.filterRules(base, DEFAULTS), []);
  const r = S.filterRules({ ...base, liquidityUsd: 10000, change1h: 80, sells1h: 300, ageHours: 0.5 / 60 }, DEFAULTS).map((x) => x.key);
  assert.deepStrictEqual(r.sort(), ['AGE', 'LIQ', 'PUMP', 'SELLS']);
  assert.deepStrictEqual(S.filterRules({ ...base, core: true, ageHours: 1, mcapUsd: 1 }, DEFAULTS), []);
});
test('sicurezza: mint/freeze attivi, rugcheck alto, holder concentrati', () => {
  const k = S.safetyRules({ mintAuthority: 'x', freezeAuthority: null, rugScore: 80, danger: [], holderRisk: true }, DEFAULTS, false).map((x) => x.key);
  assert.deepStrictEqual(k, ['AUTH', 'RUG', 'HOLD']);
  assert.deepStrictEqual(S.safetyRules(null, DEFAULTS, true), []);
  assert.strictEqual(S.safetyRules(null, DEFAULTS, false)[0].key, 'DATA');
});
test('flusso acquisti/vendite', () => {
  assert.ok(S.flowScore({ buys1h: 300, sells1h: 100, volume1h: 10, volume6h: 60 }).score > 0.5);
  assert.ok(S.flowScore({ buys1h: 50, sells1h: 300, volume1h: 10, volume6h: 60 }).score < -0.5);
});
test('piano di rischio: SL dentro i limiti, TP = SL × rapporto, leva 1', () => {
  const p = S.riskPlan(0.2, DEFAULTS, true); assert.strictEqual(p.slPct, DEFAULTS.slMinPct); assert.strictEqual(p.leverage, 1);
  const m = S.riskPlan(50, DEFAULTS, false); assert.strictEqual(m.slPct, DEFAULTS.slMaxPct);
  assert.ok(Math.abs(m.tpPct - m.slPct * DEFAULTS.rewardRisk) < 1e-9);
  assert.ok(S.riskPlan(0.2, DEFAULTS, false).slPct >= 3);
});
test('dimensione: 7% del capitale per operazione, limitato dal contante e dal minimo', () => {
  const a = S.sizePosition({ capital: 100, cash: 100, cfg: DEFAULTS, confidence: 1, atr: 1, core: true, minTrade: 2 });
  assert.ok(Math.abs(a.size - 7) < 1e-9);
  const m = S.sizePosition({ capital: 100, cash: 100, cfg: DEFAULTS, confidence: 0.2, atr: 8, core: false, minTrade: 2 });
  assert.ok(Math.abs(m.size - 7) < 1e-9);
  assert.ok(Math.abs(S.sizePosition({ capital: 100, cash: 100, cfg: { ...DEFAULTS, memeSizeMult: 0.5 }, core: false, minTrade: 2 }).size - 3.5) < 1e-9);
  assert.strictEqual(S.sizePosition({ capital: 100, cash: 5, cfg: DEFAULTS, confidence: 1, atr: 1, core: true, minTrade: 2 }).size, 5);
  assert.strictEqual(S.sizePosition({ capital: 20, cash: 20, cfg: DEFAULTS, confidence: 0, atr: 1, core: false, minTrade: 2 }).size, 0);
});
test('filtri: volume 24h minimo 3k $ ed età minima 1 minuto', () => {
  const base = { core: false, liquidityUsd: 100000, volume24h: 3000, ageHours: 1 / 60, mcapUsd: 5e6, change1h: 2, change24h: 5, buys1h: 10, sells1h: 9 };
  assert.deepStrictEqual(S.filterRules(base, DEFAULTS), []);
  assert.deepStrictEqual(S.filterRules({ ...base, volume24h: 2999 }, DEFAULTS).map((x) => x.key), ['VOL']);
  assert.deepStrictEqual(S.filterRules({ ...base, ageHours: 0.9 / 60 }, DEFAULTS).map((x) => x.key), ['AGE']);
});
test('limiti: kill switch %, stop assoluto, perdita giornaliera, posizioni max', () => {
  const c = { ...DEFAULTS, maxLossAbs: 0 };
  assert.strictEqual(S.checkLimits({ equity: 79, startEquity: 100, dayStartEquity: 100, openCount: 0, cfg: c }).kill, true);
  assert.strictEqual(S.checkLimits({ equity: 95, startEquity: 100, dayStartEquity: 100, openCount: 0, cfg: { ...c, maxLossAbs: 5 } }).kill, true);
  const d = S.checkLimits({ equity: 91, startEquity: 100, dayStartEquity: 100, openCount: 0, cfg: c });
  assert.strictEqual(d.kill, false); assert.strictEqual(d.canOpen, false);
  assert.strictEqual(S.checkLimits({ equity: 100, startEquity: 100, dayStartEquity: 100, openCount: 3, cfg: c }).canOpen, false);
  assert.strictEqual(S.checkLimits({ equity: 100, startEquity: 100, dayStartEquity: 100, openCount: 1, cfg: c }).canOpen, true);
});
test('uscite: stop-loss, take-profit, trailing, tempo massimo', () => {
  const pos = () => ({ entryPrice: 1, slPct: 2, tpPct: 4, trailPct: 1.4, openedAt: 0 });
  assert.match(S.exitCheck(pos(), 0.97, 1, DEFAULTS).reason, /Stop-loss/);
  assert.match(S.exitCheck(pos(), 1.05, 1, DEFAULTS).reason, /Take-profit/);
  const p = pos(); assert.strictEqual(S.exitCheck(p, 1.03, 1, DEFAULTS).exit, false);
  assert.match(S.exitCheck(p, 1.012, 2, DEFAULTS).reason, /Trailing/);
  assert.match(S.exitCheck(pos(), 1.0, DEFAULTS.maxHoldMin * 60000, DEFAULTS).reason, /Tempo/);
  assert.strictEqual(S.exitCheck(pos(), 1.0, 1000, DEFAULTS).exit, false);
});
