'use strict';
// Regressione (t60u): senza posizioni aperte il capitale NON deve salire o scendere col passare del tempo,
// anche se cambiano i prezzi di SOL/USDC/altre cripto o il cambio €/$. I SOL tenuti a parte sono mostrati separati.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');

function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbflat-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 1000, baseCurrency: 'USDC', cfgVersion: 12, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  e.refreshBalances = async () => {}; return e;
}
const setPx = (e, usdc, sol, fx) => { const t = Date.now(); e.market.prices[USDC] = { usd: usdc, ts: t }; e.market.prices[SOL] = { usd: sol, ts: t }; e.market.eurPerUsd = fx; e.lastPriceOk = t; };
const TICKS = [[1, 100, 0.92], [0.9993, 140, 0.95], [1.0008, 60, 0.89], [0.9995, 101.3, 0.9125], [1.0002, 99, 0.93]];

test('USDC, nessuna posizione: capitale, PnL, oggi, grafico e $ fermi a ogni tick con prezzi e cambio diversi', () => {
  const e = mkEngine(); const seen = [];
  for (const [u, s, fx] of TICKS) {
    setPx(e, u, s, fx); e.recordEquity();
    const S = e.snapshot();
    assert.strictEqual(S.positions.length, 0);
    assert.strictEqual(S.baseUsd, 1, 'USDC vale sempre 1 $ (niente rumore di quotazione)');
    seen.push([S.equity, S.pnl, S.pnlBox.total, S.pnlBox.day, S.capital.total, S.equity * S.baseUsd, S.pnlEur]);
  }
  for (const x of seen) assert.deepStrictEqual(x, [1000, 0, 0, 0, 1000, 1000, 0]);
  const h = e.book.equityHist.map((p) => p.v); assert.ok(h.length >= TICKS.length && h.every((v) => v === 1000), 'grafico piatto');
});

test('SOL come base, nessuna posizione: il capitale in ◎ resta fermo; il € varia ed è segnalato come tale', () => {
  const e = mkEngine({ baseCurrency: 'SOL', budget: 2 }); const eq = new Set(); const eur = new Set();
  for (const [u, s, fx] of TICKS) { setPx(e, u, s, fx); e.recordEquity(); const S = e.snapshot(); eq.add(S.equity); eur.add(Math.round(S.equityEur)); assert.strictEqual(S.pnl, 0); assert.strictEqual(S.solHeld.inCapital, true); }
  assert.deepStrictEqual([...eq], [2]); assert.ok(eur.size > 1, 'il valore in € cambia col prezzo di SOL (solo indicativo)');
});

test('SOL tenuti a parte (riserva/wallet) separati dal capitale; posizioni dell\'altro conto non nascoste', () => {
  const e = mkEngine(); setPx(e, 1, 100, 0.92);
  const S1 = e.snapshot(); assert.strictEqual(S1.solHeld.inCapital, false); assert.ok(S1.solHeld.sol > 0 && S1.solHeld.usd > 0);
  setPx(e, 1, 200, 0.92); const S2 = e.snapshot(); assert.strictEqual(S2.equity, S1.equity, 'il prezzo di SOL non tocca il capitale USDC'); assert.ok(S2.solHeld.usd > S1.solHeld.usd);
  e.st.books.REAL = { ...newBook(50, e.cfg), positions: [{ id: 'r1', mint: SOL, symbol: 'SOL', qty: 0.1, costBase: 10, feesBase: 0, entryPrice: 100, slPct: 2, tpPct: 4, openedAt: Date.now() }] };
  assert.deepStrictEqual(e.snapshot().otherBook, { mode: 'REAL', open: 1, symbols: ['SOL'] });
});

test('interfaccia: il capitale in alto è nella valuta del bot (non in € che oscilla col cambio)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/tween\('bal', \$\('#bal'\), s\.equityEur/.test(js) && !/tween\('wBal', \$\('#wBal'\), s\.equityEur/.test(js));
  assert.ok(js.includes("tween('bal', $('#bal'), s.equity, baseFmt(s))") && js.includes('otherBook') && js.includes('fuori dal capitale'));
});
