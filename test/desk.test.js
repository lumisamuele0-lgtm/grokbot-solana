'use strict';
// SALA OPERATIVA: 12 analisti → consenso pesato → 2 trader (Alpha, Omega). Rischio: 20% max per operazione, posizioni max,
// esposizione totale, limite di perdita giornaliera; migrazione dallo stato dell'Osservatorio senza perdere storico.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { DEFAULTS } = require('../src/config');
const { fromJup } = require('../src/universe');
const D = require('../src/desk');
const S = require('../src/strategy');
const P = require('../src/perps');
const jup = require('../src/jupiter');
const { SOL, USDC } = require('../src/tokens');

const TK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const mkMint = (i) => `Desk${String(i).padStart(2, '0')}`.padEnd(43, '1');
const good = (o = {}) => ({ mint: mkMint(0), symbol: 'GOOD', name: 'Good', verified: true, tags: ['verified'], tokenProgram: TK, mintAuthority: null, freezeAuthority: null,
  liquidityUsd: 2e6, volume24h: 5e6, mcapUsd: 2e8, holders: 50000, topHoldersPct: 20, organic: 90, change1h: 1, change6h: 2, change24h: 3, ageDays: 400, perp: false, ...o });
function candles(n = 200, drift = 0.0005, base = 1) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = base * (1 + drift * i) + base * 0.003 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function mkEngine(cfg = {}, write = null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdesk-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', ...cfg }));
  if (write) write(d);
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
function readySpot(e, mint, sym) {
  const c = candles(200, 0.0005); e.market.candles[mint] = c; e.market.prices[mint] = { usd: c[199].c, ts: Date.now() };
  e.market.stats[mint] = { symbol: sym, buys1h: 80, sells1h: 30, volume1h: 1e6, volume6h: 6e6, decimals: 6 };
  e.market.safety[mint] = { ts: Date.now(), rugScore: 1, danger: [], holderRisk: false, mintAuthority: null, freezeAuthority: null, token2022Ext: false, decimals: 6 };
  e.watch.set(mint, { symbol: sym, core: false });
}
const vote = (id, dir, conf = 0.8) => ({ id, dir, conf, why: 'test' });
const stubQuote = (e) => async (i, o, amt) => (i === USDC ? { outAmount: String(Math.floor((Number(amt) / 1e6 / e.market.prices[o].usd) * 1e6)), priceImpactPct: '0.001' } : { outAmount: '1000', priceImpactPct: '0' });

test('struttura: 12 analisti (non operano), 2 trader (gli unici che operano), id unici', () => {
  assert.strictEqual(D.ANALYSTS.length, 12); assert.strictEqual(D.EXECUTORS.length, 2);
  assert.deepStrictEqual(D.EXEC_IDS, ['alpha', 'omega']);
  assert.strictEqual(new Set(D.BOT_IDS).size, 14);
  for (const A of D.ANALYSTS) { assert.ok(A.name && A.desc && A.icon); assert.strictEqual(typeof A.fn, 'function'); }
  const om = D.EXECUTORS.find((x) => x.id === 'omega'); const al = D.EXECUTORS.find((x) => x.id === 'alpha');
  assert.strictEqual(al.domain, 'perp'); assert.strictEqual(om.domain, 'spot'); assert.ok(om.thr > al.thr, 'Omega più selettivo');
});

test('analisti: votano davvero su dati reali (trend in salita → segnali LONG), mai errori', () => {
  const e = mkEngine(); e.market.candles[SOL] = candles(200, 0.0008, 100);
  const ctx = e.desk.context({ mint: SOL, symbol: 'SOL', perp: true, market: 'SOL' }, { __macro: {} });
  const votes = e.desk.analyze(ctx);
  assert.ok(votes.length >= 10, 'analisti per i perps (memecoin esclusa)'); assert.ok(!votes.some((v) => /errore/.test(v.why)), JSON.stringify(votes.filter((v) => /errore/.test(v.why))));
  assert.ok(votes.some((v) => v.dir === 1), 'almeno un segnale LONG'); assert.ok(!votes.some((v) => v.id === 'meme'), 'l\'analista memecoin guarda solo lo spot');
  for (const v of votes) assert.ok(v.conf >= 0 && v.conf <= 1);
});

test('consenso pesato: a favore − contro, astenuti contano poco, pesi e preferenze del trader', () => {
  const e = mkEngine(); const X = D.EXECUTORS[1];
  const all = e.desk.consensus([vote('flow', 1), vote('meme', 1), vote('whale', 1), vote('trend', 1)], 'LONG', null);
  assert.ok(Math.abs(all.score - 0.8) < 1e-9); assert.strictEqual(all.yes.length, 4);
  const split = e.desk.consensus([vote('flow', 1), vote('trend', -1)], 'LONG', null); assert.ok(Math.abs(split.score) < 1e-9);
  const abst = e.desk.consensus([vote('flow', 1), vote('trend', 0, 0), vote('mtf', 0, 0)], 'LONG', null); assert.ok(abst.score < 0.8 && abst.score > 0.4);
  const short = e.desk.consensus([vote('flow', -1), vote('trend', -1)], 'SHORT', null); assert.ok(short.score > 0.7);
  // Omega dà più peso a flusso/memecoin: con flow pro e trend contro vince il lato LONG
  assert.ok(e.desk.consensus([vote('flow', 1), vote('trend', -1)], 'LONG', X).score > 0);
  // il MENTORE pesa di più chi ha ragione
  e.desk.aState('trend').weight = 1.6; assert.ok(e.desk.consensus([vote('flow', 1), vote('trend', -1)], 'LONG', null).score < 0);
});

test('dimensione: predefinito 20%, regolabile fino al 100% del capitale; il consenso scala il margine; esposizione totale limitata', () => {
  assert.strictEqual(S.MAX_TRADE_PCT, 100); assert.strictEqual(S.SAFE_TRADE_PCT, 20); assert.strictEqual(DEFAULTS.maxTradePct, 20);
  assert.strictEqual(S.sizePosition({ capital: 1000, cash: 1000, cfg: DEFAULTS, core: true, minTrade: 1 }).size, 200);
  assert.strictEqual(S.sizePosition({ capital: 1000, cash: 1000, cfg: { ...DEFAULTS, maxTradePct: 100 }, core: true, minTrade: 1 }).size, 1000);
  assert.strictEqual(S.sizePosition({ capital: 1000, cash: 300, cfg: { ...DEFAULTS, maxTradePct: 100 }, core: true, minTrade: 1 }).size, 300, '100% ma mai oltre il contante');
  assert.strictEqual(S.sizePosition({ capital: 1000, cash: 1000, cfg: DEFAULTS, core: true, minTrade: 1, frac: 0.4 }).size, 80);
  assert.strictEqual(S.sizePosition({ capital: 1000, cash: 50, cfg: DEFAULTS, core: true, minTrade: 1 }).size, 50, 'mai più del contante');
  const cfg = { ...DEFAULTS, maxExposurePct: 400 };
  const pos = [{ costBase: 200, lev: 10 }, { costBase: 100, lev: 10 }];
  const ok = S.exposureFit({ positions: [], equity: 1000, cfg, size: 200, lev: 10 }); assert.strictEqual(ok.size, 200);
  const fit = S.exposureFit({ positions: pos, equity: 1000, cfg, size: 200, lev: 10, minTrade: 1 }); assert.ok(Math.abs(fit.size - 100) < 1e-9, 'ridotto per stare nel 400%');
  const full = S.exposureFit({ positions: [...pos, { costBase: 100, lev: 10 }], equity: 1000, cfg, size: 200, lev: 10, minTrade: 1 }); assert.strictEqual(full.size, 0); assert.match(full.reason, /Esposizione massima/);
});

test('tanti ingressi in poco tempo: più di 5 posizioni insieme, max 4 per giro, rispetta il massimo di posizioni', async () => {
  const e = mkEngine({ maxTradePct: 10, cfgVersion: 12 }); assert.strictEqual(e.cfg.maxOpen, 8);
  const coins = Array.from({ length: 12 }, (_, i) => good({ mint: mkMint(i), symbol: 'S' + i, change1h: 2 + i }));
  e.universe.setCoins(coins); for (const c of coins) readySpot(e, c.mint, c.symbol);
  e.desk.analyze = () => ['flow', 'meme', 'whale', 'trend', 'momentum'].map((id) => vote(id, 1, 0.6));
  const real = jup.quote; jup.quote = stubQuote(e);
  try {
    e.desk.pickCoins();
    const t1 = await e.desk.turn(); assert.ok(t1.length >= 3 && t1.length <= D.MAX_ENTRIES_PER_TURN, `giro 1: ${t1.length}`);
    await e.desk.turn(); await e.desk.turn(); await e.desk.turn();
    const n = e.book.positions.length; assert.ok(n > 5, `${n} posizioni aperte`); assert.ok(n <= 8, 'massimo 8');
    assert.ok(e.book.positions.every((p) => p.bot === 'omega' && p.lev === 1 && p.side === 'LONG' && p.costBase <= 100 + 1e-6 && p.votes.length === 5));
    assert.strictEqual(new Set(e.book.positions.map((p) => p.mint)).size, n, 'una posizione per cripto');
    const v = e.desk.view(); assert.strictEqual(v.risk.open, n); assert.strictEqual(v.risk.maxOpen, 8); assert.strictEqual(v.execs.find((x) => x.id === 'omega').open, n);
    assert.strictEqual(v.execs.find((x) => x.id === 'omega').decision.kind, 'open');
  } finally { jup.quote = real; }
});

test('consenso debole o pochi analisti d\'accordo: nessun ingresso, decisione «attesa» visibile', async () => {
  const e = mkEngine(); e.cfg.pace = 'prudente'; const M = mkMint(1); e.universe.setCoins([good({ mint: M, symbol: 'WEAK' })]); readySpot(e, M, 'WEAK'); // Ritmo prudente: Omega vuole 34% e 3 analisti
  e.desk.analyze = () => [vote('flow', 1, 0.9), vote('meme', 1, 0.9), vote('whale', -1, 0.5)];
  const real = jup.quote; jup.quote = stubQuote(e);
  try { e.desk.pickCoins(); assert.strictEqual((await e.desk.turn()).length, 0); assert.strictEqual(e.desk.view().execs.find((x) => x.id === 'omega').decision.kind, 'wait'); }
  finally { jup.quote = real; }
});

test('Alpha: perps con leva 5x, short consentito, mai long e short insieme sullo stesso asset; leva quella impostata', async () => {
  const e = mkEngine({ cfgVersion: 12, leverage: 10 }); e.market.candles[SOL] = candles(200, -0.0005, 100); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() };
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf'].map((id) => vote(id, -1, 0.5));
  e.desk.pickCoins(); const [p] = await e.desk.turn();
  assert.ok(p && p.perp); assert.strictEqual(p.side, 'SHORT'); assert.strictEqual(p.bot, 'alpha'); assert.strictEqual(p.lev, 10, 'leva impostata (10x)');
  assert.ok(p.slPct <= P.liqDistancePct(p.lev) * 0.4 + 1e-9, 'stop sempre prima della liquidazione');
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf'].map((id) => vote(id, 1, 0.9));
  await e.desk.turn(); assert.strictEqual(e.book.positions.filter((x) => x.mint === SOL).length, 1, 'niente LONG con uno SHORT aperto');
});

test('limite di perdita giornaliera: oltre il 15% nessun nuovo ingresso, le posizioni restano gestite', async () => {
  const e = mkEngine({ cfgVersion: 12 }); assert.strictEqual(e.cfg.dailyLossPct, 15);
  const M = mkMint(2); e.universe.setCoins([good({ mint: M, symbol: 'BRK' })]); readySpot(e, M, 'BRK');
  e.desk.analyze = () => ['flow', 'meme', 'whale', 'trend', 'momentum'].map((id) => vote(id, 1, 0.8));
  e.book.cash = 840; // −16% oggi
  const real = jup.quote; jup.quote = stubQuote(e);
  try {
    e.desk.pickCoins(); assert.strictEqual((await e.desk.turn()).length, 0);
    const br = e.desk.view().breaker; assert.ok(br && br.limit === 15 && br.pct >= 15);
    assert.ok(e.st.log.some((l) => /Limite di perdita giornaliera/.test(l.text)));
    e.book.dayKey = '2000-01-01'; e.book.dayStartEquity = e.equity(); // nuovo giorno
    assert.strictEqual(e.desk.checkBreaker(), null); assert.strictEqual((await e.desk.turn()).length, 1);
  } finally { jup.quote = real; }
});

test('correzioni del MENTORE: 2 perdite → più selettivo, 3 → pausa; pesi degli analisti dal tasso di successo', () => {
  const e = mkEngine(); const lose = { bot: 'alpha', side: 'LONG', pnl: -1, votes: [{ id: 'trend', dir: 1 }, { id: 'funding', dir: -1 }] };
  e.desk.onClose(lose); e.desk.onClose(lose);
  assert.strictEqual(e.desk.xState('alpha').selectivity, 0.05); assert.ok(e.desk.view().corrections.length === 1);
  e.desk.onClose(lose); assert.ok(e.desk.xState('alpha').restUntil > Date.now());
  assert.ok(e.desk.weight('trend') < 1, 'sbagliava → pesa meno'); assert.ok(e.desk.weight('funding') > 1, 'aveva ragione → pesa di più');
  for (let i = 0; i < 100; i++) e.desk.onClose(lose);
  assert.ok(e.desk.weight('trend') >= D.RULES.W_MIN && e.desk.weight('funding') <= D.RULES.W_MAX);
  assert.ok(e.desk.xState('alpha').selectivity <= D.RULES.SEL_MAX);
});

test('pausa: trader e analisti, id sconosciuti rifiutati; analista in pausa non vota', () => {
  const e = mkEngine();
  e.desk.setPaused('omega', true); assert.ok(e.desk.view().execs.find((x) => x.id === 'omega').paused);
  e.desk.setPaused('trend', true); e.market.candles[SOL] = candles(200, 0.0008, 100);
  assert.ok(!e.desk.analyze(e.desk.context({ mint: SOL, symbol: 'SOL', perp: true, market: 'SOL' }, { __macro: {} })).some((v) => v.id === 'trend'));
  assert.throws(() => e.desk.setPaused('nova', true), /Bot sconosciuto/);
});

test('migrazione dall\'Osservatorio: posizioni e storico passano ai trader, nulla si perde, wallet intatto', () => {
  const now = Date.now();
  const e = mkEngine({ cfgVersion: 11, maxTradePct: 7, maxOpen: 3 }, (d) => {
    const book = { ...newBook(1000, { feeReserveSol: 0.02 }), cash: 900,
      positions: [{ id: 'p1', mint: SOL, symbol: 'SOL', perp: true, side: 'SHORT', lev: 5, qty: 1, costBase: 70, feesBase: 0, entryPrice: 100, slPct: 2, tpPct: 4, openedAt: now, bot: 'nova' },
        { id: 'p2', mint: mkMint(3), symbol: 'FROG', lev: 1, qty: 10, costBase: 30, feesBase: 0, entryPrice: 1, slPct: 5, tpPct: 10, openedAt: now, bot: 'selene' }],
      trades: [{ id: 't1', symbol: 'ETH', perp: true, pnl: 3, bot: 'orione', closedAt: now }, { id: 't2', symbol: 'BONK', pnl: -1, player: 'A3', team: 'A', closedAt: now }],
      cooldown: { 'nova:x:LONG': now + 1e6, [SOL]: now + 1e6 } };
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ books: { SIM: book }, galaxy: { bots: { nova: { pnl: 3 } } }, match: { id: 1 }, agents: {}, log: [], deposits: [], realTxs: [], userWallet: null, withdrawAddress: null }));
  });
  const b = e.st.books.SIM;
  assert.ok(!e.st.galaxy && !e.st.match && e.st.desk);
  assert.strictEqual(b.positions.length, 2); assert.strictEqual(b.trades.length, 2, 'storico conservato');
  assert.deepStrictEqual(b.positions.map((p) => [p.bot, p.origBot]), [['alpha', 'nova'], ['omega', 'selene']]);
  assert.strictEqual(b.trades[0].bot, 'alpha'); assert.ok(!('team' in b.trades[1]));
  assert.ok(!('nova:x:LONG' in b.cooldown)); assert.ok(SOL in b.cooldown);
  assert.strictEqual(e.cfg.maxTradePct, 20); assert.strictEqual(e.cfg.maxOpen, 8); assert.strictEqual(e.cfg.cycleSec, 5); assert.strictEqual(e.cfg.pace, 'aggressivo');
  assert.strictEqual(e.desk.view().execs.find((x) => x.id === 'alpha').trades, 1);
});

test('REALE: Alpha resta fermo (perps in attesa del test); Omega solo se «Spot REALE» è acceso', async () => {
  const e = mkEngine({ cfgVersion: 12 }); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.ks.kp = {}; e.bal = { sol: 1, tokens: {} };
  e.market.candles[SOL] = candles(200, 0.0008, 100);
  e.desk.analyze = () => ['trend', 'momentum', 'breakout', 'mtf', 'flow'].map((id) => vote(id, 1, 0.9));
  let swaps = 0; e.realSwap = async () => { swaps++; return { ok: false, err: 'test' }; };
  e.desk.pickCoins(); await e.desk.turn();
  assert.strictEqual(e.book.positions.length, 0); assert.strictEqual(swaps, 0); assert.ok(e.desk.view().realWaiting);
  assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
});
