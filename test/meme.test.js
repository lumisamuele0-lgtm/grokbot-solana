const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { DEFAULTS, migrateConfig, sanitize } = require('../src/config');
const { screen, offer, thresholds, fromJup } = require('../src/universe');
const S = require('../src/strategy');
const jup = require('../src/jupiter');
const { SOL, USDC } = require('../src/tokens');

const TK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEME = 'Meme111111111111111111111111111111111111111';
const meme = (o = {}) => ({ mint: MEME, symbol: 'FROG', name: 'Frog', verified: false, tags: ['community'], tokenProgram: TK, mintAuthority: null, freezeAuthority: null, meme: true,
  liquidityUsd: 80000, volume24h: 300000, mcapUsd: 3e6, holders: 4000, topHoldersPct: 45, organic: 40, change1h: 4, change6h: 6, change24h: 10, ageDays: 3, perp: false, ...o });
const LOOSE = { ...DEFAULTS, memeLoose: true }; const STRICT = { ...DEFAULTS, memeLoose: false };
function candles(n = 200, drift = 0.0005) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 1 * (1 + drift * i) + 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmeme-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 10, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
function readySpot(e, mint, sym, safety = {}) {
  const c = candles(200); e.market.candles[mint] = c; e.market.prices[mint] = { usd: c[199].c, ts: Date.now() };
  e.market.stats[mint] = { symbol: sym, buys1h: 80, sells1h: 30, volume1h: 1e5, volume6h: 6e5, decimals: 6 };
  e.market.safety[mint] = { ts: Date.now(), rugScore: 5, danger: [], holderRisk: true, holderDanger: false, mintAuthority: null, freezeAuthority: null, token2022Ext: false, decimals: 6, ...safety };
  e.watch.set(mint, { symbol: sym, core: false });
}

test('memecoin: filtri allentati attivi di default (migrazione v10), valori in Impostazioni, mai più severi di prima', () => {
  assert.strictEqual(DEFAULTS.memeLoose, true);
  const r = migrateConfig({ cfgVersion: 9, leverage: 10, maxTradePct: 7, budget: 42, realSpot: false });
  assert.strictEqual(r.cfg.memeLoose, true); assert.strictEqual(r.cfg.memeMinLiqUsd, 50000); assert.strictEqual(r.cfg.memeMinVol24hUsd, 100000); assert.strictEqual(r.cfg.memeMinMcapUsd, 1e6); assert.strictEqual(r.cfg.memeMinAgeHours, 24);
  assert.strictEqual(r.cfg.leverage, 10); assert.strictEqual(r.cfg.realSpot, false, 'lo spot REALE resta spento'); assert.strictEqual(r.cfg.budget, 42); assert.strictEqual(migrateConfig(r.cfg).changed, false);
  const th = thresholds(LOOSE); assert.ok(th.liq <= LOOSE.uniMinLiqUsd && th.vol <= LOOSE.uniMinVol24hUsd && th.mcap <= LOOSE.uniMinMcapUsd && th.ageDays <= LOOSE.uniMinAgeDays);
  assert.ok(th.top <= 80, 'tetto holder alzato solo moderatamente'); assert.strictEqual(sanitize({ memeMaxTopHoldersPct: 99 }).memeMaxTopHoldersPct, 80);
  assert.deepStrictEqual(thresholds(STRICT).liq, STRICT.uniMinLiqUsd);
});

test('memecoin: entrano community/strict, Token-2022 e soglie più basse; anti-truffa sempre attivi', () => {
  assert.deepStrictEqual(screen(meme(), LOOSE), []);
  assert.ok(screen(meme(), STRICT).length > 0, 'con i filtri severi la stessa memecoin è scartata');
  assert.deepStrictEqual(screen(meme({ tags: ['strict'] }), LOOSE), []);
  assert.match(screen(meme({ tags: [] }), LOOSE).join(), /lista Jupiter/, 'mai token fuori dalle liste di Jupiter');
  assert.deepStrictEqual(screen(meme({ tokenProgram: T22 }), LOOSE), [], 'Token-2022 ammesso (poi controllo on-chain)');
  assert.match(screen(meme({ tokenProgram: T22 }), STRICT).join(), /Token-2022/);
  assert.match(screen(meme({ tokenProgram: 'Other111111111111111111111111111111111111' }), LOOSE).join(), /Token-2022/);
  assert.match(screen(meme({ freezeAuthority: 'X' }), LOOSE).join(), /autorità/); assert.match(screen(meme({ mintAuthority: 'X' }), LOOSE).join(), /autorità/);
  assert.match(screen(meme({ liquidityUsd: 40000 }), LOOSE).join(), /liquidità < 50k/);
  assert.match(screen(meme({ volume24h: 90000 }), LOOSE).join(), /volume 24h/);
  assert.match(screen(meme({ mcapUsd: 9e5 }), LOOSE).join(), /capitalizzazione/);
  assert.deepStrictEqual(screen(meme({ ageDays: 30 / 24 }), LOOSE), []); assert.match(screen(meme({ ageDays: 10 / 24 }), LOOSE).join(), /età < 24 ore/);
  assert.deepStrictEqual(screen(meme({ topHoldersPct: 58 }), LOOSE), []); assert.match(screen(meme({ topHoldersPct: 70 }), LOOSE).join(), /holder/);
  assert.match(screen(meme({ change1h: 80 }), LOOSE).join(), /pump/); assert.match(screen(meme({ change24h: -60 }), LOOSE).join(), /crollo/);
  assert.match(screen(meme({ symbol: 'USDX' }), LOOSE).join(), /stablecoin/);
  assert.match(screen(meme({ organic: 5 }), LOOSE).join(), /organico/);
  // controllo on-chain + RugCheck all'acquisto
  const sf = { mintAuthority: null, freezeAuthority: null, rugScore: 5, danger: [], holderRisk: true, holderDanger: false, token2022Ext: false };
  assert.deepStrictEqual(S.safetyRules(sf, LOOSE, false), [], 'avvisi holder tollerati (c\'è il tetto top holder)');
  assert.ok(S.safetyRules(sf, STRICT, false).length, 'con i filtri severi no');
  assert.ok(S.safetyRules({ ...sf, holderDanger: true }, LOOSE, false).length);
  assert.ok(S.safetyRules({ ...sf, danger: ['Freeze Authority still enabled'] }, LOOSE, false).length, 'RugCheck danger sempre scartato');
  assert.ok(S.safetyRules({ ...sf, rugScore: 80 }, LOOSE, false).length);
  assert.ok(S.safetyRules({ ...sf, token2022Ext: true }, LOOSE, false).length, 'Token-2022 con commissioni/hook scartato');
  assert.ok(S.safetyRules({ ...sf, freezeAuthority: 'X' }, LOOSE, false).length);
  assert.ok(S.safetyRules(null, LOOSE, false).length, 'senza dati di sicurezza niente acquisto');
  // VERIFICA della scansione: soglie memecoin, mai più severe
  const e = mkEngine(); const v = e.verifyCfg();
  assert.ok(v.minLiquidityUsd <= 50000 && v.minMcapUsd <= 1e6 && v.minPairAgeMin <= 24 * 60 && v.minVolume24hUsd <= 100000);
  assert.deepStrictEqual(S.filterRules({ liquidityUsd: 60000, volume24h: 2e5, mcapUsd: 2e6, ageHours: 30, change1h: 3, change24h: 5, buys1h: 50, sells1h: 40, core: false }, v), []);
  e.cfg.memeLoose = false; assert.strictEqual(e.verifyCfg(), e.cfg);
});

test('memecoin: etichetta 🐸, solo spot 1x long al 7%, honeypot e Token-2022 rischioso scartati', async () => {
  assert.strictEqual(offer({ perp: false, meme: true }, 5).label, '🐸 Meme · Spot · Long'); assert.deepStrictEqual(offer({ perp: false, meme: true }, 10).sides, ['LONG']); assert.strictEqual(offer({ perp: false, meme: true }, 10).lev, 1);
  assert.strictEqual(fromJup({ id: MEME, symbol: 'FROG', tokenProgram: TK }).meme, true); assert.strictEqual(fromJup({ id: SOL, symbol: 'SOL' }).meme, false); assert.strictEqual(fromJup({ id: 'x', symbol: 'JUP' }).meme, false);
  const e = mkEngine(); e.universe.setCoins([meme()]); readySpot(e, MEME, 'FROG');
  const real = jup.quote;
  jup.quote = async (i, o, amt) => (i === USDC ? { outAmount: String(Math.floor((Number(amt) / 1e6 / e.market.prices[MEME].usd) * 1e6)), priceImpactPct: '0.001' } : { outAmount: '1000', priceImpactPct: '0' });
  try {
    const m = e.match.start(); const c = m.teams.A.coins.find((x) => x.mint === MEME); assert.ok(c && c.meme && /🐸/.test(c.label));
    assert.ok(Object.values(m.teams.A.lineup).filter((L) => L.mint === MEME).every((L) => L.side === 'LONG'));
    const pos = await e.match.teamTurn('A');
    assert.ok(pos && pos.mint === MEME); assert.strictEqual(pos.lev, 1); assert.strictEqual(pos.side, 'LONG'); assert.ok(!pos.perp); assert.ok(Math.abs(pos.costBase - 35) < 0.01, `7% di 500 (${pos.costBase})`); assert.strictEqual(pos.core, false, 'uscite furbe per meme');
    const sh = await e.enterTrade({ m: MEME, s: { symbol: 'FROG' }, a: { atrPct: 1, last: 1 }, side: 'SHORT', rs: { score: 0 } }, { conf: 1, capital: 500, cash: 500, team: 'B', player: 'B1', perp: false });
    assert.ok(!sh); assert.ok(!e.book.positions.some((p) => p.team === 'B'));
    // Token-2022 con commissione di trasferimento: scartato al controllo on-chain
    const BAD = 'Bad2222222222222222222222222222222222222222'; readySpot(e, BAD, 'FEE', { token2022Ext: true });
    assert.ok(!(await e.enterTrade({ m: BAD, s: { symbol: 'FEE' }, a: { atrPct: 1, last: 1 }, side: 'LONG', rs: { score: 0 } }, { conf: 1, capital: 500, cash: 500, team: 'B', player: 'B1', perp: false })));
    // honeypot: nessuna via di vendita su Jupiter
    const H = 'Hny3333333333333333333333333333333333333333'; readySpot(e, H, 'HONEY');
    jup.quote = async (i) => { if (i === H) throw new Error('No routes found'); return { outAmount: '1000000', priceImpactPct: '0' }; };
    assert.ok(!(await e.enterTrade({ m: H, s: { symbol: 'HONEY' }, a: { atrPct: 1, last: 1 }, side: 'LONG', rs: { score: 0 } }, { conf: 1, capital: 500, cash: 500, team: 'B', player: 'B1', perp: false })));
    assert.ok(!e.book.positions.some((p) => p.mint === H || p.mint === BAD));
  } finally { jup.quote = real; }
});

test('memecoin in REALE: niente acquisti finché «Spot REALE» è spento', async () => {
  const e = mkEngine(); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.ks.kp = {}; e.bal = { sol: 1, tokens: {} };
  e.universe.setCoins([meme()]); readySpot(e, MEME, 'FROG');
  let swaps = 0; e.realSwap = async () => { swaps++; return { ok: false, err: 'test' }; };
  const real = jup.quote; jup.quote = async (i, o, amt) => ({ outAmount: String(Number(amt)), priceImpactPct: '0' });
  try {
    assert.strictEqual(e.cfg.realSpot, false); e.setTrading(true); await e.cycle(); await e.match.turn();
    assert.strictEqual(swaps, 0); assert.strictEqual(e.book.positions.length, 0);
    const r = await e.enterTrade({ m: MEME, s: { symbol: 'FROG' }, a: { atrPct: 1, last: 1 }, side: 'LONG', rs: { score: 0 } }, { conf: 1, capital: 50, cash: 50, team: 'A', player: 'A1', perp: false });
    assert.ok(!r); assert.strictEqual(swaps, 0);
  } finally { jup.quote = real; }
});

test('memecoin scartata dal controllo on-chain (es. Token-2022 con commissioni): l\'allenatore la toglie dal campo', async () => {
  const e = mkEngine(); const M2 = 'Good444444444444444444444444444444444444444';
  e.universe.setCoins([meme(), meme({ mint: M2, symbol: 'DOGE2', tokenProgram: T22 })]);
  const m = e.match.start(); assert.ok(m.teams.A.coins.some((c) => c.mint === M2) || m.teams.B.coins.some((c) => c.mint === M2));
  e.market.safety[M2] = { ts: Date.now(), rugScore: 5, danger: [], holderRisk: false, holderDanger: false, mintAuthority: null, freezeAuthority: null, token2022Ext: true };
  assert.ok(!e.match.candidates().some((c) => c.mint === M2));
  e.match.coachTick(Date.now() + 11e3);
  assert.ok(!m.teams.A.coins.some((c) => c.mint === M2) && !m.teams.B.coins.some((c) => c.mint === M2));
});
