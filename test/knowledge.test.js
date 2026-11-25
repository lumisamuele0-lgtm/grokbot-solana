const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const K = require('../src/knowledge');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { DEFAULTS } = require('../src/config');
const S = require('../src/strategy');

const sMeme = { ageHours: 0.5, volume24h: 20000, liquidityUsd: 60000, change1h: 20 };
const sCore = { ageHours: 5000, volume24h: 9e6, liquidityUsd: 2e7, change1h: 1 };
const a = { atrPct: 1, rsi: 60, m15: 1, trend5: true, checks: { x: true, y: true, z: false } };
const f = { score: 0.2 };

test('caratteristiche: etichette leggibili, niente valori mancanti', () => {
  const ft = K.featuresOf({ s: sMeme, a, f, core: false, hour: 22, solMom60: 2 });
  for (const k of ['tipo:meme', 'eta:<1h', 'vol:<50k', 'liq:<100k', 'ora:sera', 'atr:media', 'pump:>15%', 'mercato:rialzo', 'trend5:rialzista', 'cond:2/3']) assert.ok(ft.includes(k), k);
  assert.ok(!ft.some((k) => k.endsWith('n/d')));
  assert.ok(!K.featuresOf({ s: {}, core: true }).some((k) => k.startsWith('atr:')));
  assert.strictEqual(K.label('eta:<1h'), 'Età pool <1h');
});

test('apprendimento: conta una sola volta per trade, simulati e reali etichettati', () => {
  const kb = K.empty();
  assert.ok(K.learn(kb, { id: 't1', feat: ['tipo:meme'], pnlPct: 3, mode: 'SIM' }));
  assert.ok(!K.learn(kb, { id: 't1', feat: ['tipo:meme'], pnlPct: 3, mode: 'SIM' }));
  K.learn(kb, { id: 't2', feat: ['tipo:meme'], pnlPct: -2, mode: 'REAL' });
  assert.strictEqual(kb.n, 2); assert.strictEqual(kb.sim, 1); assert.strictEqual(kb.real, 1);
  assert.strictEqual(kb.feats['tipo:meme'].n, 2);
  assert.ok(!K.learn(kb, { id: 't3', feat: [], pnlPct: NaN }));
});

test('smussamento: pochi trade non bastano, sotto la soglia nessuna influenza', () => {
  const kb = K.empty();
  for (let i = 0; i < 3; i++) K.learn(kb, { id: 'a' + i, feat: ['tipo:meme'], pnlPct: -10 });
  const r = K.assess(kb, ['tipo:meme']);
  assert.strictEqual(r.active, false); assert.strictEqual(r.adj, 0); assert.strictEqual(r.skip, false);
  // tasso vittorie smussato resta lontano dallo 0% grezzo
  assert.ok(K.featStats(kb, 'tipo:meme').winRate > 0.2);
});

test('impara: i meme appena nati perdono, i principali vincono → scarta i primi, premia i secondi', () => {
  const kb = K.empty();
  const meme = K.featuresOf({ s: sMeme, a, f, core: false, hour: 22 });
  const core = K.featuresOf({ s: sCore, a, f, core: true, hour: 22 });
  for (let i = 0; i < 14; i++) K.learn(kb, { id: 'm' + i, feat: meme, pnlPct: i % 7 === 0 ? 2 : -4 });
  for (let i = 0; i < 14; i++) K.learn(kb, { id: 'c' + i, feat: core, pnlPct: i % 4 === 0 ? -1 : 3 });
  const rm = K.assess(kb, meme), rc = K.assess(kb, core);
  assert.ok(rm.active && rc.active);
  assert.strictEqual(rm.skip, true); assert.ok(rm.reasons[0].includes('vincenti'));
  assert.strictEqual(rc.skip, false);
  assert.ok(rc.adj > 0 && rm.adj < 0);
  assert.ok(rm.adj >= -1.5 && rc.adj <= 1);
  const sm = K.summary(kb, 3);
  assert.strictEqual(sm.trades, 28); assert.ok(sm.best.length && sm.worst.length);
  assert.ok(sm.worst.some((w) => w.label.includes('meme') || w.label.includes('<1h')));
});

test('il Mentore non cambia mai la dimensione (7%) né i limiti dell\'utente', () => {
  // la dimensione dipende solo da capitale e impostazioni, non dalla conoscenza
  const sz = S.sizePosition({ capital: 100, cash: 100, cfg: DEFAULTS, core: false, minTrade: 2 });
  assert.ok(Math.abs(sz.size - 7) < 1e-9);
  const kb = K.empty(); for (let i = 0; i < 30; i++) K.learn(kb, { id: 'x' + i, feat: ['tipo:meme'], pnlPct: 5 });
  const r = K.assess(kb, ['tipo:meme']);
  assert.ok(r.adj <= 1); assert.strictEqual(r.skip, false); assert.ok(!('size' in r));
});

test('persistenza: knowledge.json sopravvive al riavvio e impara dallo storico esistente', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 100 }));
  const trades = Array.from({ length: 4 }, (_, i) => ({ id: 'old' + i, symbol: 'X', pnlPct: i % 2 ? 2 : -1, mode: 'SIM', feat: ['tipo:meme'] }));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ books: { SIM: { cash: 100, solReserve: 0.03, positions: [], trades, startEquity: 100, budget: 100, realizedPnl: 0, feesBase: 0, dayKey: 'x', dayStartEquity: 100, equityHist: [], cooldown: {}, wins: 2, losses: 2 } }, counters: { analyzed: 0, rejected: 0, approved: 0, rules: {}, agents: {} }, agents: {}, log: [], deposits: [], realTxs: [] }));
  const mk = () => new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const e1 = mk(); assert.strictEqual(e1.kb.n, 4);
  e1.mentorLearn({ id: 'new1', symbol: 'Y', pnlPct: 3, mode: 'SIM', feat: ['tipo:meme', 'ora:sera'] });
  e1.kbWriter.flush();
  const disk = require('../src/store').readJson(path.join(d, 'knowledge.json'), null);
  assert.strictEqual(disk.n, 5); assert.ok(disk.feats['ora:sera']);
  const e2 = mk(); assert.strictEqual(e2.kb.n, 5); // niente doppio conteggio dello storico
  assert.strictEqual(e2.snapshot().knowledge.trades, 5);
  assert.ok(e2.snapshot().agents.some((x) => x.id === 'MENTORE'));
  assert.ok(e1.st.log.some((l) => l.agent === 'MENTORE' && /imparato da \$Y/.test(l.text)));
});
