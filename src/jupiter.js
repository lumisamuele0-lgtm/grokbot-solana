'use strict';
// Jupiter (API gratuita, senza chiave): quote + transazione di swap.
const { VersionedTransaction } = require('@solana/web3.js');
const { fetchJson, rateQueue } = require('./util');

const BASE = process.env.JUP_API || 'https://lite-api.jup.ag';
const q = rateQueue(1600); // coda unica per tutte le chiamate a lite-api.jup.ag (limite gratuito)

async function quote(inputMint, outputMint, amountRaw, slippageBps) {
  const url = `${BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${BigInt(amountRaw).toString()}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const r = await q(() => fetchJson(url, { retries: 2 }));
  if (!r || !r.outAmount) throw new Error('Nessuna rotta Jupiter');
  return r;
}

async function swapTx(quoteResponse, userPublicKey, maxPriorityLamports) {
  const body = {
    quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: 'high' } },
  };
  const r = await q(() => fetchJson(`${BASE}/swap/v1/swap`, { method: 'POST', body, retries: 2, timeout: 20000 }));
  if (!r || !r.swapTransaction) throw new Error('Jupiter non ha restituito la transazione');
  return { tx: VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64')), lastValidBlockHeight: r.lastValidBlockHeight, raw: r };
}

module.exports = { quote, swapTx, JUP_BASE: BASE, jupQueue: q };
