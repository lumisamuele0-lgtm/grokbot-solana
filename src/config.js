'use strict';
const { CORE, OLD_MEMES } = require('./tokens');
const CFG_VERSION = 5; // aumenta quando cambiano i default da applicare anche alle installazioni esistenti
const DEFAULTS = {
  cfgVersion: CFG_VERSION,
  mode: 'SIM', // SIM | REAL
  trading: false,
  baseCurrency: 'USDC', // USDC | SOL
  budget: 100, // in valuta base
  feeReserveSol: 0.03, // SOL tenuti per le commissioni (non usati per il trading)
  maxLossPct: 20, // kill switch: perdita totale %
  maxLossAbs: 0, // kill switch: perdita assoluta in valuta base (0 = disattivato)
  dailyLossPct: 8,
  maxTradePct: 7, // rischio per operazione: % del capitale investita in ogni trade
  memeSizeMult: 1, // moltiplicatore per i meme (1 = stessa dimensione dei token principali)
  maxOpen: 3,
  slippageBps: 100,
  maxPriceImpactPct: 1.0,
  slAtrMult: 2.2, slMinPct: 1.5, slMaxPct: 10, rewardRisk: 1.8,
  maxHoldMin: 240,
  // ---- uscite furbe (distanze espresse in multipli di R = distanza dello stop-loss iniziale, che dipende dalla volatilità)
  smartExits: true,
  partialTp: true, tp1R: 1.0, tp1Pct: 40, tp2R: 2.0, tp2Pct: 30, // vende 40% a +1R, poi un altro 30% (dell'iniziale) a +2R
  beBufferPct: 0.3, // dopo la prima presa lo stop sale al prezzo d'ingresso +0,3% (copre le commissioni)
  trailOn: true, trailActR: 1.0, trailAtrMult: 1.5, // trailing attivo da +1R, distanza = 1,5 × ATR (mai più largo dello stop iniziale)
  memeExitMult: 0.75, // meme: prese e trailing più vicini (×0,75)
  timeStopOn: true, timeStopMin: 90, timeStopMinGainPct: 0.5, // dopo 90 min sotto +0,5% e senza prese → esce
  // LONG + SHORT: short su SOL/BTC/ETH tramite Jupiter Perps, collaterale USDC, leva massima 2x (limite rigido)
  // leva perps selezionabile 2x / 5x / 10x (limite rigido 10x); i long con leva sono facoltativi (spenti = long spot)
  shortsOn: true, leverage: 2, perpLongs: false,
  reversalExit: true, reversalPct: 3, // uscita rapida su crollo del momentum a 5 min o ondata di vendite
  cooldownMin: 20,
  cycleSec: 20,
  scanMemes: false, // solo cripto principali: lo scanner non cerca meme né pool nuovi
  tokens: CORE.map((t) => t.mint),
  minLiquidityUsd: 40000, minVolume24hUsd: 3000, minPairAgeMin: 1, minMcapUsd: 300000,
  maxPump1hPct: 35, maxDump24hPct: 40, maxRugScore: 30,
  maxWatch: 13,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  priorityFeeMaxLamports: 300000,
  simPriorityLamports: 30000,
  killConvertUsdc: true,
};
// limiti di validazione [min, max]
const LIMITS = {
  budget: [0, 1e9], feeReserveSol: [0.01, 1], maxLossPct: [1, 90], maxLossAbs: [0, 1e9], dailyLossPct: [1, 90], maxTradePct: [1, 100],
  memeSizeMult: [0, 1], maxOpen: [1, 10], slippageBps: [10, 1000], maxPriceImpactPct: [0.1, 10], slAtrMult: [0.5, 6], slMinPct: [0.5, 20],
  slMaxPct: [1, 40], rewardRisk: [0.8, 6], maxHoldMin: [5, 10080], tp1R: [0.3, 10], tp1Pct: [5, 90], tp2R: [0.5, 20], tp2Pct: [0, 90], beBufferPct: [0, 5], trailActR: [0.2, 10], trailAtrMult: [0.3, 6], memeExitMult: [0.3, 1.5], timeStopMin: [5, 10080], timeStopMinGainPct: [-20, 50], reversalPct: [0.5, 50], leverage: [1, 10], cooldownMin: [0, 1440], cycleSec: [10, 600], minLiquidityUsd: [0, 1e9],
  minVolume24hUsd: [0, 1e10], minPairAgeMin: [0, 600000], minMcapUsd: [0, 1e12], maxPump1hPct: [1, 1000], maxDump24hPct: [1, 100],
  maxRugScore: [0, 100], maxWatch: [1, 30], priorityFeeMaxLamports: [0, 5000000], simPriorityLamports: [0, 5000000],
};
const LEVERAGES = [2, 5, 10];
// solo 2x, 5x o 10x (si arrotonda all'opzione più vicina, mai oltre 10x)
function snapLeverage(v) { const n = Number(v) || 2; return LEVERAGES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 2); }
function sanitize(patch, current) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || ['mode', 'trading', 'cfgVersion'].includes(k)) continue;
    if (LIMITS[k]) { const n = Number(v); if (!Number.isFinite(n)) continue; out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], n)); if (k === 'leverage') out[k] = snapLeverage(out[k]); }
    else if (k === 'baseCurrency') { if (v === 'USDC' || v === 'SOL') out[k] = v; }
    else if (k === 'tokens') { if (Array.isArray(v)) out[k] = [...new Set(v.filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))].slice(0, 40); }
    else if (k === 'rpcUrl') { if (/^https:\/\/[^\s]+$/.test(v)) out[k] = v; }
    else if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
  }
  return out;
}
// Migrazione una tantum della configurazione salvata (config.json sul volume /data).
// Tocca SOLO i parametri di strategia indicati: wallet, PIN e stato non sono in questo file.
const MIGRATIONS = {
  2: (c) => { c.maxTradePct = 7; c.minVolume24hUsd = 3000; c.minPairAgeMin = 1; c.memeSizeMult = 1; delete c.minPairAgeHours; },
  3: (c) => { for (const k of ['smartExits', 'partialTp', 'tp1R', 'tp1Pct', 'tp2R', 'tp2Pct', 'beBufferPct', 'trailOn', 'trailActR', 'trailAtrMult', 'memeExitMult', 'timeStopOn', 'timeStopMin', 'timeStopMinGainPct', 'reversalExit', 'reversalPct']) c[k] = DEFAULTS[k]; },
  // v4: niente meme, solo cripto principali (lista token aggiornata; i token aggiunti a mano restano, tranne i vecchi meme)
  // v5: short attivi a 2x (resto della configurazione, wallet e PIN invariati)
  5: (c) => { c.shortsOn = true; c.leverage = 2; },
  4: (c) => { c.scanMemes = false; const extra = (Array.isArray(c.tokens) ? c.tokens : []).filter((m) => !OLD_MEMES.includes(m) && !CORE.some((t) => t.mint === m)); c.tokens = [...CORE.map((t) => t.mint), ...extra]; if ((c.maxWatch || 0) < CORE.length + 1) c.maxWatch = CORE.length + 1; },
};
function migrateConfig(saved) {
  const c = { ...(saved || {}) };
  const from = Number(c.cfgVersion) || 1;
  for (let v = from + 1; v <= CFG_VERSION; v++) if (MIGRATIONS[v]) MIGRATIONS[v](c);
  delete c.minPairAgeHours;
  c.cfgVersion = Math.max(from, CFG_VERSION);
  return { cfg: c, changed: from < CFG_VERSION, from };
}
module.exports = { DEFAULTS, LIMITS, LEVERAGES, snapLeverage, sanitize, migrateConfig, CFG_VERSION };
