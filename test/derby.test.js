const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { DERBY, derbyLev, MATCH_MS, TEAMS } = require('../src/match');
const { migrateConfig, DEFAULTS } = require('../src/config');
const S = require('../src/strategy');
const P = require('../src/perps');
const { SOL, USDC } = require('../src/tokens');

function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbderby-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 9, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
function trendUp(n = 200, k = 0.0005) { const out = []; const t = Date.now() - n * 60000; for (let i = 0; i < n; i++) { const c = 100 * (1 + k * i) + 0.3 * Math.sin(i * 1.3); out.push({ t: t + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return out; }
function noisy(n = 200, seed = 1) { let x = seed; const r = () => ((x = (x * 16807) % 2147483647) / 2147483647); const out = []; const t = Date.now() - n * 60000; let c = 100; for (let i = 0; i < n; i++) { c *= 1 + (r() - 0.48) * 0.006; out.push({ t: t + i * 60000, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 }); } return out; }
const setSol = (e, c) => { e.market.candles[SOL] = c; e.market.prices[SOL] = { usd: c[c.length - 1].c, ts: Date.now() }; };
// i limiti rigidi che il derby non deve MAI superare
function assertLimits(e, pos, teamCapital) {
  if (pos.perp) {
    assert.ok(pos.lev >= 5 && pos.lev <= P.MAX_LEV, `leva ${pos.lev} fuori da 5–10x`);
    assert.ok(pos.slPct <= P.liqDistancePct(pos.lev) * 0.4 + 1e-9, `stop ${pos.slPct}% oltre il 40% della distanza di liquidazione`);
    const stopPx = pos.side === 'SHORT' ? pos.entryPrice * (1 + pos.slPct / 100) : pos.entryPrice * (1 - pos.slPct / 100);
    assert.ok(pos.side === 'SHORT' ? stopPx < pos.liqPrice : stopPx > pos.liqPrice, 'lo stop scatta prima della liquidazione');
  } else { assert.strictEqual(pos.lev, 1); assert.strictEqual(pos.side, 'LONG'); }
  assert.ok(pos.costBase <= teamCapital * e.cfg.maxTradePct / 100 + 1e-6, `margine ${pos.costBase} oltre il ${e.cfg.maxTradePct}%`);
}

test('derby: default attivo, migrazione v9 senza toccare leva, margine e limiti', () => {
  assert.strictEqual(DEFAULTS.derby, true);
  const r = migrateConfig({ cfgVersion: 8, leverage: 10, maxTradePct: 7, dailyLossPct: 3, maxLossPct: 9, budget: 55 });
  assert.strictEqual(r.cfg.derby, true); assert.strictEqual(r.cfg.leverage, 10); assert.strictEqual(r.cfg.maxTradePct, 7); assert.strictEqual(r.cfg.dailyLossPct, 3); assert.strictEqual(r.cfg.maxLossPct, 9); assert.strictEqual(r.cfg.budget, 55);
  assert.strictEqual(migrateConfig(r.cfg).changed, false);
});

test('derby: 10x solo sui perps con segnale forte; mai in difesa; leva sempre fra la leva impostata (≥5x) e il limite 10x', () => {
  const strong = { signal: true, conf: 1 }; const weak = { signal: true, conf: 0.67 };
  assert.strictEqual(derbyLev({ perp: true, mood: 'derby', sig: strong, total: 1 }), 10);
  assert.strictEqual(derbyLev({ perp: true, mood: 'derby', sig: weak, total: 1 }), null);
  assert.strictEqual(derbyLev({ perp: true, mood: 'rimonta', sig: { signal: true, conf: 5 / 6 }, total: 1 }), 10);
  assert.strictEqual(derbyLev({ perp: true, mood: 'protect', sig: strong, total: 9 }), null, 'chi difende il vantaggio non usa il 10x');
  assert.strictEqual(derbyLev({ perp: false, mood: 'derby', sig: strong, total: 9 }), null, 'spot: niente leva');
  assert.strictEqual(derbyLev({ perp: true, mood: 'derby', sig: { signal: false, conf: 0.9 }, total: 9 }), null, 'segnale quasi pieno: leva normale');
  const e = mkEngine();
  assert.strictEqual(e.tradeLev(null), 5); assert.strictEqual(e.tradeLev(10), 10); assert.strictEqual(e.tradeLev(50), 10); assert.strictEqual(e.tradeLev(2), 5); assert.strictEqual(e.tradeLev(1), 5);
  e.cfg.leverage = 10; assert.strictEqual(e.tradeLev(null), 10); assert.strictEqual(e.tradeLev(5), 10, 'mai sotto la leva impostata');
});

test('derby: segnale forte → 10x, margine 7% della cassa di squadra, stop prima della liquidazione, trailing (runner)', async () => {
  const e = mkEngine(); setSol(e, trendUp()); e.match.start();
  const pos = await e.match.teamTurn('A');
  assert.ok(pos && pos.perp && pos.side === 'LONG'); assert.strictEqual(pos.lev, 10); assert.strictEqual(pos.runner, true);
  assert.ok(Math.abs(pos.costBase - 35) < 0.01, `7% di 500 (${pos.costBase})`); assertLimits(e, pos, 500);
  assert.ok(Math.abs(pos.sizeUsd - 35 * 10 * (1 - P.FEES.openPct / 100)) < 1 || pos.sizeUsd <= 350 + 1e-6, 'esposizione = margine × 10 al massimo');
});

test('derby: nessun limite superato in tante giocate (mercati casuali, rimonta, difesa, cicli veloci)', async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const e = mkEngine(); setSol(e, seed % 2 ? noisy(200, seed) : trendUp(200, seed % 3 ? 0.0006 : -0.0006));
    const m = e.match.start(Date.now());
    if (seed % 3 === 0) { m.endAt = Date.now() + 2 * 60e3; } // ultimi minuti: chi è avanti difende
    for (let k = 0; k < 4; k++) {
      for (const id of ['A', 'B']) {
        const pos = await e.match.teamTurn(id);
        const cap = e.match.score()[id].capital;
        if (pos) assertLimits(e, pos, Math.max(cap, m.teams[id].bankroll));
        const open = e.book.positions.filter((p) => p.team === id).length; assert.ok(open <= Math.max(1, Math.ceil(e.cfg.maxOpen / 2)), 'max posizioni per squadra');
      }
      // chiusura di metà delle posizioni (perdita) per mettere una squadra sotto e attivare la rimonta
      const p = e.book.positions[0]; if (p) { e.market.prices[SOL] = { usd: p.entryPrice * (p.side === 'SHORT' ? 1.005 : 0.995), ts: Date.now() }; await e.closePosition(p, 'test'); e.market.prices[SOL] = { usd: e.market.candles[SOL][199].c, ts: Date.now() }; }
    }
    assert.ok(e.book.positions.length <= e.cfg.maxOpen); assert.ok(e.book.positions.every((p) => !p.perp || (p.lev >= 5 && p.lev <= 10)));
  }
});

test('derby: rimonta per chi è sotto, difesa del vantaggio negli ultimi 3 minuti (5x, più selettivi)', async () => {
  const e = mkEngine(); setSol(e, trendUp()); const now = Date.now(); const m = e.match.start(now - 5 * 60e3);
  const sc = { A: { pnl: -5 }, B: { pnl: 5 } };
  assert.strictEqual(e.match.moodOf('A', sc, now), 'rimonta'); assert.strictEqual(e.match.moodOf('B', sc, now), 'derby');
  m.endAt = now + 2 * 60e3; assert.strictEqual(e.match.moodOf('B', sc, now), 'protect');
  // il leader in difesa: niente 10x anche col segnale forte
  e.match.moodOf = () => 'protect';
  const pos = await e.match.teamTurn('A');
  assert.ok(pos); assert.strictEqual(pos.lev, 5); assert.strictEqual(pos.runner, false); assertLimits(e, pos, 500);
  e.cfg.derby = false; assert.strictEqual(require('../src/match').MatchManager.prototype.moodOf.call(e.match, 'A', sc, now), 'normal');
});

test('derby: kill switch, limite giornaliero e blocchi REALE restano invariati', async () => {
  // perdita giornaliera oltre il limite: nessun nuovo ingresso nemmeno in rimonta
  const e = mkEngine(); setSol(e, trendUp()); e.match.start(); e.match.moodOf = () => 'rimonta';
  e.book.dayStartEquity = e.equity() / (1 - (e.cfg.dailyLossPct + 1) / 100);
  assert.strictEqual(await e.match.teamTurn('A'), null); assert.strictEqual(e.book.positions.length, 0);
  // perdita totale oltre il limite: kill switch
  const k = mkEngine(); setSol(k, trendUp()); k.match.start(); k.book.startEquity = k.equity() / (1 - (k.cfg.maxLossPct + 1) / 100);
  await k.match.teamTurn('A'); assert.ok(k.book.killed, 'kill switch scattato'); assert.strictEqual(k.book.positions.filter((p) => !p.closing).length, 0);
  // REALE: i perps (leva/short) restano bloccati anche nel derby
  const r = mkEngine(); r.cfg.mode = 'REAL'; r.st.books.REAL = newBook(100, r.cfg); r.ks.kp = {}; r.bal = { sol: 1, tokens: {} }; setSol(r, trendUp());
  r.setTrading(true); assert.ok(r.match.m.derby); await r.cycle();
  assert.strictEqual(r.book.positions.length, 0); assert.strictEqual(P.REAL_SHORTS_ENABLED, false);
  const res = await r.openShort({ m: SOL, s: { symbol: 'SOL' }, team: 'A' }, 5, { slPct: 1, tpPct: 2, trailPct: 1 }, 'LONG', 10);
  assert.ok(!res); assert.strictEqual(r.book.positions.length, 0);
});

test('derby: rientro rapido dopo un gol (30 s, mai più corto), panchina per chi sbaglia 2 volte, reazione al rivale', async () => {
  const e = mkEngine(); setSol(e, trendUp()); const now = Date.now(); const m = e.match.start(now);
  const evs = []; e.on('ev', (x) => evs.push(x));
  const key = `A:${SOL}:LONG`;
  e.book.cooldown[key] = now + 10 * 60e3;
  e.match.onClose({ matchId: m.id, team: 'A', player: 'A1', mint: SOL, side: 'LONG', symbol: 'SOL', pnl: 2 }, now);
  assert.strictEqual(e.book.cooldown[key], now + DERBY.WIN_COOLDOWN_MS); assert.ok(evs.some((x) => x.type === 'goal' && x.team === 'A'));
  e.book.cooldown[key] = now + 5e3; e.match.onClose({ matchId: m.id, team: 'A', player: 'A1', mint: SOL, side: 'LONG', symbol: 'SOL', pnl: 1 }, now);
  assert.strictEqual(e.book.cooldown[key], now + 5e3, 'mai più corto di quanto già previsto');
  // panchina: con 2 cripto ci sono 2 riserve; chi sbaglia 2 volte esce e una riserva entra al suo posto
  const ts = m.teams.A; ts.coins = ts.coins.slice(0, 1); e.match.assign('A', now);
  const onField = (id) => !!(ts.lineup[id] && ts.lineup[id].mint);
  const cold = TEAMS.A.players.find((p) => onField(p.id)).id; const reserves = TEAMS.A.players.filter((p) => !onField(p.id)).map((p) => p.id);
  const slot = ts.lineup[cold];
  for (let i = 0; i < 2; i++) e.match.onClose({ matchId: m.id, team: 'A', player: cold, mint: slot.mint, side: slot.side, symbol: slot.symbol, pnl: -1 }, now + i);
  assert.ok(!onField(cold), 'il giocatore in crisi va in panchina');
  assert.ok(reserves.some((id) => onField(id) && ts.lineup[id].role === slot.role), 'una riserva prende il suo posto');
  assert.ok(evs.some((x) => x.type === 'sub' && x.out === cold && x.in));
  await e.match.tick(now + DERBY.BENCH_MS + 1); assert.ok(!(ts.coach.benchUntil[cold] > 0), 'dopo 3 minuti torna disponibile');
  // reazione: il rivale gioca per primo e ha un piccolo bonus sulla stessa cripto
  e.match.rivalReact('A', { mint: SOL, symbol: 'SOL', side: 'LONG', player: 'A1' }, now);
  assert.strictEqual(m.teams.B.coach.react.mint, SOL); assert.strictEqual(e.match.firstTeam, 1);
  assert.ok(evs.some((x) => x.type === 'banter' && x.team === 'B'));
  // atmosfera: sfottò con risposta e cori
  e.match.derbyAtmosphere(now + DERBY.BANTER_MS + DERBY.CHANT_MS + 1);
  assert.ok(evs.some((x) => x.type === 'banter' && x.reply)); assert.ok(evs.some((x) => x.type === 'chant'));
  const v = e.match.view(now); assert.strictEqual(v.derby.on, true); assert.ok(v.derby.meter >= -1 && v.derby.meter <= 1);
});

test('derby: chi vince corre col trailing (metà della prima presa, niente seconda), stop invariati', () => {
  const cfg = { ...DEFAULTS };
  const base = { entryPrice: 100, slPct: 2, atrPct: 0.5, core: true, qty: 1, initQty: 1, openedAt: Date.now(), side: 'LONG' };
  const L = S.exitLevels(base, cfg);
  const a = S.exitPlan({ ...base }, 100 * (1 + L.tp1 / 100) + 0.01, Date.now(), cfg);
  const r = S.exitPlan({ ...base, runner: true }, 100 * (1 + L.tp1 / 100) + 0.01, Date.now(), cfg);
  assert.strictEqual(a.action, 'partial'); assert.strictEqual(r.action, 'partial'); assert.ok(Math.abs(r.frac - a.frac / 2) < 1e-9);
  const r2 = S.exitPlan({ ...base, runner: true, tp1Done: true, highest: 100 }, 100 * (1 + L.tp2 / 100) + 0.01, Date.now(), cfg);
  assert.notStrictEqual(r2.action, 'partial', 'niente seconda presa: il resto corre');
  const st = S.exitPlan({ ...base, runner: true }, 100 * (1 - 2.1 / 100), Date.now(), cfg); assert.strictEqual(st.action, 'close', 'lo stop-loss resta lo stesso');
});

test('derby: ricerca più frequente durante la partita (ogni 15 s al massimo)', () => {
  assert.ok(DERBY.TURN_SEC >= 15 && DERBY.TURN_SEC <= 30);
  assert.ok(MATCH_MS === 20 * 60e3);
});
