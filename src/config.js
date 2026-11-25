'use strict';
const { CORE } = require('./tokens');
const CFG_VERSION = 2; // aumenta quando cambiano i default da applicare anche alle installazioni esistenti
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
  cooldownMin: 20,
  cycleSec: 20,
  scanMemes: true,
  tokens: CORE.map((t) => t.mint),
  minLiquidityUsd: 40000, minVolume24hUsd: 3000, minPairAgeMin: 1, minMcapUsd: 300000,
  maxPump1hPct: 35, maxDump24hPct: 40, maxRugScore: 30,
  maxWatch: 12,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  priorityFeeMaxLamports: 300000,
  simPriorityLamports: 30000,
  killConvertUsdc: true,
};
// limiti di validazione [min, max]
const LIMITS = {
  budget: [0, 1e9], feeReserveSol: [0.01, 1], maxLossPct: [1, 90], maxLossAbs: [0, 1e9], dailyLossPct: [1, 90], maxTradePct: [1, 100],
  memeSizeMult: [0, 1], maxOpen: [1, 10], slippageBps: [10, 1000], maxPriceImpactPct: [0.1, 10], slAtrMult: [0.5, 6], slMinPct: [0.5, 20],
  slMaxPct: [1, 40], rewardRisk: [0.8, 6], maxHoldMin: [5, 10080], cooldownMin: [0, 1440], cycleSec: [10, 600], minLiquidityUsd: [0, 1e9],
  minVolume24hUsd: [0, 1e10], minPairAgeMin: [0, 600000], minMcapUsd: [0, 1e12], maxPump1hPct: [1, 1000], maxDump24hPct: [1, 100],
  maxRugScore: [0, 100], maxWatch: [1, 30], priorityFeeMaxLamports: [0, 5000000], simPriorityLamports: [0, 5000000],
};
function sanitize(patch, current) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || ['mode', 'trading', 'cfgVersion'].includes(k)) continue;
    if (LIMITS[k]) { const n = Number(v); if (!Number.isFinite(n)) continue; out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], n)); }
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
};
function migrateConfig(saved) {
  const c = { ...(saved || {}) };
  const from = Number(c.cfgVersion) || 1;
  for (let v = from + 1; v <= CFG_VERSION; v++) if (MIGRATIONS[v]) MIGRATIONS[v](c);
  delete c.minPairAgeHours;
  c.cfgVersion = Math.max(from, CFG_VERSION);
  return { cfg: c, changed: from < CFG_VERSION, from };
}
module.exports = { DEFAULTS, LIMITS, sanitize, migrateConfig, CFG_VERSION };
