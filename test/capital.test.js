const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const jup = require('../src/jupiter');
const { capitalBreakdown, fmtMoney } = require('../src/capital');
const { Engine } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbc-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 100, baseCurrency: 'USDC', ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now();
  e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.market.prices[JUP] = { usd: 0.5, ts: now };
  e.lastPriceOk = now;
  jup.quote = async (inp, out, amt) => {
    const dec = { [USDC]: 6, [SOL]: 9, [JUP]: 6 };
    const vin = (Number(amt) / 10 ** dec[inp]) * e.market.prices[inp].usd * 0.997;
    return { inputMint: inp, outputMint: out, outAmount: String(Math.floor((vin / e.market.prices[out].usd) * 10 ** dec[out])), priceImpactPct: '0.001' };
  };
  const evs = []; e.on('ev', (x) => evs.push(x)); e.evs = evs;
  return e;
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('ripartizione: totale = disponibile − commissioni SOL + in posizioni, percentuali della barra', () => {
  const book = { cash: 60, extFees: 0.5, positions: [{ id: 'a', symbol: 'A', costBase: 20 }, { id: 'b', symbol: 'B', costBase: 15, side: 'SHORT', lev: 5 }] };
  const val = { a: 22, b: 13 };
  const c = capitalBreakdown(book, (p) => val[p.id]);
  close(c.total, 60 - 0.5 + 35); close(c.available, 60); close(c.inPositions, 35); close(c.committed, 35); close(c.openMove, 0);
  close(c.availablePct, (60 / 95) * 100); close(c.availablePct + c.inPositionsPct, 100);
  const empty = capitalBreakdown({ cash: 100, positions: [] }, () => 0);
  assert.strictEqual(empty.availablePct, 100); close(empty.total, 100);
  assert.strictEqual(fmtMoney(-35, 'USDC', true), '-35,00 $'); assert.strictEqual(fmtMoney(1234.5, 'USDC'), '1.234,50 $'); assert.strictEqual(fmtMoney(0.25, 'SOL', true), '+◎0,2500');
});

test('SIMULAZIONE spot: i soldi escono dal disponibile e rientrano alla chiusura, al centesimo', async () => {
  const e = mkEngine({ cfgVersion: 6, smartExits: false });
  const fee = e.solToBase((5000 + e.cfg.simPriorityLamports) / LAMPORTS_PER_SOL);
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 } }, 20, { slPct: 2, tpPct: 4, trailPct: 1.4 });
  const c = e.capital();
  close(c.available, 100 - 20 - fee); close(c.committed, 20); close(c.total, e.equity());
  const ev = e.evs.find((x) => x.type === 'cash'); assert.strictEqual(ev.kind, 'open'); close(ev.delta, -(20 + fee)); close(ev.after, c.available);
  assert.ok(e.st.log.some((l) => /aperta posizione \$JUP: -20,00 \$ dal disponibile \(resta 80,00 \$\)/.test(l.text)), 'riga del Logger');
  const snap = e.snapshot(); close(snap.capital.total, snap.equity); close(snap.capital.available, snap.cash);
  e.market.prices[JUP] = { usd: 0.53, ts: Date.now() }; await e.monitor();
  const t = e.book.trades[0]; const ev2 = e.evs.filter((x) => x.type === 'cash').pop();
  assert.strictEqual(ev2.kind, 'close'); close(ev2.delta, t.outBase - fee); close(ev2.pnl, t.pnl);
  const c2 = e.capital(); close(c2.inPositions, 0); close(c2.total, 100 + t.pnl, 1e-9); close(c2.available, e.book.cash);
  assert.ok(e.st.log.some((l) => /chiusa posizione \$JUP: \+[\d,]+ \$ rientrano nel disponibile \(PnL \+/.test(l.text)));
});

test('SIMULAZIONE perps: margine tolto dal disponibile, presa parziale e chiusura rientrano', async () => {
  const e = mkEngine({ cfgVersion: 6 }); e.cfg.leverage = 5;
  const fee = e.solToBase((5000 + e.cfg.simPriorityLamports) / LAMPORTS_PER_SOL);
  await e.openShort({ m: SOL, s: { symbol: 'SOL' }, a: { atrPct: 0.5 } }, 7, { slPct: 2, tpPct: 4, trailPct: 1.4 });
  const ev = e.evs.find((x) => x.type === 'cash'); close(ev.delta, -(7 + fee));
  close(e.capital().total, e.equity()); close(e.capital().committed, 7);
  e.market.prices[SOL] = { usd: 97.9, ts: Date.now() }; await e.monitor();
  const part = e.evs.filter((x) => x.type === 'cash').pop(); assert.strictEqual(part.kind, 'partial'); assert.ok(part.delta > 0 && part.pnl > 0);
  close(e.capital().total, e.equity());
  e.market.prices[SOL] = { usd: 100.5, ts: Date.now() }; await e.monitor();
  assert.strictEqual(e.book.positions.length, 0);
  close(e.capital().total, 100 + e.book.realizedPnl, 1e-9); close(e.capital().available, 100 + e.book.realizedPnl, 1e-9);
});

test('REALE: commissioni SOL esterne (base USDC) entrano nel totale come in equity', () => {
  const e = mkEngine(); e.book.extFees = 0.12; e.book.cash = 50;
  close(e.capital().total, 49.88); close(e.equity(), 49.88);
});
