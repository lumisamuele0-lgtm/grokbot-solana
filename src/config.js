'use strict';
const { CORE, OLD_MEMES } = require('./tokens');
const CFG_VERSION = 14; // aumenta quando cambiano i default da applicare anche alle installazioni esistenti
const DEFAULTS = {
  cfgVersion: CFG_VERSION,
  mode: 'SIM', // SIM | REAL
  trading: false,
  baseCurrency: 'USDC', // USDC | SOL
  budget: 100, // in valuta base
  feeReserveSol: 0.03, // SOL tenuti per le commissioni (non usati per il trading)
  maxLossPct: 20, // kill switch: perdita totale %
  maxLossAbs: 0, // kill switch: perdita assoluta in valuta base (0 = disattivato)
  dailyLossPct: 15, // limite di perdita giornaliera: oltre, nessun nuovo ingresso fino a domani
  maxTradePct: 20, // margine massimo per operazione: % del capitale (tetto rigido 20%; i trader usano 40–100% di questo in base al consenso)
  maxExposurePct: 400, // esposizione totale massima: somma di margine × leva di tutte le posizioni, in % del capitale
  memeSizeMult: 1, // moltiplicatore per i meme (1 = stessa dimensione dei token principali)
  maxOpen: 8,
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
  // leva perps selezionabile 5x / 10x (minimo 5x, limite rigido 10x); i long con leva sono facoltativi (spenti = long spot)
  shortsOn: true, leverage: 5, perpLongs: true,
  // SALA OPERATIVA: radar con SOL/BTC/ETH + fino a 12 cripto di Solana/Phantom. Leva e short solo dove ci sono i perps (SOL/BTC/ETH);
  // sulle altre spot 1x solo long. In REALE lo spot vero (swap Jupiter) parte solo se lo attivi tu (realSpot).
  spotLongs: true, realSpot: false,
  // MEMECOIN: filtri allentati per avere molte più memecoin (anti-truffa sempre attivi: via di vendita, niente mint/freeze, RugCheck, holder, pump/crolli)
  memeLoose: true, memeMinLiqUsd: 50000, memeMinVol24hUsd: 100000, memeMinMcapUsd: 1000000, memeMinAgeHours: 24, memeMinOrganic: 20, memeMaxTopHoldersPct: 60,
  uniMinLiqUsd: 250000, uniMinVol24hUsd: 500000, uniMinMcapUsd: 10000000, uniMinAgeDays: 7, uniMinOrganic: 50, uniMaxTopHoldersPct: 50,
  reversalExit: true, reversalPct: 3, // uscita rapida su crollo del momentum a 5 min o ondata di vendite
  cooldownMin: 5,
  cycleSec: 10,
  scanMemes: false, // solo cripto principali: lo scanner non cerca meme né pool nuovi
  tokens: CORE.map((t) => t.mint),
  minLiquidityUsd: 100000, minVolume24hUsd: 100000, minPairAgeMin: 1440, minMcapUsd: 5000000,
  maxPump1hPct: 35, maxDump24hPct: 40, maxRugScore: 30,
  maxWatch: 16,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  priorityFeeMaxLamports: 300000,
  simPriorityLamports: 30000,
  killConvertUsdc: true,
  // MENTE dei bot: cervello neurale (aggiusta fiducia/consenso entro limiti stretti) e ricerca web su fonti pubbliche gratuite
  brainOn: true, webResearch: true,
  // RITMO della sala operativa: prudente | normale | aggressivo (velocità di scansione, soglie di consenso, ingressi per giro,
  // cooldown, radar). NON cambia stop, tetto 20% per operazione, limite di perdita giornaliera, kill switch, anti-truffa, REALE.
  pace: 'aggressivo',
};
// preset del Ritmo (cycleSec, cooldownMin e maxWatch vengono copiati nella configurazione quando scegli il Ritmo; il resto è letto al volo)
const PACE = {
  prudente: { label: 'Prudente', cycleSec: 15, cooldownMin: 10, maxWatch: 16, maxEntries: 3, perTrader: 2, alpha: [0.26, 3], omega: [0.34, 3], coins: 12, restMs: 5 * 60e3, pickMs: 3 * 60e3, mentorScale: 1, scanSec: 60 },
  normale: { label: 'Normale', cycleSec: 10, cooldownMin: 5, maxWatch: 20, maxEntries: 4, perTrader: 3, alpha: [0.22, 2], omega: [0.3, 3], coins: 16, restMs: 2 * 60e3, pickMs: 2 * 60e3, mentorScale: 1, scanSec: 60 },
  aggressivo: { label: 'Aggressivo', cycleSec: 5, cooldownMin: 2, maxWatch: 30, maxEntries: 6, perTrader: 4, alpha: [0.18, 2], omega: [0.25, 2], coins: 24, restMs: 60e3, pickMs: 60e3, mentorScale: 0.5, scanSec: 30 },
};
const paceOf = (c) => PACE[c && c.pace] || PACE.aggressivo;
function applyPace(c, pace) { const P = PACE[pace]; if (!P) return c; c.pace = pace; c.cycleSec = P.cycleSec; c.cooldownMin = P.cooldownMin; c.maxWatch = P.maxWatch; return c; }
// limiti di validazione [min, max]
const LIMITS = {
  budget: [0, 1e9], feeReserveSol: [0.01, 1], maxLossPct: [1, 90], maxLossAbs: [0, 1e9], dailyLossPct: [1, 50], maxTradePct: [1, 20], maxExposurePct: [50, 1000],
  memeSizeMult: [0, 1], maxOpen: [1, 15], slippageBps: [10, 1000], maxPriceImpactPct: [0.1, 10], slAtrMult: [0.5, 6], slMinPct: [0.5, 20],
  slMaxPct: [1, 40], rewardRisk: [0.8, 6], maxHoldMin: [5, 10080], tp1R: [0.3, 10], tp1Pct: [5, 90], tp2R: [0.5, 20], tp2Pct: [0, 90], beBufferPct: [0, 5], trailActR: [0.2, 10], trailAtrMult: [0.3, 6], memeExitMult: [0.3, 1.5], timeStopMin: [5, 10080], timeStopMinGainPct: [-20, 50], reversalPct: [0.5, 50], leverage: [1, 10], cooldownMin: [0, 1440], cycleSec: [3, 600], minLiquidityUsd: [0, 1e9],
  minVolume24hUsd: [0, 1e10], minPairAgeMin: [0, 600000], minMcapUsd: [0, 1e12], maxPump1hPct: [1, 1000], maxDump24hPct: [1, 100],
  maxRugScore: [0, 100], uniMinLiqUsd: [50000, 1e10], uniMinVol24hUsd: [50000, 1e11], uniMinMcapUsd: [1e6, 1e13], uniMinAgeDays: [1, 3650], uniMinOrganic: [0, 100], uniMaxTopHoldersPct: [5, 100], memeMinLiqUsd: [20000, 1e10], memeMinVol24hUsd: [20000, 1e11], memeMinMcapUsd: [250000, 1e13], memeMinAgeHours: [6, 87600], memeMinOrganic: [0, 100], memeMaxTopHoldersPct: [5, 80], maxWatch: [1, 30], priorityFeeMaxLamports: [0, 5000000], simPriorityLamports: [0, 5000000],
};
const LEVERAGES = [5, 10];
// solo 5x o 10x: sotto 5 → 5x (leva minima voluta da Samuele), sopra 10 → 10x, in mezzo l'opzione più vicina
function snapLeverage(v) { const n = Number(v) || 5; return n >= 7.5 ? 10 : 5; }
function sanitize(patch, current) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || ['mode', 'trading', 'cfgVersion'].includes(k)) continue;
    if (LIMITS[k]) { const n = Number(v); if (!Number.isFinite(n)) continue; out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], n)); if (k === 'leverage') out[k] = snapLeverage(out[k]); }
    else if (k === 'baseCurrency') { if (v === 'USDC' || v === 'SOL') out[k] = v; }
    else if (k === 'pace') continue; // applicato dopo, così il preset vince sui singoli valori dello stesso salvataggio
    else if (k === 'tokens') { if (Array.isArray(v)) out[k] = [...new Set(v.filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))].slice(0, 40); }
    else if (k === 'rpcUrl') { if (/^https:\/\/[^\s]+$/.test(v)) out[k] = v; }
    else if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
  }
  if (patch && PACE[patch.pace] && patch.pace !== (current && current.pace)) applyPace(out, patch.pace);
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
  // v6: leva minima 5x (solo la leva; resto della configurazione, wallet e PIN invariati)
  6: (c) => { if (!(Number(c.leverage) >= 5)) c.leverage = 5; },
  // v7: si entra SEMPRE con leva (min 5x): accende i long con leva (resto invariato)
  7: (c) => { c.perpLongs = true; if (!(Number(c.leverage) >= 5)) c.leverage = 5; },
  // v8: partita su tutte le cripto di Solana/Phantom (max 3 per squadra): spot 1x solo long dove non c'è leva; filtri più severi
  // per i token non principali; spot REALE spento finché non lo attivi (leva, PIN, wallet e resto invariati)
  8: (c) => {
    c.spotLongs = true; c.realSpot = false;
    c.minVolume24hUsd = Math.max(Number(c.minVolume24hUsd) || 0, 100000); c.minLiquidityUsd = Math.max(Number(c.minLiquidityUsd) || 0, 100000);
    c.minMcapUsd = Math.max(Number(c.minMcapUsd) || 0, 5000000); c.minPairAgeMin = Math.max(Number(c.minPairAgeMin) || 0, 1440);
    if (!(Number(c.leverage) >= 5)) c.leverage = 5;
  },
  // v9: modalità DERBY attiva (solo questa chiave; leva, margine, stop e limiti invariati)
  9: (c) => { c.derby = true; if (!(Number(c.leverage) >= 5)) c.leverage = 5; },
  // v10: «Memecoin: filtri allentati» attivo (scelta di Samuele); soglie memecoin ai valori predefiniti, resto invariato
  10: (c) => { c.memeLoose = true; for (const k of ['memeMinLiqUsd', 'memeMinVol24hUsd', 'memeMinMcapUsd', 'memeMinAgeHours', 'memeMinOrganic', 'memeMaxTopHoldersPct']) c[k] = DEFAULTS[k]; },
  // v11: Osservatorio Galattico (niente più squadre/derby): tolta solo la chiave «derby»; leva, margine, stop, filtri, PIN e wallet invariati
  11: (c) => { delete c.derby; },
  // v12: sala operativa (12 analisti → 2 trader), scelta di Samuele: fino al 20% del capitale per operazione, fino a 8 posizioni,
  // giro ogni 10 s, limite di perdita giornaliera 15%, esposizione totale max 400%. Stop, leva, kill switch, REALE, PIN e wallet invariati.
  12: (c) => { c.maxTradePct = 20; c.maxOpen = 8; c.cycleSec = 10; c.dailyLossPct = 15; c.maxExposurePct = 400; c.cooldownMin = 5; c.maxWatch = Math.max(Number(c.maxWatch) || 0, 16); },
  // v13: cervello neurale e ricerca web dei bot accesi (scelta di Samuele); rischio, leva, stop, REALE, PIN e wallet invariati
  13: (c) => { c.brainOn = true; c.webResearch = true; },
  // v14: Ritmo «Aggressivo» (scelta di Samuele: ingressi più veloci): giro ogni 5 s, cooldown 2 min, radar fino a 30 cripto verificate.
  // Stop, tetto 20%, perdita giornaliera, kill switch, anti-truffa, leva, REALE, PIN e wallet invariati.
  14: (c) => { applyPace(c, 'aggressivo'); },
  4: (c) => { c.scanMemes = false; const extra = (Array.isArray(c.tokens) ? c.tokens : []).filter((m) => !OLD_MEMES.includes(m) && !CORE.some((t) => t.mint === m)); c.tokens = [...CORE.map((t) => t.mint), ...extra]; if ((c.maxWatch || 0) < CORE.length + 1) c.maxWatch = CORE.length + 1; },
};
// Ripristino alla versione «Ritmo» (cfg v14): una configurazione salvata da versioni successive poi annullate (v15: TREND 4H,
// rischio per operazione, Omega in pausa, margine fino al 100%) viene riportata a com'era: campi nuovi tolti, Omega riattivato,
// ogni valore numerico entro i limiti di questa versione (margine per operazione max 20%). Wallet, PIN e storico non sono qui.
function restoreFromNewer(c) {
  if ((Number(c.cfgVersion) || 0) > CFG_VERSION) { delete c.edgeOn; delete c.riskPerTradePct; c.spotLongs = true; c.cfgVersion = CFG_VERSION; }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (k in c) { const n = Number(c[k]); c[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k]; }
  return c;
}
function migrateConfig(saved) {
  const c = restoreFromNewer({ ...(saved || {}) });
  const from = Number(c.cfgVersion) || 1;
  for (let v = from + 1; v <= CFG_VERSION; v++) if (MIGRATIONS[v]) MIGRATIONS[v](c);
  delete c.minPairAgeHours;
  c.cfgVersion = Math.max(from, CFG_VERSION);
  return { cfg: c, changed: from < CFG_VERSION, from };
}
module.exports = { DEFAULTS, LIMITS, LEVERAGES, snapLeverage, sanitize, migrateConfig, CFG_VERSION, PACE, paceOf, applyPace };
