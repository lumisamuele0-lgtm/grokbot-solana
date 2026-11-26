'use strict';
// Ritmo (Prudente / Normale / Aggressivo): ingressi più veloci senza toccare stop, tetto 20%, perdita giornaliera, kill switch, REALE
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../src/config');
const { Engine } = require('../src/engine'); const { Keystore } = require('../src/keystore');
const P = require('../src/perps'); const D = require('../src/desk'); const { Mentor } = require('../src/mentor');
const SOL = 'So11111111111111111111111111111111111111112'; const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const candles = (n, drift, start) => { const out = []; let p = start; for (let i = 0; i < n; i++) { p *= 1 + drift; out.push({ t: Date.now() - (n - i) * 60e3, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1 }); } return out; };
function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbpace-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 12, spotLongs: false, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  for (const m of Object.keys(P.SHORT_MARKETS)) { e.market.candles[m] = candles(200, 0.0004, 100); e.market.prices[m] = { usd: 100, ts: now }; }
  return e;
}
const vote = (id, dir, conf = 0.8) => ({ id, dir, conf, why: 'test' });

test('Ritmo: preset, default Aggressivo e migrazione v14 (giro 5 s, cooldown 2 min, radar 30); rischio invariato', () => {
  assert.deepStrictEqual(Object.keys(C.PACE), ['prudente', 'normale', 'aggressivo']);
  assert.strictEqual(C.DEFAULTS.pace, 'aggressivo'); assert.strictEqual(C.CFG_VERSION, 14);
  const A = C.PACE.aggressivo; assert.deepStrictEqual([A.cycleSec, A.cooldownMin, A.maxEntries, A.perTrader, A.alpha, A.omega], [5, 2, 6, 4, [0.18, 2], [0.25, 2]]);
  const { cfg } = C.migrateConfig({ cfgVersion: 13, cycleSec: 10, cooldownMin: 5, maxWatch: 16, maxTradePct: 20, dailyLossPct: 15, maxLossPct: 20, leverage: 5 });
  assert.deepStrictEqual([cfg.pace, cfg.cycleSec, cfg.cooldownMin, cfg.maxWatch], ['aggressivo', 5, 2, 30]);
  assert.deepStrictEqual([cfg.maxTradePct, cfg.dailyLossPct, cfg.maxLossPct, cfg.leverage], [20, 15, 20, 5], 'rischio non toccato');
  // cambiare Ritmo applica giro/cooldown/radar; valori sconosciuti ignorati; il preset vince sui valori dello stesso salvataggio
  const cur = { ...C.DEFAULTS, ...cfg };
  const p = C.sanitize({ pace: 'prudente', cycleSec: 4 }, cur); assert.deepStrictEqual([p.pace, p.cycleSec, p.cooldownMin, p.maxWatch], ['prudente', 15, 10, 16]);
  assert.strictEqual(C.sanitize({ pace: 'turbo' }, cur).pace, 'aggressivo');
  assert.strictEqual(C.sanitize({ cycleSec: 3 }, cur).cycleSec, 3, 'minimo 3 secondi'); assert.strictEqual(C.sanitize({ cycleSec: 1 }, cur).cycleSec, 3);
  for (const k of Object.keys(C.PACE)) assert.ok(!('maxTradePct' in C.PACE[k]) && !('dailyLossPct' in C.PACE[k]) && !('maxLossPct' in C.PACE[k]), 'nessun preset tocca i limiti di rischio');
});

const TK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const good = (o = {}) => ({ mint: 'Good1111111111111111111111111111111111111111', symbol: 'GOOD', name: 'Good', verified: true, tags: ['verified'], tokenProgram: TK, mintAuthority: null, freezeAuthority: null,
  liquidityUsd: 2e6, volume24h: 5e6, mcapUsd: 2e8, holders: 50000, topHoldersPct: 20, organic: 90, change1h: 1, change6h: 2, change24h: 3, ageDays: 400, perp: false, ...o });
const mkMint = (i) => `Pace${String(i).padStart(2, '0')}`.padEnd(43, '1');

test('Ritmo Aggressivo: soglie Alpha 18%/2 e Omega 25%/2, fino a 6 ingressi per giro e 4 per trader, radar 24', async () => {
  const e = mkEngine(); assert.strictEqual(e.cfg.pace, 'aggressivo'); assert.strictEqual(e.cfg.cycleSec, 5);
  const v = e.desk.view(); const al = v.execs.find((x) => x.id === 'alpha'), om = v.execs.find((x) => x.id === 'omega');
  assert.deepStrictEqual([al.baseThr, al.minAgree, al.maxPerTurn, om.baseThr, om.minAgree, om.maxPerTurn], [0.18, 2, 4, 0.25, 2, 4]);
  assert.deepStrictEqual([v.maxCoins, v.pace.id, v.pace.maxEntries], [24, 'aggressivo', 6]);
  e.cfg.pace = 'prudente'; const v2 = e.desk.view().execs.find((x) => x.id === 'omega'); assert.deepStrictEqual([v2.baseThr, v2.minAgree, v2.maxPerTurn], [0.34, 3, 2]);
  e.cfg.pace = 'normale'; e.desk.pickCoins(); e.desk.analyze = () => [vote('trend', 1, 0.5), vote('macro', 0, 0)]; await e.desk.turn();
  assert.strictEqual(e.desk.scan.best[0].thr, 0.22, 'Normale: soglia Alpha 22%');
  e.cfg.pace = 'aggressivo'; await e.desk.turn(); assert.strictEqual(e.desk.scan.best[0].thr, 0.18, 'Aggressivo: soglia Alpha 18%');
});

test('Mentore: in Aggressivo la pausa dopo 3 perdite dura la metà (1 ora invece di 2)', () => {
  const now = Date.now();
  for (const [scale, hours] of [[1, 2], [0.5, 1]]) {
    const m = new Mentor(); m.blockScale = scale;
    for (let i = 0; i < 3; i++) m.st.journal.push({ id: 'j' + i, symbol: 'SOL', side: 'LONG', status: 'final', pnlPct: -1, tags: [], primary: 'x', ctx: {} });
    m.correct({ symbol: 'SOL', side: 'LONG', pnlPct: -1, tags: [], primary: 'x', ctx: {} }, now);
    const b = m.tune('SOL', 'LONG').blocks.find((x) => x.kind === 'pausa'); assert.ok(b, 'pausa creata');
    assert.strictEqual(Math.round((b.until - now) / 3600e3 * 10) / 10, hours);
  }
  const e = mkEngine(); assert.strictEqual(e.mentor.blockScale, 0.5); e.cfg.pace = 'normale'; assert.strictEqual(e.mentor.blockScale, 1);
});

test('radar a rotazione: metà posti alle migliori, il resto cambia a ogni scelta', () => {
  const e = mkEngine({ spotLongs: true }); e.cfg.pace = 'prudente';
  e.universe.setCoins(Array.from({ length: 40 }, (_, i) => good({ mint: mkMint(i), symbol: 'R' + i, change1h: 2 + i * 0.1, volume24h: 1e6 * (i + 1) })));
  const a = e.desk.pickCoins().filter((c) => !c.perp).map((c) => c.mint); assert.strictEqual(a.length, 12);
  const b = e.desk.pickCoins(Date.now() + 4 * 60e3).filter((c) => !c.perp).map((c) => c.mint); assert.strictEqual(b.length, 12);
  assert.ok(b.some((m) => !a.includes(m)), 'cripto nuove dopo la rotazione');
  assert.ok(b.filter((m) => a.includes(m)).length >= 6, 'le migliori restano');
});
