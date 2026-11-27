const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { DEFAULTS, migrateConfig } = require('../src/config');
const { screen, offer, fromJup } = require('../src/universe');
const { MAX_COINS } = require('../src/desk');
const P = require('../src/perps');
const jup = require('../src/jupiter');
const { SOL, USDC } = require('../src/tokens');

const TK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const good = (o = {}) => ({ mint: 'Good1111111111111111111111111111111111111111', symbol: 'GOOD', name: 'Good', verified: true, tags: ['verified'], tokenProgram: TK, mintAuthority: null, freezeAuthority: null,
  liquidityUsd: 2e6, volume24h: 5e6, mcapUsd: 2e8, holders: 50000, topHoldersPct: 20, organic: 90, change1h: 1, change6h: 2, change24h: 3, ageDays: 400, perp: false, ...o });
const mkMint = (i) => `Coin${String(i).padStart(2, '0')}`.padEnd(43, '1');
function candles(n = 200, drift = 0.0005) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 1 * (1 + drift * i) + 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
const yes = (e, n = 6, dir = 1) => { e.desk.analyze = () => ['trend', 'momentum', 'flow', 'meme', 'whale', 'mtf', 'breakout', 'reversion'].slice(0, n).map((id) => ({ id, dir, conf: 0.8, why: 'test' })); }; // analisti d'accordo (test)
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbuni-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 8, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  // test della logica a consenso 1 minuto (ancora disponibile con edgeOn=false): TREND 4H spento salvo richiesta
  e.cfg.edgeOn = cfg.edgeOn ?? false; e.cfg.spotLongs = cfg.spotLongs ?? true;
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
// prepara una cripto spot pronta a essere scambiata (dati, candele, controlli di VERIFICA superati)
function readySpot(e, mint, sym, drift = 0.0005) {
  const c = candles(200, drift); e.market.candles[mint] = c; e.market.prices[mint] = { usd: c[199].c, ts: Date.now() };
  e.market.stats[mint] = { symbol: sym, buys1h: 80, sells1h: 30, volume1h: 1e6, volume6h: 6e6, decimals: 6 };
  e.market.safety[mint] = { ts: Date.now(), rugScore: 1, danger: [], holderRisk: false, mintAuthority: null, freezeAuthority: null, token2022Ext: false, decimals: 6 };
  e.watch.set(mint, { symbol: sym, core: false });
}

test('filtri universo: verificati, niente autorità, niente Token-2022/stablecoin/azioni, liquidità, volume, età, holder', () => {
  const cfg = { ...DEFAULTS, memeLoose: false }; // filtri severi (i filtri memecoin sono in meme.test.js)
  assert.deepStrictEqual(screen(good(), cfg), []);
  assert.match(screen(good({ verified: false }), cfg).join(), /non verificato/);
  assert.match(screen(good({ freezeAuthority: 'X' }), cfg).join(), /autorità/);
  assert.match(screen(good({ tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }), cfg).join(), /Token-2022/);
  assert.match(screen(good({ symbol: 'USDT' }), cfg).join(), /stablecoin/);
  assert.match(screen(good({ tags: ['verified', 'xstocks'] }), cfg).join(), /azione/);
  assert.match(screen(good({ liquidityUsd: 1000 }), cfg).join(), /liquidità/);
  assert.match(screen(good({ volume24h: 1000 }), cfg).join(), /volume 24h/);
  assert.match(screen(good({ ageDays: 1 }), cfg).join(), /età/);
  assert.match(screen(good({ topHoldersPct: 90 }), cfg).join(), /holder/);
  assert.match(screen(good({ change1h: 80 }), cfg).join(), /pump/);
  // SOL/BTC/ETH (mercati con leva) sempre ammessi, anche cbBTC con le autorità di Coinbase
  const btc = fromJup({ id: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', symbol: 'cbBTC', isVerified: true, mintAuthority: 'x', freezeAuthority: 'y', tokenProgram: TK, liquidity: 1e7 });
  assert.strictEqual(btc.symbol, 'BTC'); assert.strictEqual(btc.perp, true); assert.deepStrictEqual(screen(btc, cfg), []);
});

test('leva e long/short solo dove ci sono i perps: SOL/BTC/ETH 5x L/S, il resto spot 1x solo long', () => {
  assert.deepStrictEqual(offer({ perp: true }, 5), { lev: 5, sides: ['LONG', 'SHORT'], label: '5x · L/S' });
  assert.deepStrictEqual(offer({ perp: false }, 5), { lev: 1, sides: ['LONG'], label: 'Spot · Long' });
});

test('radar: SOL/BTC/ETH con leva + fino a 12 cripto spot; nessuno short sulle cripto spot', () => {
  const e = mkEngine(); e.cfg.pace = 'prudente'; // Ritmo prudente: 12 cripto spot (aggressivo: 24, vedi pace.test.js)
  const coins = Array.from({ length: 20 }, (_, i) => good({ mint: mkMint(i), symbol: 'C' + i, change1h: i % 3 ? 2 + i : -4 - i, volume24h: 1e6 * (i + 1) }));
  e.universe.setCoins([...coins, fromJup({ id: SOL, symbol: 'SOL', isVerified: true, tokenProgram: TK, liquidity: 1e9, stats24h: { buyVolume: 1e9, sellVolume: 1e9 } })]);
  const f = e.desk.pickCoins();
  assert.strictEqual(MAX_COINS, 12);
  assert.strictEqual(f.filter((c) => !c.perp).length, 12, 'fino a 12 cripto spot sul radar'); assert.ok(f.some((c) => c.perp && c.symbol === 'SOL'));
  for (const c of f) if (!c.perp) assert.strictEqual(c.label, 'Spot · Long');
  e.desk.pickCoins(Date.now() + 6 * 60e3); assert.ok(e.desk.coinMints().length <= MAX_COINS + 3);
  const v = e.desk.view(); assert.strictEqual(v.maxCoins, 12); assert.strictEqual(v.execs.length, 2); assert.strictEqual(v.analysts.length, 12);
});

test('spot: Omega compra long 1x via Jupiter (fino al 20%); short spot rifiutato; honeypot scartato', async () => {
  const e = mkEngine(); const M = mkMint(1);
  e.universe.setCoins([good({ mint: M, symbol: 'GOOD', change1h: 3, change6h: 4 })]);
  readySpot(e, M, 'GOOD');
  const real = jup.quote; let calls = 0;
  jup.quote = async (i, o, amt) => { calls++; return i === USDC ? { outAmount: String(Math.floor((Number(amt) / 1e6 / e.market.prices[M].usd) * 1e6)), priceImpactPct: '0.001' } : { outAmount: '1000', priceImpactPct: '0' }; };
  try {
    e.desk.pickCoins(); yes(e);
    const [pos] = await e.desk.turn();
    assert.ok(pos, 'acquisto spot'); assert.ok(!pos.perp); assert.strictEqual(pos.lev, 1); assert.strictEqual(pos.side, 'LONG'); assert.strictEqual(pos.bot, 'omega');
    assert.ok(Math.abs(pos.costBase - 200) < 0.01, `20% di 1000 (${pos.costBase})`); assert.ok(!pos.liqPrice, 'spot: niente liquidazione');
    const r = await e.enterTrade({ m: M, s: { symbol: 'GOOD' }, a: { atrPct: 1, last: 1 }, side: 'SHORT', rs: { score: 0 } }, { conf: 1, capital: 500, cash: 500, bot: 'omega', perp: false });
    assert.ok(!r); assert.ok(!e.book.positions.some((p) => p.side === 'SHORT'));
    // chiusura: entra nel PnL del trader e aggiorna i pesi degli analisti che avevano ragione
    e.market.prices[M] = { usd: pos.entryPrice * 1.02, ts: Date.now() };
    jup.quote = async (i, o, amt) => ({ outAmount: String(Math.floor(Number(amt) * pos.entryPrice * 1.02)), priceImpactPct: '0' });
    await e.closePosition(pos, 'Take-profit');
    const tr = e.book.trades[0]; assert.strictEqual(tr.bot, 'omega'); assert.strictEqual(tr.lev, 1);
    const v = e.desk.view(); assert.ok(v.execs.find((b) => b.id === 'omega').pnl > 0); assert.ok(v.analysts.find((a) => a.id === 'flow').weight > 1, 'chi aveva ragione pesa di più');
    const H = mkMint(7); readySpot(e, H, 'HONEY');
    jup.quote = async (i) => { if (i === H) throw new Error('No routes found'); return { outAmount: '1000000', priceImpactPct: '0' }; };
    const h = await e.enterTrade({ m: H, s: { symbol: 'HONEY' }, a: { atrPct: 1, last: 1 }, side: 'LONG', rs: { score: 0 } }, { conf: 1, capital: 500, cash: 500, bot: 'omega', perp: false });
    assert.ok(!h); assert.ok(!e.book.positions.some((p) => p.mint === H));
  } finally { jup.quote = real; }
  assert.ok(calls > 0);
});

test('REALE: perps sempre bloccati; spot reale solo se lo attivi (e allora usa lo swap reale esistente)', async () => {
  const M = mkMint(2);
  const e = mkEngine(); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.ks.kp = {};
  e.bal = { sol: 1, tokens: {} };
  e.universe.setCoins([good({ mint: M, symbol: 'GOOD' }), fromJup({ id: SOL, symbol: 'SOL', isVerified: true, tokenProgram: TK, liquidity: 1e9 })]);
  readySpot(e, M, 'GOOD'); e.market.candles[SOL] = candles(200).map((k) => ({ ...k, o: k.o * 100, h: k.h * 100, l: k.l * 100, c: k.c * 100 }));
  const real = jup.quote; jup.quote = async (i, o, amt) => ({ outAmount: String(Number(amt)), priceImpactPct: '0' });
  let swaps = 0; e.realSwap = async () => { swaps++; return { ok: false, err: 'test: niente invio' }; };
  try {
    e.setTrading(true); yes(e); assert.ok(e.desk.view().realWaiting, 'spot reale spento: REALE in attesa');
    await e.cycle(); assert.strictEqual(swaps, 0); assert.strictEqual(e.book.positions.length, 0);
    e.cfg.realSpot = true;
    assert.ok(!e.desk.view().realWaiting); assert.match(e.desk.view().realNote, /solo Omega/);
    e.desk.pickCoins(); await e.desk.turn();
    assert.ok(swaps >= 1, 'lo spot reale passa dallo swap Jupiter reale esistente');
    assert.ok(!e.book.positions.some((p) => p.perp), 'nessun perps reale'); assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  } finally { jup.quote = real; }
});

test('migrazione v8: spot solo long attivo, spot reale spento, filtri più severi, leva invariata', () => {
  const r = migrateConfig({ cfgVersion: 7, leverage: 10, minVolume24hUsd: 3000, minLiquidityUsd: 40000, minPairAgeMin: 1, budget: 77 });
  assert.strictEqual(r.cfg.spotLongs, false, 'v15: Omega spot in pausa'); assert.strictEqual(r.cfg.realSpot, false);
  assert.strictEqual(r.cfg.minVolume24hUsd, 100000); assert.strictEqual(r.cfg.minLiquidityUsd, 100000); assert.strictEqual(r.cfg.minPairAgeMin, 1440);
  assert.strictEqual(r.cfg.leverage, 10); assert.strictEqual(r.cfg.budget, 77); assert.strictEqual(migrateConfig(r.cfg).changed, false);
});
