'use strict';
// Logica pura (testabile) di filtri, analisi, dimensionamento e rischio.
const { ema, rsi, atrPct, momentum, resample } = require('./indicators');
const { clamp } = require('./util');

const k = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// Regole di scarto applicate ai dati DexScreener di un token.
function filterRules(s, cfg) {
  const out = [];
  const meme = !s.core;
  if (s.liquidityUsd < cfg.minLiquidityUsd) out.push({ key: 'LIQ', label: `Liq < ${k(cfg.minLiquidityUsd)}` });
  if (s.volume24h < cfg.minVolume24hUsd) out.push({ key: 'VOL', label: `Vol 24h < ${k(cfg.minVolume24hUsd)}` });
  if (meme && s.ageHours != null && s.ageHours < cfg.minPairAgeHours) out.push({ key: 'AGE', label: `Età < ${cfg.minPairAgeHours}h` });
  if (meme && s.mcapUsd != null && s.mcapUsd < cfg.minMcapUsd) out.push({ key: 'MCAP', label: `MCap < ${k(cfg.minMcapUsd)}` });
  if (s.change1h != null && s.change1h > cfg.maxPump1hPct) out.push({ key: 'PUMP', label: `Pump 1h > ${cfg.maxPump1hPct}%` });
  if (s.change24h != null && s.change24h < -cfg.maxDump24hPct) out.push({ key: 'DUMP', label: `Crollo 24h > ${cfg.maxDump24hPct}%` });
  if (meme && s.buys1h + s.sells1h >= 20 && s.sells1h > s.buys1h * 1.35) out.push({ key: 'SELLS', label: 'Vendite > acquisti' });
  return out;
}

// Regole di sicurezza on-chain / rugcheck.
function safetyRules(sf, cfg, core) {
  const out = [];
  if (core) return out;
  if (!sf) return [{ key: 'DATA', label: 'Dati sicurezza assenti' }];
  if (sf.mintAuthority || sf.freezeAuthority) out.push({ key: 'AUTH', label: 'Mint/Freeze attivi' });
  if (sf.rugScore != null && sf.rugScore > cfg.maxRugScore) out.push({ key: 'RUG', label: `Rugcheck > ${cfg.maxRugScore}` });
  if (sf.danger && sf.danger.length) out.push({ key: 'RUG', label: `Rugcheck > ${cfg.maxRugScore}` });
  if (sf.holderRisk) out.push({ key: 'HOLD', label: 'Holder concentrati' });
  if (sf.token2022Ext) out.push({ key: 'T22', label: 'Token-2022 rischioso' });
  return out;
}

function analyze(c1) {
  if (!c1 || c1.length < 60) return { ok: false, reason: 'Dati insufficienti', candles: c1 ? c1.length : 0 };
  const closes = c1.map((x) => x.c);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const c5 = resample(c1, 5); const cl5 = c5.map((x) => x.c);
  const f5 = ema(cl5, 8), s5 = ema(cl5, 21);
  const r = rsi(closes, 14);
  const a = atrPct(c1, 14);
  const m5 = momentum(closes, 5), m15 = momentum(closes, 15), m60 = momentum(closes, 60);
  const last = closes[closes.length - 1];
  const L = e9.length - 1;
  const trend1 = e9[L] > e21[L] && last > e21[L];
  const slope = e21[L] > e21[Math.max(0, L - 5)];
  const trend5 = c5.length >= 10 ? f5[f5.length - 1] > s5[s5.length - 1] : trend1;
  const checks = {
    'EMA9>EMA21 (1m)': trend1,
    'EMA21 in salita': slope,
    'Trend 5m rialzista': trend5,
    'RSI 50–72': r != null && r >= 50 && r <= 72,
    'Momentum 15m > 0': m15 != null && m15 > 0,
    'Momentum 60m > -3%': m60 == null || m60 > -3,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const confidence = passed / Object.keys(checks).length;
  const signal = checks['EMA9>EMA21 (1m)'] && checks['Trend 5m rialzista'] && checks['RSI 50–72'] && checks['Momentum 15m > 0'] && passed >= 5 ? 'LONG' : 'ATTESA';
  const score = (trend1 ? 1 : 0) + (trend5 ? 1 : 0) + clamp((m15 || 0) / 2, -1, 1.5) + clamp((m60 || 0) / 5, -1, 1) - (r > 72 ? 1 : 0) + (slope ? 0.5 : 0);
  let reason = null;
  if (signal !== 'LONG') reason = r != null && r > 72 ? 'RSI ipercomprato' : 'Trend debole';
  return { ok: true, last, ema9: e9[L], ema21: e21[L], rsi: r, atrPct: a, m5, m15, m60, trend1, trend5, checks, confidence, signal, score, reason, candles: c1.length };
}

// Flusso acquisti/vendite (dati reali DexScreener) come "sentiment" on-chain.
function flowScore(s) {
  const b = s.buys1h || 0, se = s.sells1h || 0, tot = b + se;
  const ratio = tot ? (b - se) / tot : 0;
  const volAccel = s.volume6h > 0 ? (s.volume1h * 6) / s.volume6h : 1;
  const score = clamp(ratio * 1.5 + clamp(volAccel - 1, -0.5, 0.8) * 0.5, -1, 1);
  return { score, ratio, volAccel, buys: b, sells: se };
}

function riskPlan(atr, cfg, core) {
  const lo = core ? cfg.slMinPct : Math.max(cfg.slMinPct, 3);
  const hi = core ? Math.min(cfg.slMaxPct, 6) : cfg.slMaxPct;
  const slPct = clamp((atr || 1) * cfg.slAtrMult, lo, hi);
  const tpPct = slPct * cfg.rewardRisk;
  return { slPct, tpPct, trailPct: slPct * 0.7, leverage: 1 };
}

// capitale = budget + PnL realizzato, limitato dal valore effettivo
function sizePosition({ capital, cash, cfg, confidence, atr, core, minTrade }) {
  let size = capital * (cfg.maxTradePct / 100) * (0.5 + 0.5 * clamp(confidence, 0, 1));
  if (!core) size *= cfg.memeSizeMult;
  if (atr != null && atr > 2) size *= clamp(2 / atr, 0.35, 1);
  size = Math.min(size, cash);
  if (size < minTrade) return { size: 0, reason: `Importo sotto il minimo (${minTrade})` };
  return { size };
}

// Limiti globali: kill switch, perdita giornaliera, posizioni massime.
function checkLimits({ equity, startEquity, dayStartEquity, openCount, cfg }) {
  const lossAbs = startEquity - equity;
  const lossPct = startEquity > 0 ? (lossAbs / startEquity) * 100 : 0;
  if (lossPct >= cfg.maxLossPct) return { kill: true, canOpen: false, reason: `Perdita totale ${lossPct.toFixed(1)}% ≥ limite ${cfg.maxLossPct}%` };
  if (cfg.maxLossAbs > 0 && lossAbs >= cfg.maxLossAbs) return { kill: true, canOpen: false, reason: `Perdita ${lossAbs.toFixed(4)} ≥ stop assoluto ${cfg.maxLossAbs}` };
  const dayLoss = dayStartEquity > 0 ? ((dayStartEquity - equity) / dayStartEquity) * 100 : 0;
  if (dayLoss >= cfg.dailyLossPct) return { kill: false, canOpen: false, reason: `Perdita giornaliera ${dayLoss.toFixed(1)}% ≥ ${cfg.dailyLossPct}%: stop fino a domani` };
  if (openCount >= cfg.maxOpen) return { kill: false, canOpen: false, reason: `Già ${openCount} posizioni aperte (max ${cfg.maxOpen})` };
  return { kill: false, canOpen: true };
}

// Controllo uscita di una posizione al prezzo corrente (stesso valore in valuta base).
function exitCheck(pos, price, now, cfg) {
  pos.highest = Math.max(pos.highest || pos.entryPrice, price);
  const ch = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  if (price <= pos.entryPrice * (1 - pos.slPct / 100)) return { exit: true, reason: `Stop-loss (${ch.toFixed(2)}%)` };
  if (price >= pos.entryPrice * (1 + pos.tpPct / 100)) return { exit: true, reason: `Take-profit (+${ch.toFixed(2)}%)` };
  const gainHigh = ((pos.highest - pos.entryPrice) / pos.entryPrice) * 100;
  if (gainHigh >= pos.tpPct * 0.5 && price <= pos.highest * (1 - pos.trailPct / 100)) return { exit: true, reason: `Trailing stop (${ch.toFixed(2)}%)` };
  if (now - pos.openedAt >= cfg.maxHoldMin * 60000) return { exit: true, reason: `Tempo massimo (${cfg.maxHoldMin} min)` };
  return { exit: false, change: ch };
}

module.exports = { filterRules, safetyRules, analyze, flowScore, riskPlan, sizePosition, checkLimits, exitCheck };
