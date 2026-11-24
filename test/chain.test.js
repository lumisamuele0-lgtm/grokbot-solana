const test = require('node:test');
const assert = require('node:assert');
const { Keypair, VersionedTransaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const chain = require('../src/chain');
const { USDC } = require('../src/tokens');
const fakeConn = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }) };

test('deposito SOL: unico trasferimento = budget + riserva, firmatario = utente, non firmato', async () => {
  const user = Keypair.generate().publicKey.toBase58(), bot = Keypair.generate().publicKey.toBase58();
  const r = await chain.buildDepositTx(fakeConn, { from: user, to: bot, currency: 'SOL', amount: 1.5, usdcMint: USDC, feeReserveSol: 0.03 });
  const tx = VersionedTransaction.deserialize(Buffer.from(r.base64, 'base64'));
  const m = tx.message; const keys = m.staticAccountKeys.map((k) => k.toBase58());
  assert.strictEqual(keys[0], user); assert.strictEqual(m.header.numRequiredSignatures, 1);
  assert.ok(tx.signatures.every((s) => s.every((b) => b === 0)), 'deve essere non firmata');
  assert.strictEqual(m.compiledInstructions.length, 1);
  const ix = m.compiledInstructions[0];
  assert.strictEqual(keys[ix.programIdIndex], SystemProgram.programId.toBase58());
  assert.strictEqual(keys[ix.accountKeyIndexes[1]], bot);
  assert.strictEqual(Buffer.from(ix.data).readBigUInt64LE(4), BigInt(Math.round(1.53 * LAMPORTS_PER_SOL)));
});
test('deposito USDC: crea conto del bot, transferChecked importo esatto, + riserva SOL', async () => {
  const user = Keypair.generate().publicKey.toBase58(), bot = Keypair.generate().publicKey.toBase58();
  const r = await chain.buildDepositTx(fakeConn, { from: user, to: bot, currency: 'USDC', amount: 25.5, usdcMint: USDC, feeReserveSol: 0.03 });
  const m = VersionedTransaction.deserialize(Buffer.from(r.base64, 'base64')).message; const keys = m.staticAccountKeys.map((k) => k.toBase58());
  assert.strictEqual(m.compiledInstructions.length, 3);
  const [ata, tr, sol] = m.compiledInstructions;
  assert.strictEqual(Buffer.from(ata.data)[0], 1);
  const d = Buffer.from(tr.data); assert.strictEqual(d[0], 12); assert.strictEqual(d.readBigUInt64LE(1), 25500000n); assert.strictEqual(d[9], 6);
  assert.strictEqual(keys[tr.accountKeyIndexes[2]], chain.ata(bot, USDC).toBase58());
  assert.strictEqual(Buffer.from(sol.data).readBigUInt64LE(4), 30000000n);
});
test('ATA deterministico e istruzione di chiusura conto', () => {
  const o = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  assert.strictEqual(chain.ata(o, USDC).toBase58(), chain.ata(o.toBase58(), USDC).toBase58());
  assert.strictEqual(chain.closeAccountIx(o, o, o).data[0], 9);
});
