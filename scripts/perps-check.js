#!/usr/bin/env node
'use strict';
// Verifica (SOLO simulazione, nessun invio, nessuna chiave) delle richieste short Jupiter Perps contro mainnet.
// Uso: node scripts/perps-check.js [proprietarioConUSDC] [posizioneShortEsistente]
const { Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const P = require('../src/perps');
const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const owner = new PublicKey(process.argv[2] || 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS');
const posPk = new PublicKey(process.argv[3] || '13pmELWTxfCxLnKSSeNUH1eevMQVHTZr8vqDEiSDBT5');
const conn = new Connection(rpc, 'confirmed');
async function sim(payer, ixs) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ...ixs] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  return { ok: r.value.err == null, err: r.value.err, units: r.value.unitsConsumed };
}
(async () => {
  let ok = true;
  for (const m of ['SOL', 'ETH', 'BTC']) {
    const r = P.increaseShortIx({ owner, market: m, sizeUsd6: 14_000_000, collateral6: 7_000_000, minPrice6: 1, counter: Date.now() % 1e9 });
    const s = await sim(owner, [r.ix]); ok = ok && s.ok;
    console.log(`apertura short ${m} 2x (7 USDC → 14 $): ${s.ok ? 'OK' : 'ERRORE ' + JSON.stringify(s.err)} · ${s.units} CU`);
  }
  const info = await conn.getAccountInfo(posPk);
  if (info) {
    const pos = P.decodePosition(info.data);
    const market = Object.keys(P.CUSTODY).find((k) => P.CUSTODY[k].equals(pos.custody));
    const pre = P.createAtaIdempotentIx(pos.owner, pos.owner, P.USDC_MINT);
    for (const [lbl, args] of [['chiusura totale', { entire: true }], ['chiusura 50%', { sizeUsd6: Math.floor((pos.sizeUsd * 1e6) / 2) }]]) {
      const r = P.decreaseShortIx({ owner: pos.owner, market, maxPrice6: 1e12, counter: (Date.now() + lbl.length) % 1e9, ...args });
      const s = await sim(pos.owner, [pre, r.ix]); ok = ok && s.ok;
      console.log(`${lbl} short ${market} (posizione ${posPk.toBase58().slice(0, 6)}…): ${s.ok ? 'OK' : 'ERRORE ' + JSON.stringify(s.err)} · ${s.units} CU`);
    }
  } else console.log('posizione di prova non trovata: salto la verifica di chiusura');
  console.log(ok ? 'Tutte le richieste sono valide on-chain (simulate, non inviate).' : 'Qualche simulazione è fallita.');
  console.log('Nota: l\'esecuzione da parte del keeper Jupiter si verifica solo con un trade reale.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
