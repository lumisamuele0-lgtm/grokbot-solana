const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Keypair, LAMPORTS_PER_SOL, SystemProgram } = require('@solana/web3.js');
const jup = require('../src/jupiter');
const chain = require('../src/chain');
const { Engine, newBook } = require('../src/engine');
const { Keystore } = require('../src/keystore');
const { SOL, USDC } = require('../src/tokens');
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function mkEngine(cfg = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbe-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ budget: 100, ...cfg }));
  const e = new Engine({ dataDir: d, keystore: new Keystore(path.join(d, 'w.json')) });
  const now = Date.now();
  e.market.prices[USDC] = { usd: 1, ts: now }; e.market.prices[SOL] = { usd: 100, ts: now }; e.market.prices[JUP] = { usd: 0.5, ts: now };
  e.lastPriceOk = now;
  return e;
}
// quote finta: prezzo di mercato con 0,3% di costo
function fakeQuotes(e) {
  jup.quote = async (inp, out, amt) => {
    const dec = { [USDC]: 6, [SOL]: 9, [JUP]: 6 };
    const vin = (Number(amt) / 10 ** dec[inp]) * e.market.prices[inp].usd * 0.997;
    return { inputMint: inp, outputMint: out, outAmount: String(Math.floor((vin / e.market.prices[out].usd) * 10 ** dec[out])), priceImpactPct: '0.001' };
  };
}
const plan = { slPct: 2, tpPct: 4, trailPct: 1.4 };

test('SIMULAZIONE: apertura e chiusura con commissioni e slippage contabilizzati (uscite classiche)', async () => {
  const e = mkEngine({ cfgVersion: 3, smartExits: false }); fakeQuotes(e);
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 } }, 20, plan);
  const b = e.book; assert.strictEqual(b.positions.length, 1);
  const fee = e.solToBase((5000 + e.cfg.simPriorityLamports) / LAMPORTS_PER_SOL);
  assert.ok(Math.abs(b.cash - (100 - 20 - fee)) < 1e-9);
  assert.ok(Math.abs(b.positions[0].qty - 39.88) < 0.01);
  e.market.prices[JUP].usd = 0.53; e.market.prices[JUP].ts = Date.now(); // +6% → take profit
  await e.monitor();
  assert.strictEqual(b.positions.length, 0); assert.strictEqual(b.trades.length, 1);
  const t = b.trades[0]; assert.match(t.reason, /Take-profit/);
  const expectedOut = 39.88 * 0.53 * 0.997;
  assert.ok(Math.abs(t.outBase - expectedOut) < 0.01);
  assert.ok(Math.abs(t.pnl - (t.outBase - 20 - 2 * fee)) < 1e-6, 'PnL al netto di commissioni');
  assert.ok(Math.abs(e.equity() - (100 + t.pnl)) < 1e-6, 'saldo coerente con PnL');
  assert.strictEqual(b.wins, 1); assert.ok(b.cooldown[JUP] > Date.now());
});

test('SIMULAZIONE: kill switch vende tutto e ferma il trading', async () => {
  const e = mkEngine({ maxLossPct: 5, slMinPct: 50 }); fakeQuotes(e); e.cfg.trading = true;
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 } }, 60, { slPct: 50, tpPct: 90, trailPct: 30 });
  e.market.prices[JUP].usd = 0.45; e.market.prices[JUP].ts = Date.now(); // −10% sul 60% del capitale ≈ −6%
  await e.monitor();
  const b = e.book; assert.strictEqual(b.killed, true); assert.strictEqual(e.cfg.trading, false); assert.strictEqual(b.positions.length, 0);
  assert.throws(() => e.setTrading(true), /Kill switch/);
  e.rearm(); assert.strictEqual(e.book.killed, false);
});

test('SIMULAZIONE: prelievo chiude le posizioni', async () => {
  const e = mkEngine(); fakeQuotes(e);
  await e.openPosition({ m: JUP, s: { symbol: 'JUP', decimals: 6 } }, 10, plan);
  const r = await e.withdrawAll(); assert.strictEqual(r.simulated, true); assert.strictEqual(e.book.positions.length, 0);
});

test('REALE: modalità richiede conferma scritta e wallet sbloccato', async () => {
  const e = mkEngine();
  await assert.rejects(() => e.setMode('REAL', 'si'), /ATTIVA REALE/);
  await assert.rejects(() => e.setMode('REAL', 'ATTIVA REALE'), /Crea o sblocca/);
});

test('REALE: Preleva tutto invia USDC, chiude i conti vuoti e svuota i SOL verso Phantom', async () => {
  const e = mkEngine(); fakeQuotes(e);
  e.ks.create('password-lunga');
  const bot = e.ks.kp.publicKey.toBase58(); const dest = Keypair.generate().publicKey.toBase58();
  e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(0, e.cfg); e.st.withdrawAddress = dest;
  const sent = []; let lamports = 0.25 * LAMPORTS_PER_SOL; let usdcRaw = 42500000n; let phase = 0;
  const fakeConn = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1e9 }), getBalance: async () => lamports };
  chain.connection = () => fakeConn;
  chain.getBalances = async (c, owner) => {
    if (owner !== bot) return { lamports: 0, sol: 0, tokens: {} };
    const tokens = {};
    tokens[USDC] = { raw: usdcRaw, ui: Number(usdcRaw) / 1e6, decimals: 6, accounts: [{ address: chain.ata(bot, USDC).toBase58(), raw: usdcRaw.toString(), program: chain.TOKEN_PROGRAM.toBase58() }] };
    return { lamports, sol: lamports / LAMPORTS_PER_SOL, tokens };
  };
  chain.sendAndConfirm = async (c, tx) => {
    sent.push(tx); phase++;
    if (phase === 1) usdcRaw = 0n; // dopo l'invio USDC il conto è vuoto
    return { ok: true, sig: 'sig' + phase };
  };
  await assert.rejects(() => e.withdrawAll('sbagliata!'), /Password errata/);
  const r = await e.withdrawAll('password-lunga');
  assert.strictEqual(r.dest, dest);
  assert.strictEqual(sent.length, 3, 'USDC, chiusura conti, SOL');
  const keys = (tx) => tx.message.staticAccountKeys.map((k) => k.toBase58());
  // 1) USDC → ATA di Phantom, importo pieno
  const t1 = sent[0].message; const tr = t1.compiledInstructions[1];
  assert.strictEqual(Buffer.from(tr.data).readBigUInt64LE(1), 42500000n);
  assert.strictEqual(keys(sent[0])[tr.accountKeyIndexes[2]], chain.ata(dest, USDC).toBase58());
  // 2) chiusura conto token vuoto
  assert.strictEqual(Buffer.from(sent[1].message.compiledInstructions[0].data)[0], 9);
  // 3) tutto il SOL meno la commissione → Phantom
  const t3 = sent[2].message.compiledInstructions[0];
  assert.strictEqual(keys(sent[2])[t3.programIdIndex], SystemProgram.programId.toBase58());
  assert.strictEqual(keys(sent[2])[t3.accountKeyIndexes[1]], dest);
  assert.strictEqual(Buffer.from(t3.data).readBigUInt64LE(4), BigInt(lamports - 5000));
  assert.ok(sent.every((tx) => tx.signatures[0].some((b) => b !== 0)), 'firmate dal wallet del bot');
  assert.strictEqual(e.cfg.trading, false);
});

test('REALE: dopo un riavvio i token nel wallet diventano posizioni "recuperate" protette', async () => {
  const e = mkEngine();
  e.ks.create('password-lunga'); const bot = e.ks.kp.publicKey.toBase58();
  e.cfg.mode = 'REAL'; e.st.books.REAL = newBook(0, e.cfg);
  chain.getBalances = async (c, owner) => {
    const tokens = {}; if (owner === bot) { tokens[JUP] = { raw: 40000000n, ui: 40, decimals: 6, accounts: [] }; tokens[USDC] = { raw: 5000000n, ui: 5, decimals: 6, accounts: [] }; }
    return { lamports: 1e8, sol: 0.1, tokens };
  };
  e.market.refreshPrices = async () => {};
  const n = await e.reconcile();
  assert.strictEqual(n, 1);
  const p = e.book.positions[0];
  assert.strictEqual(p.mint, JUP); assert.strictEqual(p.recovered, true); assert.ok(Math.abs(p.costBase - 20) < 1e-9); assert.ok(p.slPct > 0);
  assert.strictEqual(await e.reconcile(), 0, 'nessun doppione');
});
