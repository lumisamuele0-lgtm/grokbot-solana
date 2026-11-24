'use strict';
// Accesso a Solana: saldi, transazioni di deposito/prelievo, invio e conferma.
const {
  Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { sleep } = require('./util');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

let conn = null; let connUrl = null;
function connection(url) {
  const u = url || 'https://api.mainnet-beta.solana.com';
  if (!conn || connUrl !== u) { conn = new Connection(u, { commitment: 'confirmed' }); connUrl = u; }
  return conn;
}

const ata = (owner, mint, prog = TOKEN_PROGRAM) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), prog.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0];

function createAtaIdempotentIx(payer, owner, mint, prog = TOKEN_PROGRAM) {
  const a = ata(owner, mint, prog);
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: a, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: prog, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
function transferCheckedIx(src, mint, dst, owner, amount, decimals, prog = TOKEN_PROGRAM) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(BigInt(amount), 1); data[9] = decimals;
  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: new PublicKey(src), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(dst), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data,
  });
}
function closeAccountIx(account, dest, owner, prog = TOKEN_PROGRAM) {
  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(dest), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

async function getBalances(c, owner) {
  const pk = new PublicKey(owner);
  const [lamports, a, b] = await Promise.all([
    c.getBalance(pk),
    c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM }),
    c.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022 }).catch(() => ({ value: [] })),
  ]);
  const tokens = {};
  for (const acc of [...a.value, ...b.value]) {
    const info = acc.account.data.parsed.info;
    const t = tokens[info.mint] || { raw: 0n, ui: 0, decimals: info.tokenAmount.decimals, accounts: [] };
    t.raw += BigInt(info.tokenAmount.amount); t.ui = Number(t.raw) / 10 ** t.decimals;
    t.accounts.push({ address: acc.pubkey.toBase58(), raw: info.tokenAmount.amount, program: acc.account.owner.toBase58() });
    tokens[info.mint] = t;
  }
  return { lamports, sol: lamports / LAMPORTS_PER_SOL, tokens };
}

async function buildV0(c, payer, ixs) {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
}

// Deposito dal wallet Phantom al wallet del bot (non firmato: lo firma l'utente in Phantom).
async function buildDepositTx(c, { from, to, currency, amount, usdcMint, usdcDecimals = 6, feeReserveSol }) {
  const ixs = [];
  const reserveLamports = Math.round(feeReserveSol * LAMPORTS_PER_SOL);
  if (currency === 'SOL') {
    const lamports = Math.round(amount * LAMPORTS_PER_SOL) + reserveLamports;
    ixs.push(SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports }));
  } else {
    const raw = BigInt(Math.round(amount * 10 ** usdcDecimals));
    ixs.push(createAtaIdempotentIx(from, to, usdcMint));
    ixs.push(transferCheckedIx(ata(from, usdcMint), usdcMint, ata(to, usdcMint), from, raw, usdcDecimals));
    if (reserveLamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports: reserveLamports }));
  }
  const { tx, lastValidBlockHeight } = await buildV0(c, from, ixs);
  return { base64: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight, instructions: ixs.length };
}

// Invia una transazione firmata e la ri-invia finché non è confermata o scaduta.
async function sendAndConfirm(c, tx, lastValidBlockHeight, { timeoutMs = 90000 } = {}) {
  const raw = tx.serialize();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const st = (await c.getSignatureStatuses([sig])).value[0];
    if (st && st.err) return { sig, ok: false, err: JSON.stringify(st.err) };
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { sig, ok: true };
    const h = await c.getBlockHeight('confirmed').catch(() => 0);
    if (lastValidBlockHeight && h > lastValidBlockHeight) return { sig, ok: false, err: 'Blockhash scaduto (transazione non inclusa)' };
    c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
  }
  return { sig, ok: false, err: 'Timeout conferma' };
}

// Variazioni reali di saldo dal registro on-chain della transazione.
async function txDeltas(c, sig, owner) {
  for (let i = 0; i < 6; i++) {
    const t = await c.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (t && t.meta) {
      const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
      let idx = -1;
      for (let j = 0; j < keys.length; j++) if (keys.get(j).toBase58() === owner) { idx = j; break; }
      const solDelta = idx >= 0 ? t.meta.postBalances[idx] - t.meta.preBalances[idx] : 0;
      const td = {};
      const add = (arr, sign) => (arr || []).filter((b) => b.owner === owner).forEach((b) => { td[b.mint] = (td[b.mint] || 0n) + BigInt(sign) * BigInt(b.uiTokenAmount.amount); });
      add(t.meta.postTokenBalances, 1); add(t.meta.preTokenBalances, -1);
      return { fee: t.meta.fee, solDelta, tokenDeltas: td, err: t.meta.err };
    }
    await sleep(1500);
  }
  return null;
}

async function mintInfo(c, mint) {
  const r = await c.getParsedAccountInfo(new PublicKey(mint));
  if (!r.value) throw new Error('Mint inesistente');
  const p = r.value.data.parsed;
  const exts = (p.info.extensions || []).map((e) => e.extension);
  return {
    program: r.value.owner.toBase58(), decimals: p.info.decimals,
    mintAuthority: p.info.mintAuthority || null, freezeAuthority: p.info.freezeAuthority || null,
    risky2022: exts.filter((e) => ['transferFeeConfig', 'permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState', 'pausableConfig'].includes(e)),
  };
}

module.exports = {
  connection, ata, createAtaIdempotentIx, transferCheckedIx, closeAccountIx, getBalances, buildV0, buildDepositTx,
  sendAndConfirm, txDeltas, mintInfo, TOKEN_PROGRAM, TOKEN_2022, LAMPORTS_PER_SOL,
};
