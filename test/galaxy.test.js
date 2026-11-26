const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { BOTS, BOT_IDS, MAX_COINS, RULES, LEGACY } = require('../src/galaxy');
const { migrateConfig } = require('../src/config');
const { STRATEGIES } = require('../src/strategies');
const S = require('../src/strategy');
const P = require('../src/perps');
const store = require('../src/store');
const { SOL, USDC } = require('../src/tokens');

function mkEngine(dir = null, cfg = {}) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sbgal-'));
  if (!dir) fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 10, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  e.dir = d; return e;
}
function trendUp(n = 200) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 100 * (1 + 0.0005 * i) + 0.3 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function selloff(n = 200) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { let c = 100 + 0.2 * Math.sin(i / 2); if (i >= n - 8 && i < n - 1) c = 100 - (i - (n - 9)) * 0.6; if (i === n - 1) c = 100 - 7 * 0.6 + 0.4; out.push({ t: t + i * 60000, o: c, h: c * 1.0008, l: c * 0.9992, c, v: 1 }); } return out; }
const setSol = (e, c) => { e.market.candles[SOL] = c; e.market.prices[SOL] = { usd: c[c.length - 1].c, ts: Date.now() }; };

test('14 bot indipendenti, ognuno con la sua strategia (tutte le 12 studiate + 2 di base), niente squadre', () => {
  assert.strictEqual(BOTS.length, 14); assert.strictEqual(new Set(BOT_IDS).size, 14);
  const ids = BOTS.map((b) => b.strategy).filter(Boolean);
  assert.deepStrictEqual([...ids].sort(), STRATEGIES.map((s) => s.id).sort(), 'ogni strategia studiata ha il suo pianeta');
  assert.strictEqual(BOTS.filter((b) => !b.strategy).length, 2);
  const e = mkEngine(); const v = e.snapshot().galaxy;
  assert.strictEqual(v.bots.length, 14); assert.ok(!('match' in e.snapshot()), 'niente più partita');
  for (const b of v.bots) { assert.ok(b.name && b.strategyName && b.styleLabel); assert.strictEqual(b.pnl, 0); assert.ok(Math.abs(b.capital - 1000 / 14) < 1e-9); assert.strictEqual(b.paused, false); }
});

test('turno: il bot di trend entra con la sua analisi, 7% del capitale, leva 5x, stop prima della liquidazione; una posizione per bot', async () => {
  const e = mkEngine(); setSol(e, trendUp());
  const opened = await e.galaxy.turn();
  assert.strictEqual(opened.length, 1); const pos = opened[0];
  assert.strictEqual(pos.bot, 'nova'); assert.strictEqual(pos.side, 'LONG'); assert.strictEqual(pos.lev, 5); assert.ok(pos.perp);
  assert.ok(Math.abs(pos.costBase - 70) < 0.01, `margine 7% di 1000 (${pos.costBase})`); assert.ok(pos.slPct <= P.liqDistancePct(5) * 0.4 + 1e-9);
  assert.ok(!('team' in pos) && !('matchId' in pos));
  assert.deepStrictEqual(e.galaxy.focusMints().length <= MAX_COINS, true);
  // stesso mercato e stessa direzione: nessun altro bot (stesso conto on-chain); Nova non apre una seconda posizione
  const again = await e.galaxy.turn(); assert.ok(!again.some((p) => p.mint === SOL && p.side === 'LONG'));
  const v = e.galaxy.view(); const nova = v.bots.find((b) => b.id === 'nova'); assert.strictEqual(nova.open, 1); assert.ok(nova.activity > 0);
});

test('contropiede: Selene compra un eccesso di vendite con candela di inversione', async () => {
  const c = selloff(); assert.ok(S.reversion(c).LONG.signal);
  const e = mkEngine(); setSol(e, c);
  const opened = await e.galaxy.turn();
  assert.ok(opened.some((p) => p.bot === 'selene' && p.side === 'LONG'), JSON.stringify(opened.map((p) => p.bot + p.side)));
  assert.ok(opened.every((p) => BOTS.find((b) => b.id === p.bot).style === 'contra' || p.side === 'LONG'));
});

test('pausa di un singolo bot: non apre nulla, gli altri continuano; salvata su /data', async () => {
  const e = mkEngine(); setSol(e, trendUp());
  e.galaxy.setPaused('nova', true); assert.throws(() => e.galaxy.setPaused('pluto', true), /sconosciuto/);
  const opened = await e.galaxy.turn();
  assert.ok(opened.length && opened.every((p) => p.bot !== 'nova'), 'un altro bot di trend prende il posto');
  e.stWriter.flush(); const e2 = mkEngine(e.dir); assert.strictEqual(e2.galaxy.isPaused('nova'), true);
  e2.galaxy.setPaused('nova', false); assert.strictEqual(e2.galaxy.isPaused('nova'), false);
});

test('Mentore: più selettività dopo 2 perdite, pausa di 2 minuti dopo 3, bonus limitato; margine e leva mai toccati; il faro indica il bot', async () => {
  const e = mkEngine(); const before = { mt: e.cfg.maxTradePct, lev: e.cfg.leverage, sl: e.cfg.slMinPct }; const now = Date.now();
  for (let i = 0; i < 5; i++) e.galaxy.onClose({ bot: 'vega', pnl: 1 }, now);
  assert.strictEqual(e.galaxy.botState('vega').bonus, RULES.BONUS_MAX);
  e.galaxy.onClose({ bot: 'lyra', pnl: -1 }, now); e.galaxy.onClose({ bot: 'lyra', pnl: -1 }, now);
  assert.strictEqual(e.galaxy.botState('lyra').selectivity, 1);
  assert.ok(e.galaxy.view(now).corrections.some((c) => c.bot === 'lyra'), 'il faro illumina Lyra');
  e.galaxy.onClose({ bot: 'lyra', pnl: -1 }, now); assert.strictEqual(e.galaxy.botState('lyra').restUntil, now + RULES.REST_MS);
  assert.ok(e.galaxy.view(now).bots.find((b) => b.id === 'lyra').resting);
  for (let i = 0; i < 20; i++) e.galaxy.onClose({ bot: 'lyra', pnl: -1 }, now);
  assert.ok(e.galaxy.botState('lyra').selectivity <= RULES.SEL_MAX);
  assert.deepStrictEqual({ mt: e.cfg.maxTradePct, lev: e.cfg.leverage, sl: e.cfg.slMinPct }, before);
  assert.ok(e.galaxy.view().insight && /Lyra/.test(e.galaxy.view().insight.text));
  e.galaxy.tick(now + RULES.REST_MS + 1); assert.strictEqual(e.galaxy.botState('lyra').restUntil, 0);
});

test('chiusura: il trade va al pianeta giusto (PnL, storico); nessun limite di tempo, si opera finché non premi Pausa', async () => {
  const e = mkEngine(); setSol(e, trendUp()); e.setTrading(true);
  const [pos] = await e.galaxy.turn();
  e.market.prices[SOL] = { usd: pos.entryPrice * 1.01, ts: Date.now() };
  await e.closeShort(pos, 1, 'Take-profit (+1,00%)');
  const tr = e.book.trades[0]; assert.strictEqual(tr.bot, 'nova'); assert.ok(!('team' in tr));
  const nova = e.galaxy.view().bots.find((b) => b.id === 'nova'); assert.ok(nova.pnl > 0 && nova.capital > nova.share); assert.strictEqual(nova.history[0].symbol, tr.symbol);
  e.galaxy.tick(Date.now() + 3 * 3600e3); assert.strictEqual(e.cfg.trading, true, 'nessun fischio finale');
});

test('REALE: i bot seguono la modalità ma nessun ordine finché il test con 5-10 USDC non è approvato; cambio modalità libero senza posizioni', async () => {
  const e = mkEngine(); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.ks.kp = {};
  setSol(e, trendUp());
  e.setTrading(true); await e.cycle();
  assert.strictEqual(e.book.positions.length, 0, 'nessun ordine reale'); assert.strictEqual(P.REAL_SHORTS_ENABLED, false); assert.strictEqual(e.cfg.realSpot, false);
  assert.match(e.snapshot().galaxy.realWaiting, /in attesa del test con 5-10 USDC/);
  assert.ok(e.st.log.some((l) => /REALE in attesa/.test(l.text)));
  await e.setMode('SIM'); assert.strictEqual(e.cfg.mode, 'SIM');
});

test('migrazione dei dati: la vecchia partita sparisce, le posizioni aperte e i trade passano ai pianeti, matches.json resta intatto, config v11 senza «derby»', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbgalmig-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 500, baseCurrency: 'USDC', cfgVersion: 10, derby: true, leverage: 10, maxTradePct: 7 }));
  const book = newBook(500, { feeReserveSol: 0.05 });
  book.positions.push({ id: 'p1', mint: SOL, symbol: 'SOL', side: 'LONG', perp: true, lev: 5, costBase: 35, feesBase: 0.01, qty: 1, entryPrice: 100, slPct: 2, tpPct: 4, openedAt: Date.now(), team: 'B', player: 'B3', matchId: 'm1', sizeUsd: 175, collateralUsd: 35 });
  book.trades.push({ id: 't1', symbol: 'SOL', pnl: 2, pnlPct: 5, closedAt: Date.now(), team: 'A', player: 'A2', matchId: 'm1' });
  book.cooldown = { 'A:So1:LONG': Date.now() + 1e6, So1: Date.now() + 1e6 };
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ books: { SIM: book }, counters: { analyzed: 0, rejected: 0, approved: 0, rules: {}, agents: {} }, agents: {}, log: [], userWallet: null, withdrawAddress: null, deposits: [], realTxs: [], match: { id: 'm1', state: 'live', teams: {} } }));
  const hist = { tally: { A: 3, B: 2, draws: 1 }, history: [{ id: 'm0' }] }; store.writeJson(path.join(d, 'matches.json'), hist);
  const e = mkEngine(d);
  assert.ok(!('match' in e.st)); assert.ok(e.st.galaxy);
  const p = e.book.positions[0]; assert.strictEqual(p.bot, LEGACY.B3); assert.strictEqual(p.bot, 'polaris'); assert.ok(!('team' in p) && !('player' in p) && !('matchId' in p));
  assert.strictEqual(e.book.trades[0].bot, 'orione');
  assert.deepStrictEqual(Object.keys(e.book.cooldown), ['So1']);
  assert.strictEqual(e.galaxy.view().bots.find((b) => b.id === 'polaris').open, 1, 'la posizione resta gestita, sul suo pianeta');
  assert.deepStrictEqual(store.readJson(path.join(d, 'matches.json'), null), hist, 'vecchio storico delle partite intatto');
  assert.ok(!('derby' in e.cfg)); assert.strictEqual(e.cfg.leverage, 10); assert.strictEqual(e.cfg.maxTradePct, 7); assert.strictEqual(e.cfg.cfgVersion, 11);
  e.stWriter.flush(); assert.ok(store.isEncrypted(path.join(d, 'state.json')));
  const r = migrateConfig({ cfgVersion: 10, derby: true, memeLoose: true }); assert.ok(!('derby' in r.cfg)); assert.strictEqual(r.cfg.memeLoose, true); assert.strictEqual(migrateConfig(r.cfg).changed, false);
});

test('kill switch: chiude tutto e ferma tutti i bot', async () => {
  const e = mkEngine(); setSol(e, trendUp()); e.setTrading(true);
  await e.galaxy.turn(); assert.ok(e.book.positions.length);
  await e.killSwitch('test'); assert.strictEqual(e.book.positions.length, 0); assert.strictEqual(e.cfg.trading, false);
  assert.throws(() => e.setTrading(true), /Kill switch/);
  assert.strictEqual((await e.galaxy.turn()).length, 0, 'con il kill switch nessun ingresso (checkLimits)');
});
