// Verifica del percorso REALE senza inviare nulla: costruisce quote + swap Jupiter e i depositi,
// poi li fa SOLO simulare dal nodo RPC (simulateTransaction). Nessuna transazione viene inviata.
const { Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const jup = require('../src/jupiter');
const chain = require('../src/chain');
const { USDC, SOL } = require('../src/tokens');
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const rpc = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const c = chain.connection(rpc);

async function sim(tx, label) {
  const r = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const v = r.value;
  const out = { label, err: v.err ? JSON.stringify(v.err) : null, units: v.unitsConsumed, lastLogs: (v.logs || []).slice(-2) };
  console.log(JSON.stringify(out));
  return out;
}
async function findFunded() {
  // indirizzi pubblici di exchange molto noti (solo lettura/simulazione)
  const cands = (process.env.FUNDED || 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS,2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm,FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5,AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2,5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD,ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ,5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9').split(',');
  for (const a of cands) {
    try {
      const info = await c.getAccountInfo(new PublicKey(a));
      if (!info || !info.owner.equals(SystemProgram.programId) || info.lamports < 1e9) continue;
      const ataInfo = async (mint) => { const r = await c.getParsedAccountInfo(chain.ata(a, mint)); const i = r.value && r.value.data.parsed.info; return i && i.state === 'initialized' ? i.tokenAmount.uiAmount : 0; };
      const u = await ataInfo(USDC);
      if (u < 100) { console.log('candidato scartato (USDC ATA vuoto o congelato)', a); continue; }
      let sell = null;
      for (const m of [JUP, BONK, 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm']) { const x = await ataInfo(m); if (x > 0) { sell = { mint: m, ui: x }; break; } }
      return { address: a, sol: info.lamports / 1e9, usdc: u, sell };
    } catch (e) { console.log('candidato scartato', a, e.message); }
  }
  throw new Error('nessun indirizzo pubblico finanziato trovato');
}
(async () => {
  const results = [];
  const throwaway = Keypair.generate();
  console.log('Wallet usa-e-getta generato:', throwaway.publicKey.toBase58());
  // 1) swap reale costruito per il wallet usa-e-getta (vuoto): firma locale + simulazione
  const q1 = await jup.quote(USDC, JUP, 5_000000n, 100);
  console.log(`Quote Jupiter 5 USDC → JUP: out=${q1.outAmount} impatto=${q1.priceImpactPct} rotta=${q1.routePlan.map((r) => r.swapInfo.label).join('>')}`);
  const s1 = await jup.swapTx(q1, throwaway.publicKey.toBase58(), 200000);
  s1.tx.sign([throwaway]);
  console.log(`Transazione swap: ${s1.tx.serialize().length} byte, firmata=${s1.tx.signatures[0].some((b) => b)}, lastValidBlockHeight=${s1.lastValidBlockHeight}`);
  results.push(await sim(s1.tx, 'swap USDC→JUP con wallet usa-e-getta VUOTO (atteso errore fondi)'));
  // 2) stesse transazioni per un indirizzo pubblico con fondi (solo simulazione, nessuna firma possibile)
  const f = await findFunded();
  console.log('Indirizzo pubblico con fondi usato SOLO per simulare:', f.address, `(${f.sol.toFixed(1)} SOL, ${f.usdc.toFixed(0)} USDC)`);
  const tests = [[USDC, JUP, 5_000000n, 'swap 5 USDC→JUP (acquisto)'], [SOL, BONK, 20_000000n, 'swap 0,02 SOL→BONK (acquisto)'], [USDC, SOL, 5_000000n, 'swap 5 USDC→SOL']];
  if (f.sell) { const dec = (await chain.mintInfo(c, f.sell.mint)).decimals; const amt = BigInt(Math.floor(Math.min(f.sell.ui * 0.5, 5 / 0.0001) * 10 ** dec)); tests.push([f.sell.mint, USDC, amt > 0n ? amt : 1n, 'vendita token→USDC']); }
  for (const [inp, out, amt, l] of tests) {
    try {
      const q = await jup.quote(inp, out, amt, 100);
      const s = await jup.swapTx(q, f.address, 200000);
      results.push(await sim(s.tx, l + ' (indirizzo finanziato)'));
    } catch (e) { console.log(l, 'ERRORE', e.message); results.push({ label: l, err: e.message }); }
  }
  // 3) depositi Phantom → bot (non firmati) simulati dall'indirizzo finanziato verso il wallet usa-e-getta
  for (const [cur, amt] of [['SOL', 0.05], ['USDC', 10]]) {
    const d = await chain.buildDepositTx(c, { from: f.address, to: throwaway.publicKey.toBase58(), currency: cur, amount: amt, usdcMint: USDC, feeReserveSol: 0.03 });
    const { VersionedTransaction } = require('@solana/web3.js');
    results.push(await sim(VersionedTransaction.deserialize(Buffer.from(d.base64, 'base64')), `deposito ${amt} ${cur} + 0,03 SOL riserva (non firmato)`));
  }
  const unexpected = results.filter((r) => !/VUOTO/.test(r.label) && r.err);
  console.log(`\nRISULTATO: ${results.length - unexpected.length}/${results.length} come atteso`);
  process.exit(unexpected.length ? 1 : 0);
})().catch((e) => { console.error('FALLITO', e); process.exit(1); });
