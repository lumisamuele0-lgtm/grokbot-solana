const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Mentor, classify, afterMove, LIMITS, EVAL_N } = require('../src/mentor');
const N = require('../src/news');
const P = require('../src/perps');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');

const T0 = Date.UTC(2026, 10, 25, 10);
const trade = (o = {}) => ({ id: Math.random().toString(36).slice(2), symbol: 'SOL', side: 'LONG', lev: 5, mode: 'SIM', openedAt: T0 - 3600e3, closedAt: T0, entryPrice: 100, exitPrice: 98.5, pnlPct: -8.4, reason: 'Stop-loss (-1.50%)', slPct: 1.5, atrPct: 0.4, mfe: 0.2, mae: -1.5, ctx: { regime: 'laterale' }, ...o });
const mins = (from, n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: from + (i + 1) * 60000, o: c, h: c * 1.0005, l: c * 0.9995, c, v: 1 }; });

test('post-mortem: classifica gli errori principali', () => {
  assert.strictEqual(classify(trade({ ctx: { regime: 'ribasso' } })).primary, 'contro_trend');
  assert.strictEqual(classify(trade({ side: 'SHORT', entryPrice: 100, exitPrice: 101.5, ctx: { regime: 'rialzo' } })).primary, 'contro_trend');
  assert.strictEqual(classify(trade({ ctx: { newsRisk: 0.6, regime: 'ribasso' } })).primary, 'notizie_rischiose');
  assert.strictEqual(classify(trade(), { favFromEntry: 2, favFromExit: 3.5 }).primary, 'stop_stretto', 'stop colpito e poi il prezzo è andato a favore di oltre 1R');
  assert.strictEqual(classify(trade({ exitPrice: 100.05, pnlPct: -0.6, reason: 'Tempo massimo (240 min)' })).primary, 'commissioni');
  assert.strictEqual(classify(trade({ mfe: 0.1 })).primary, 'senza_slancio');
  assert.strictEqual(classify(trade({ ctx: { funding: 0.0002 } })).tags.includes('funding_avverso'), true);
  assert.strictEqual(classify(trade({ mfe: 1, atrPct: 0.4 })).primary, 'perdita_normale');
  const win = trade({ exitPrice: 102, pnlPct: 9, reason: 'Trailing stop (+2.00%)', mfe: 2.5 });
  assert.strictEqual(classify(win).primary, 'ok');
  assert.strictEqual(classify(win, { favFromEntry: 4, favFromExit: 2 }).primary, 'uscita_prematura');
});

test('post-mortem: movimento nei 60 minuti dopo l\'uscita (long e short)', () => {
  const tr = trade(); const k = mins(T0, 60, (i) => 98.5 + i * 0.05);
  const a = afterMove(tr, k); assert.ok(a.favFromExit > 2.9 && a.favFromEntry > 1.4);
  const s = afterMove(trade({ side: 'SHORT', exitPrice: 101.5 }), mins(T0, 60, (i) => 101.5 - i * 0.05)); assert.ok(s.favFromExit > 2.8);
  assert.strictEqual(afterMove(tr, mins(T0 - 3600e3, 30, () => 100)), null, 'nessuna candela dopo l\'uscita');
});

test('correzioni: graduali, sempre entro i limiti, solo su asset e direzione interessati', () => {
  const m = new Mentor();
  for (let i = 0; i < 20; i++) { const e = { ...trade({ closedAt: T0 + i }), primary: 'stop_stretto', tags: ['stop_stretto'], status: 'final' }; m.st.journal.unshift(e); m.correct(e, T0); }
  const p = m.params('SOL', 'LONG'); assert.strictEqual(p.slMult, LIMITS.slMult[1]); assert.strictEqual(p.tpMult, 1);
  assert.strictEqual(m.params('SOL', 'SHORT').slMult, 1); assert.strictEqual(m.params('BTC', 'LONG').slMult, 1);
  const first = new Mentor(); const e = { ...trade(), primary: 'stop_stretto', tags: ['stop_stretto'], status: 'final' }; first.st.journal.unshift(e); first.correct(e, T0);
  assert.ok(Math.abs(first.params('SOL', 'LONG').slMult - 1.05) < 1e-9, 'un passo alla volta (+5%)');
  // niente parametri di leva o dimensione nelle correzioni
  assert.deepStrictEqual(Object.keys(p).sort(), ['level', 'slMult', 'tpMult', 'ver']);
});

test('correzioni: pause dopo 3 perdite di fila, evitare il regime sbagliato, rischio notizie, selettività', () => {
  const m = new Mentor();
  for (let i = 0; i < 3; i++) { const e = { ...trade({ closedAt: T0 + i, ctx: { regime: 'ribasso' } }), primary: 'contro_trend', tags: ['contro_trend'], status: 'final' }; m.st.journal.unshift(e); m.correct(e, T0); }
  const base = { symbol: 'SOL', side: 'LONG', now: T0 + 60e3 };
  assert.match(m.entryCheck({ ...base, regime: 'laterale' }).reason, /pausa/);
  assert.ok(m.entryCheck({ ...base, now: T0 + 3 * 3600e3, regime: 'laterale' }).ok, 'la pausa di 2 ore scade');
  assert.match(m.entryCheck({ ...base, now: T0 + 3 * 3600e3, regime: 'ribasso' }).reason, /evita LONG in mercato ribasso/);
  assert.ok(m.entryCheck({ symbol: 'SOL', side: 'SHORT', regime: 'ribasso', now: T0 }).ok, 'lo SHORT non è toccato');
  assert.match(m.entryCheck({ symbol: 'ETH', side: 'LONG', newsRisk: 0.7 }).reason, /notizie ad alto rischio/);
  const s = new Mentor(); s.tune('BTC', 'LONG').level = 2;
  assert.strictEqual(s.entryCheck({ symbol: 'BTC', side: 'LONG', conf: 5 / 6, flowStrict: true }).ok, false);
  assert.strictEqual(s.entryCheck({ symbol: 'BTC', side: 'LONG', conf: 1, flowStrict: true }).ok, true);
});

test('rollback: se dopo 6 trade la correzione peggiora i risultati, si torna ai valori di prima', () => {
  const m = new Mentor();
  const push = (o) => { const e = { ...trade({ closedAt: T0 + m.st.journal.length }), status: 'final', tags: [], ...o }; m.st.journal.unshift(e); return m.correct(e, T0); };
  for (let i = 0; i < 4; i++) push({ primary: 'ok', pnlPct: 1, exitPrice: 101, reason: 'Take-profit (+1%)' });
  push({ primary: 'stop_stretto', tags: ['stop_stretto'], pnlPct: -2 });
  assert.ok(m.params('SOL', 'LONG').slMult > 1);
  let notes = [];
  for (let i = 0; i < EVAL_N; i++) notes = push({ primary: 'perdita_normale', pnlPct: -5, mfe: 1 });
  assert.ok(notes.some((n) => n.kind === 'rollback'), 'correzione annullata');
  assert.strictEqual(m.params('SOL', 'LONG').slMult, 1);
});

test('diario: annotazione alla chiusura, verifica finale dopo 60 minuti con le candele successive', () => {
  const logs = []; const m = new Mentor({ log: (a, t) => logs.push(t) });
  const tr = trade(); m.onClose(tr); m.onClose(tr);
  assert.strictEqual(m.st.journal.length, 1, 'nessun doppio post-mortem'); assert.strictEqual(m.summary().pending, 1);
  assert.match(logs[0], /post-mortem \$SOL LONG/);
  assert.strictEqual(m.followUp(() => [], T0 + 10 * 60e3).length, 0, 'troppo presto');
  const les = m.followUp(() => mins(T0, 60, (i) => 98.5 + i * 0.06), T0 + 61 * 60e3);
  assert.strictEqual(les.length, 1); assert.strictEqual(les[0].primary, 'stop_stretto'); assert.ok(les[0].corrections.length);
  const sm = m.summary(); assert.strictEqual(sm.reviewed, 1); assert.strictEqual(sm.pending, 0); assert.ok(sm.errors[0].k === 'stop_stretto');
  assert.ok(m.publicSummary().reviewed === 1);
});

test('notizie: lettura RSS, sentiment e rischio per asset', () => {
  const xml = `<rss><channel><item><title><![CDATA[Solana DEX hacked, $20M drained]]></title><pubDate>${new Date(T0 - 3600e3).toUTCString()}</pubDate><link>https://x/1</link></item>
    <item><title>Bitcoin surges to record high as ETF inflows jump</title><pubDate>${new Date(T0 - 7200e3).toUTCString()}</pubDate></item>
    <item><title>Ether &amp; DeFi tokens plunge</title><pubDate>${new Date(T0 - 1800e3).toUTCString()}</pubDate></item></channel></rss>`;
  const items = N.parseRss(xml, 'Test'); assert.strictEqual(items.length, 3); assert.strictEqual(items[2].title, 'Ether & DeFi tokens plunge');
  const s = N.scoreTitle(items[0].title); assert.deepStrictEqual(s.assets, ['SOL']); assert.ok(s.risk >= 2);
  const ag = N.aggregate(items, T0);
  assert.ok(ag.BTC.sentiment > 0.5); assert.ok(ag.ETH.sentiment < -0.5); assert.ok(ag.SOL.risk > 0.5); assert.ok(ag.BTC.risk < 0.1);
  assert.strictEqual(N.aggregate(items, T0 + 48 * 3600e3).SOL.n, 0, 'notizie vecchie ignorate');
});

function mkEngine() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 7 }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  e.cfg.trendOn = false; // logica a consenso 1 minuto
  const now = Date.now(); e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.lastPriceOk = now; e.refreshBalances = async () => {};
  return e;
}
test('motore: correzioni applicate allo stop senza mai superare i limiti; ogni trade chiuso entra nel diario', async () => {
  const e = mkEngine();
  const t = e.mentor.tune('SOL', 'SHORT'); t.slMult = 1.3; t.ver = 3;
  const plan = { slPct: 5.5, tpPct: 9.9, trailPct: 3.8 };
  const hi = Math.min(e.cfg.slMaxPct, 6); const mp = e.mentor.params('SOL', 'SHORT');
  plan.slPct = Math.min(hi, plan.slPct * mp.slMult);
  await e.openShort({ m: SOL, s: { symbol: 'SOL' }, a: { atrPct: 1 }, ctx: { regime: 'ribasso', tpMult: 1.2, tuneVer: 3 } }, 70, plan, 'SHORT');
  const p = e.book.positions[0]; assert.ok(p); assert.strictEqual(p.lev, 5, 'leva mai sotto 5x');
  assert.ok(p.slPct <= 6 && p.slPct <= P.liqDistancePct(5) * 0.4 + 1e-9, 'stop sempre prima della liquidazione'); assert.ok(Math.abs(p.costBase - 70) < 0.01, 'margine 7%');
  e.market.prices[SOL] = { usd: 99, ts: Date.now() }; await e.monitor(); assert.ok(p.mfe > 0.9);
  await e.closeShort(p, 1, 'Take-profit (+1.00%)');
  const j = e.mentor.st.journal[0]; assert.ok(j && j.symbol === 'SOL' && j.side === 'SHORT' && j.ctx.regime === 'ribasso' && j.mfe > 0.9);
  assert.ok(e.st.log.some((l) => l.agent === 'MENTORE' && /post-mortem \$SOL SHORT/.test(l.text)));
  assert.ok(e.snapshot().mentor.trained === 1);
});
