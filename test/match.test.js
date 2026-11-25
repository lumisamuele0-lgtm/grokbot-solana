const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { TEAMS, MATCH_MS, COACH } = require('../src/match');
const S = require('../src/strategy');
const P = require('../src/perps');
const { SOL, USDC } = require('../src/tokens');

function mkEngine(dir = null, cfg = {}) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sbmatch-'));
  if (!dir) fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 7, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  e.dir = d; return e;
}
function trendUp(n = 200) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 100 * (1 + 0.0005 * i) + 0.3 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function selloff(n = 200) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { let c = 100 + 0.2 * Math.sin(i / 2); if (i >= n - 8 && i < n - 1) c = 100 - (i - (n - 9)) * 0.6; if (i === n - 1) c = 100 - 7 * 0.6 + 0.4; out.push({ t: t + i * 60000, o: c, h: c * 1.0008, l: c * 0.9992, c, v: 1 }); } return out; }

test('partita: due squadre da 7 (6 giocatori specialisti + allenatore), 20 minuti, cassa divisa a metà', () => {
  for (const T of Object.values(TEAMS)) {
    assert.strictEqual(T.players.length, 6); assert.ok(T.coach && T.coach.name);
    const combos = new Set(T.players.map((p) => p.asset + p.side)); assert.strictEqual(combos.size, 6, 'ogni giocatore ha cripto e direzione diverse');
  }
  const e = mkEngine(); const m = e.match.start(1000);
  assert.strictEqual(MATCH_MS, 20 * 60e3); assert.strictEqual(m.endAt - m.startAt, MATCH_MS); assert.strictEqual(m.state, 'live');
  assert.strictEqual(m.teams.A.bankroll, 500); assert.strictEqual(m.teams.B.bankroll, 500);
  const v = e.match.view(1000 + 60e3); assert.strictEqual(v.remainingMs, MATCH_MS - 60e3); assert.strictEqual(v.teams.length, 2); assert.strictEqual(v.teams[0].players.length, 6);
});

test('timer: fischio finale a 20:00, risultato salvato in /data, trading in pausa, "Nuova partita?"', async () => {
  const e = mkEngine(); e.cfg.trading = true; const m = e.match.start(0);
  await e.match.tick(MATCH_MS - 1); assert.strictEqual(e.match.m.state, 'live');
  await e.match.tick(MATCH_MS);
  assert.strictEqual(e.match.m.state, 'ended'); assert.strictEqual(e.match.m.result.winner, null, 'nessun trade: pareggio');
  assert.strictEqual(e.cfg.trading, false); assert.strictEqual(e.match.view().awaitingNew, true);
  const saved = JSON.parse(fs.readFileSync(path.join(e.dir, 'matches.json'), 'utf8')); assert.strictEqual(saved.tally.draws, 1); assert.strictEqual(saved.history[0].id, m.id);
  e.match.dismiss(); assert.strictEqual(e.match.view().awaitingNew, false);
  e.setTrading(true); assert.strictEqual(e.match.m.state, 'live', '"Sì" / Avvia = nuova partita'); assert.notStrictEqual(e.match.m.id, m.id);
});

test('turno: i Fulmini (trend) entrano col loro specialista, 7% della cassa di squadra, leva 5x, stop prima della liquidazione', async () => {
  const e = mkEngine(); e.market.candles[SOL] = trendUp(); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() };
  e.match.start();
  const pos = await e.match.teamTurn('A');
  assert.ok(pos, 'posizione aperta'); assert.strictEqual(pos.team, 'A'); assert.strictEqual(pos.player, 'A1'); assert.strictEqual(pos.side, 'LONG'); assert.strictEqual(pos.lev, 5);
  assert.ok(Math.abs(pos.costBase - 35) < 0.01, 'margine 7% di 500'); assert.ok(pos.slPct <= P.liqDistancePct(5) * 0.4 + 1e-9);
  assert.strictEqual(pos.matchId, e.match.m.id);
  // l'altra squadra non può aprire la stessa cripto nella stessa direzione (stesso conto on-chain)
  e.match.m.teams.B.coach.bonus.B1 = 0.5;
  const b = await e.match.teamTurn('B'); assert.ok(!b || !(b.mint === SOL && b.side === 'LONG'));
});

test('contropiede: gli Squali comprano un eccesso di vendite con candela di inversione', async () => {
  const c = selloff(); const r = S.reversion(c);
  assert.ok(r.LONG.signal, JSON.stringify(r.LONG.checks)); assert.ok(!r.SHORT.signal);
  const e = mkEngine(); e.market.candles[SOL] = c; e.market.prices[SOL] = { usd: c[199].c, ts: Date.now() };
  e.match.start(); const pos = await e.match.teamTurn('B');
  assert.ok(pos && pos.team === 'B' && pos.player === 'B1' && pos.side === 'LONG');
});

test('punteggio e allenatore: bonus limitato, più selettività dopo 2 perdite, time-out dopo 3; margine e leva mai toccati', async () => {
  const e = mkEngine(); e.market.candles[SOL] = trendUp(); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() };
  const m = e.match.start(); const before = { mt: e.cfg.maxTradePct, lev: e.cfg.leverage, sl: e.cfg.slMinPct };
  const pos = await e.match.teamTurn('A');
  e.market.prices[SOL] = { usd: pos.entryPrice * 1.01, ts: Date.now() };
  await e.closeShort(pos, 1, 'Take-profit (+1,00%)');
  const sc = e.match.score(); assert.ok(sc.A.pnl > 0); assert.ok(Math.abs(sc.A.players.find((p) => p.id === 'A1').pnl - sc.A.pnl) < 1e-9); assert.strictEqual(sc.B.pnl, 0);
  assert.strictEqual(m.teams.A.coach.bonus.A1, COACH.BONUS_STEP);
  for (let i = 0; i < 5; i++) e.match.onClose({ matchId: m.id, team: 'A', player: 'A1', pnl: 1 });
  assert.strictEqual(m.teams.A.coach.bonus.A1, COACH.BONUS_MAX, 'bonus massimo 0,5');
  const now = Date.now();
  e.match.onClose({ matchId: m.id, team: 'B', player: 'B2', pnl: -1 }, now); e.match.onClose({ matchId: m.id, team: 'B', player: 'B2', pnl: -1 }, now);
  assert.strictEqual(m.teams.B.coach.selectivity, 1);
  e.match.onClose({ matchId: m.id, team: 'B', player: 'B3', pnl: -1 }, now); assert.strictEqual(m.teams.B.coach.timeoutUntil, now + COACH.TIMEOUT_MS);
  for (let i = 0; i < 20; i++) e.match.onClose({ matchId: m.id, team: 'B', player: 'B3', pnl: -1 }, now);
  assert.ok(m.teams.B.coach.selectivity <= COACH.SEL_MAX);
  assert.deepStrictEqual({ mt: e.cfg.maxTradePct, lev: e.cfg.leverage, sl: e.cfg.slMinPct }, before);
  assert.strictEqual(await e.match.teamTurn('B', now + 1000), null, 'in time-out la squadra non entra');
  assert.ok(m.teams.B.actions.some((a) => a.kind === 'timeout'));
});

test('fine partita: chiude le posizioni della partita al mercato e dichiara il vincitore', async () => {
  const e = mkEngine(); e.market.candles[SOL] = trendUp(); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() };
  const m = e.match.start(); const pos = await e.match.teamTurn('A'); assert.ok(pos);
  e.market.prices[SOL] = { usd: pos.entryPrice * 1.005, ts: Date.now() };
  await e.match.tick(m.endAt + 1);
  assert.strictEqual(e.book.positions.length, 0); const tr = e.book.trades[0];
  assert.strictEqual(tr.reason, 'Fine partita'); assert.strictEqual(tr.matchId, m.id); assert.strictEqual(tr.team, 'A');
  assert.strictEqual(e.match.m.result.winner, 'A'); assert.strictEqual(e.match.hist.tally.A, 1);
  assert.ok(e.st.log.some((l) => /VINCONO i Fulmini Rossi/.test(l.text)));
});

test('REALE: la partita segue la modalità ma non manda ordini finché il test con 5-10 USDC non è approvato', async () => {
  const e = mkEngine(); e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(100, e.cfg); e.ks.kp = {};
  e.market.candles[SOL] = trendUp(); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() };
  e.setTrading(true); assert.strictEqual(e.match.m.mode, 'REAL'); assert.strictEqual(e.match.m.teams.A.bankroll, 50);
  await e.cycle();
  assert.strictEqual(e.book.positions.length, 0, 'nessun ordine reale'); assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  assert.match(e.snapshot().match.realWaiting, /in attesa del test con 5-10 USDC/);
  assert.ok(e.st.log.some((l) => /Partita REALE in attesa/.test(l.text)));
  await assert.rejects(e.setMode('SIM'), /Partita in corso/);
});

test('riavvio: la partita sopravvive (stato su /data) e finisce all\'orario giusto', async () => {
  const e = mkEngine(); const m = e.match.start(); e.stWriter.flush();
  const e2 = mkEngine(e.dir); assert.ok(e2.match.live()); assert.strictEqual(e2.match.m.id, m.id); assert.strictEqual(e2.cfg.trading, false, 'dopo il riavvio si riparte in pausa');
  await e2.match.tick(m.endAt + 5); assert.strictEqual(e2.match.m.state, 'ended');
  const e3 = mkEngine(e.dir); assert.strictEqual(e3.match.hist.history[0].id, m.id);
});
