'use strict';
// RAZZO · Cacciatore di Razzi: punteggio, cancelli anti-rug, andata e ritorno, scaglioni, stop rigido, emergenze, secchiello
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('../src/rocket'); const C = require('../src/config');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore'); const jup = require('../src/jupiter');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL = 'So11111111111111111111111111111111111111112';
const cfg = { ...C.DEFAULTS };
const MINT = 'Rkt1111111111111111111111111111111111111pump';
// token Jupiter v2 di esempio (forma reale dell'API)
const tok = (o = {}) => ({ id: MINT, symbol: 'ROCK', name: 'Rock', decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', launchpad: 'pump.fun', graduatedPool: 'Pool1', usdPrice: 0.001, mcap: 400000, liquidity: 60000, holderCount: 2500, organicScore: 70, isVerified: false, tags: ['unknown'],
  firstPool: { createdAt: new Date(Date.now() - 6 * 3.6e6).toISOString() }, twitter: 'https://x.com/r', website: 'https://r.fun',
  stats5m: { priceChange: 4, holderChange: 2.5, buyVolume: 9000, sellVolume: 4000, numTraders: 300, numNetBuyers: 80, numOrganicBuyers: 10 },
  stats1h: { priceChange: 40, holderChange: 14, buyVolume: 60000, sellVolume: 35000, numTraders: 1200, numNetBuyers: 360, numOrganicBuyers: 30 },
  stats6h: { priceChange: 120, buyVolume: 150000, sellVolume: 120000 }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18, devBalancePercentage: 0.5, devMints: 3, devMigrations: 1 }, ...o });
const good = () => { const c = R.normJup(tok()); c.rank = { 'jup:toptrending/5m': 4 }; c.boost = 1; c.src.add('gecko'); return c; };
const okSafety = { ts: Date.now(), mintAuthority: null, freezeAuthority: null, token2022Ext: false, danger: [], rugScore: 1, lpLockedPct: 100 };

test('punteggio 0–100: una memecoin sana in accelerazione supera 70, una già salita in verticale no', () => {
  const s = R.scoreCand(good(), cfg); assert.ok(s.score >= 70 && s.score <= 100, `punteggio ${s.score}`); assert.ok(s.badges.includes('holder') && s.badges.includes('social'));
  const sum = s.parts.reduce((a, p) => a + p.max, 0); assert.strictEqual(sum, 100, 'pesi che sommano a 100');
  const hot = R.normJup(tok({ stats1h: { ...tok().stats1h, priceChange: 450 }, stats6h: { priceChange: 1500, buyVolume: 1, sellVolume: 1 } }));
  assert.ok(R.scoreCand(hot, cfg).score < s.score, 'già tirata → meno punti'); assert.ok(R.quickGates(hot, cfg).some((f) => f.code === 'verticale'));
  const dead = R.normJup(tok({ stats5m: { buyVolume: 10, sellVolume: 300 }, stats1h: { buyVolume: 2000, sellVolume: 8000, holderChange: -3 }, organicScore: 2, twitter: null, website: null }));
  assert.ok(R.scoreCand(dead, cfg).score < 40); assert.strictEqual(R.features(good()).length, 18);
});

test('cancelli anti-rug: mint/freeze, holder concentrati, dev che vende, liquidità, età, non-meme, LP, RugCheck, Token-2022', () => {
  assert.deepStrictEqual(R.quickGates(good(), cfg), []); assert.deepStrictEqual(R.safetyGates(good(), okSafety), []);
  const codes = (o, prev) => R.quickGates(R.normJup(tok(o)), cfg, prev).map((f) => f.code);
  assert.ok(codes({ audit: { ...tok().audit, mintAuthorityDisabled: false } }).includes('mint'));
  assert.ok(codes({ audit: { ...tok().audit, freezeAuthorityDisabled: false } }).includes('freeze'));
  assert.ok(codes({ audit: { ...tok().audit, topHoldersPercentage: 45 } }).includes('holder'));
  assert.ok(codes({ audit: { ...tok().audit, isSus: true } }).includes('sospetto'));
  assert.ok(codes({ audit: { ...tok().audit, devBalancePercentage: 1 } }, { devPct: 6 }).includes('dev-vende'), 'il dev è passato dal 6% all\'1%');
  assert.ok(codes({ liquidity: 12000 }).includes('liquidità'));
  assert.ok(codes({ firstPool: { createdAt: new Date().toISOString() } }).includes('troppo-giovane'));
  assert.ok(codes({ firstPool: { createdAt: new Date(Date.now() - 200 * 3.6e6).toISOString() } }).includes('vecchia'));
  assert.ok(codes({ tags: ['stable'] }).includes('non-meme'));
  const notGrad = R.normJup(tok({ graduatedPool: null, launchpad: null }));
  assert.ok(R.safetyGates(notGrad, { ...okSafety, lpLockedPct: 40 }).some((f) => f.code === 'lp'), 'LP non bloccata');
  assert.deepStrictEqual(R.safetyGates(notGrad, { ...okSafety, lpLockedPct: 95 }), []);
  assert.ok(R.safetyGates(good(), { ...okSafety, danger: ['Single holder ownership'] }).some((f) => f.code === 'rugcheck'));
  assert.ok(R.safetyGates(good(), { ...okSafety, token2022Ext: true }).some((f) => f.code === 'token2022'));
  assert.ok(R.safetyGates(good(), { ...okSafety, freezeAuthority: 'X' }).some((f) => f.code === 'freeze'));
  assert.ok(R.safetyGates(good(), null).length, 'senza verifica non si compra');
});

test('andata e ritorno su Jupiter: perdita %, oltre la soglia non compra', () => {
  assert.strictEqual(R.roundTripLoss(1000000n, 970000n), 3); assert.strictEqual(R.roundTripLoss(1000000n, 800000n), 20); assert.strictEqual(R.roundTripLoss(1000000n, 1010000n), 0);
});

test('secchiello e dimensione: puntata 10% (60–100% col punteggio), mai oltre 20%, secchiello 30%, cassa', () => {
  assert.deepStrictEqual([cfg.rocketTradePct, cfg.rocketBucketPct, cfg.rocketMaxOpen, cfg.rocketSlPct], [10, 30, 4, 15]);
  assert.strictEqual(R.sizeFor(100, 1000, cfg, 1e9, 1e9), 100); assert.strictEqual(R.sizeFor(70, 1000, cfg, 1e9, 1e9), 60);
  assert.strictEqual(R.sizeFor(100, 1000, { ...cfg, rocketTradePct: 50 }, 1e9, 1e9), 200, 'tetto rigido 20%');
  assert.strictEqual(R.sizeFor(100, 1000, cfg, 25, 1e9), 25, 'spazio del secchiello'); assert.strictEqual(R.sizeFor(100, 1000, cfg, 1e9, 10), 10, 'cassa');
  const book = { positions: [{ bot: 'razzo', costBase: 120 }, { bot: 'razzo', costBase: 100 }, { bot: 'omega', costBase: 500 }] };
  assert.deepStrictEqual(R.bucketRoom(book, 1000, cfg), { cap: 300, used: 220, room: 80, open: 2 });
  const sz = C.sanitize({ rocketTradePct: 35, rocketBucketPct: 80, rocketSlPct: 2, rocketMaxOpen: 50 }, C.DEFAULTS);
  assert.deepStrictEqual([sz.rocketTradePct, sz.rocketBucketPct, sz.rocketSlPct, sz.rocketMaxOpen], [20, 50, 5, 10], 'limiti di configurazione');
});

test('uscite: stop rigido −15%, scaglione 40% a +100%, 30% a +300%, trailing 35% dal massimo mai sotto pareggio, stop a tempo', () => {
  const now = Date.now(); const mk = () => ({ entryPrice: 1, openedAt: now, rocket: { sl: 15, tp1: 100, s1: 40, tp2: 300, s2: 30, trail: 35, timeH: 6 } });
  let p = mk(); assert.strictEqual(R.ladderExit(p, 0.9, now, cfg).action, 'hold');
  let r = R.ladderExit(p, 0.84, now, cfg); assert.strictEqual(r.action, 'close'); assert.ok(r.hard && /Stop rigido −15%/.test(r.reason));
  p = mk(); r = R.ladderExit(p, 2.05, now, cfg); assert.deepStrictEqual([r.action, r.frac, r.stage], ['partial', 0.4, 'R1']); p.r1Done = true;
  r = R.ladderExit(p, 3, now, cfg); assert.strictEqual(r.action, 'hold'); assert.ok(Math.abs(p.trailStop - 3 * 0.65) < 1e-9);
  r = R.ladderExit(p, 4.1, now, cfg); assert.deepStrictEqual([r.action, r.stage], ['partial', 'R2']); assert.ok(Math.abs(r.frac - 0.5) < 1e-9, '30% dell\'iniziale = 50% del rimasto'); p.r2Done = true;
  r = R.ladderExit(p, 8, now, cfg); assert.strictEqual(r.action, 'hold'); r = R.ladderExit(p, 5, now, cfg); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /Trailing/);
  const q = mk(); q.r1Done = true; q.highest = 2.1; r = R.ladderExit(q, 1.01, now, cfg); assert.strictEqual(r.action, 'close', 'mai sotto pareggio dopo lo scaglione 1');
  const t = mk(); t.openedAt = now - 7 * 3.6e6; r = R.ladderExit(t, 1.05, now, cfg); assert.strictEqual(r.action, 'close'); assert.match(r.reason, /Nessuno slancio/);
});

test('emergenze: liquidità ritirata, dev che vende, via di vendita assente, RugCheck', () => {
  const p = { rocket: { liq0: 60000, dev0: 5 } };
  assert.strictEqual(R.emergency(p, { liq: 50000, devPct: 5 }), null);
  assert.match(R.emergency(p, { liq: 20000 }), /liquidità crollata/); assert.match(R.emergency(p, { devPct: 1 }), /dev sta vendendo/);
  // fonti diverse non si confrontano tra loro: Jupiter 111k vs DexScreener 53k (solo pool principale) non è un crollo
  const q = { rocket: { liq0: 111000, liqDex0: 53000 } };
  assert.strictEqual(R.emergency(q, { liq: 108000, liqDex: 52000 }), null);
  assert.match(R.emergency(q, { liqDex: 20000 }), /53k → 20k/);
  assert.strictEqual(R.isRouteFail(new Error('HTTP 429 Too many requests')), false); assert.strictEqual(R.isRouteFail(new Error('The operation was aborted')), false);
  assert.strictEqual(R.isRouteFail(new Error('Nessuna rotta Jupiter')), true); assert.strictEqual(R.isRouteFail(new Error('HTTP 400 COULD_NOT_FIND_ANY_ROUTE')), true);
  assert.match(R.emergency({ rocket: { routeFails: 2 } }, {}), /via di vendita/); assert.match(R.emergency({ rocket: {} }, { danger: ['LP unlocked'] }), /RugCheck/);
});

test('statistiche per fascia di punteggio (hit rate)', () => {
  const done = [{ score: 85, max: 150, min: -10, ok: true }, { score: 82, max: 20, min: -60, ok: true }, { score: 30, max: 5, min: -80, ok: false }];
  const b = R.bucketStats(done); const top = b.find((x) => x.lo === 80); assert.deepStrictEqual([top.n, top.x2, top.dump, top.avgMax], [2, 50, 50, 85]); assert.strictEqual(b.find((x) => x.lo === 0).dump, 100);
});

function mkEngine(over = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrk-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 14, ...over }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.market.prices[MINT] = { usd: 0.001, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
const ready = (e) => { const c = good(); const sc = R.scoreCand(c, e.cfg); Object.assign(c, { score: sc.score, raw: sc.score, parts: sc.parts, badges: sc.badges, x: R.features(c), fails: [], status: 'pronto' }); e.rocket.radar = [c]; return c; };
const stub = (rtBack = 0.97) => { const real = jup.quote; jup.quote = async (i, o, amt) => (i === USDC ? { outAmount: String(BigInt(amt) * 1000n), priceImpactPct: '0.002' } : { outAmount: String(BigInt(Math.floor(Number(amt) / 1000 * rtBack))), priceImpactPct: '0.002' }); return () => { jup.quote = real; }; };

test('Razzo compra con il secchiello separato, stop rigido e scaglioni; la sala non conta le sue posizioni', async () => {
  const e = mkEngine(); e.cfg.trading = true; ready(e); const undo = stub();
  try {
    const [p] = await e.rocket.turn(); assert.ok(p, 'comprato'); assert.strictEqual(p.bot, 'razzo'); assert.ok(p.rocket && p.rocket.sl === 15);
    assert.ok(p.costBase <= 100.01 && p.costBase >= 60, `puntata ${p.costBase}`); assert.strictEqual(e.deskPositions().length, 0);
    assert.strictEqual((await e.rocket.turn()).length, 0, 'mai due volte la stessa memecoin');
    // stop rigido: prezzo −20% → vendita immediata
    e.market.prices[MINT] = { usd: 0.0008, ts: Date.now() }; await e.rocket.check(p, e.priceBase(MINT));
    assert.strictEqual(e.book.positions.length, 0); const tr = e.book.trades[0]; assert.strictEqual(tr.bot, 'razzo'); assert.match(tr.reason, /Stop rigido/);
    assert.ok(e.rocket.view().stats.trades === 1);
  } finally { undo(); }
});

test('Razzo: andata e ritorno oltre l\'8% = niente acquisto (anti-honeypot); in REALE con Spot REALE spento non compra; kill switch', async () => {
  const e = mkEngine(); e.cfg.trading = true; ready(e); let undo = stub(0.85);
  try { assert.strictEqual((await e.rocket.turn()).length, 0); assert.strictEqual(e.rocket.radar[0].status, 'scartato'); assert.match(e.rocket.radar[0].fails.at(-1).label, /andata e ritorno/); } finally { undo(); }
  const r2 = mkEngine(); r2.cfg.trading = true; r2.cfg.mode = 'REAL'; r2.cfg.realSpot = false; ready(r2); undo = stub();
  try { assert.strictEqual((await r2.rocket.turn()).length, 0); assert.match(r2.rocket.blocked(), /Spot REALE spento/); } finally { undo(); }
  const k = mkEngine(); k.cfg.trading = true; k.book.killed = true; ready(k); undo = stub();
  try { assert.strictEqual((await k.rocket.turn()).length, 0); } finally { undo(); }
});

test('Razzo: limite di memecoin aperte e secchiello pieno', async () => {
  const e = mkEngine({ rocketMaxOpen: 1 }); e.cfg.trading = true; const undo = stub();
  try {
    ready(e); assert.strictEqual((await e.rocket.turn()).length, 1);
    const c2 = ready(e); c2.mint = 'Rkt2222222222222222222222222222222222222pump'; e.market.prices[c2.mint] = { usd: 0.001, ts: Date.now() };
    assert.strictEqual((await e.rocket.turn()).length, 0); assert.match(e.rocket.lastBlock, /max 1/);
    e.cfg.rocketMaxOpen = 4; e.cfg.rocketBucketPct = 5; assert.strictEqual((await e.rocket.turn()).length, 0); assert.match(e.rocket.lastBlock, /secchiello/);
  } finally { undo(); }
});

test('apprendimento: ogni candidato è seguito 24 h; esito razzo/dump; la riserva di cassa per Razzo', () => {
  const e = mkEngine(); const c = ready(e); const now = Date.now();
  e.rocket.trackAdd(c, now, false); assert.strictEqual(e.rocket.st.track.length, 1);
  const x = e.rocket.st.track[0]; x.max = 140; x.hitAt = now; e.rocket.finish(x, now);
  assert.strictEqual(e.rocket.st.done[0].y, 1); assert.strictEqual(e.rocket.brain.bot('razzo').buf.length, 1); assert.strictEqual(e.rocket.st.best.max, 140);
  assert.ok(Math.abs(e.rocketReserve() - 100) < 1e-6, 'tiene da parte una puntata per la prossima memecoin'); assert.ok(e.deskCash() <= e.cash() - 99);
  const v = e.rocket.view(); assert.ok(v.radar[0].links.phantom.startsWith('https://phantom.com/tokens/solana/')); assert.strictEqual(v.radar[0].checks.length, 8);
});

test('scaglioni in motore: vende il 40% a +100%, poi trailing; vista senza dati sensibili', async () => {
  const e = mkEngine(); e.cfg.trading = true; ready(e); const undo = stub(0.97);
  try {
    const [p] = await e.rocket.turn(); const q0 = p.qty;
    jup.quote = async (i, o, amt) => (i === USDC ? { outAmount: String(BigInt(amt) * 1000n), priceImpactPct: '0' } : { outAmount: String(BigInt(Math.floor((Number(amt) / 1000) * 2.1))), priceImpactPct: '0' });
    e.market.prices[MINT] = { usd: 0.0021, ts: Date.now() }; await e.rocket.check(p, e.priceBase(MINT));
    assert.ok(p.r1Done, 'scaglione 1 fatto'); assert.ok(Math.abs(p.qty / q0 - 0.6) < 0.01, `rimasto ${p.qty / q0}`);
    e.market.prices[MINT] = { usd: 0.004, ts: Date.now() }; await e.rocket.check(p, e.priceBase(MINT)); assert.ok(!p.r2Done && e.book.positions.length === 1);
    e.market.prices[MINT] = { usd: 0.0025, ts: Date.now() }; await e.rocket.check(p, e.priceBase(MINT));
    assert.strictEqual(e.book.positions.length, 0, 'trailing −35% dal massimo'); assert.ok(e.book.trades[0].pnl > 0);
    const txt = JSON.stringify(e.rocket.view()); assert.ok(!/publicKey|walletEncJson|secret|pinHash/.test(txt));
  } finally { undo(); }
});
