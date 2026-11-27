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
  if (meme && s.ageHours != null && s.ageHours * 60 < cfg.minPairAgeMin) out.push({ key: 'AGE', label: `Età < ${cfg.minPairAgeMin} min` });
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
  // memecoin con filtri allentati: avvisi RugCheck sugli holder tollerati (c'è già il tetto top holder di Jupiter), mai i 'danger'
  const holderBad = cfg.memeLoose ? (sf.holderDanger != null ? sf.holderDanger : sf.holderRisk) : sf.holderRisk;
  if (holderBad) out.push({ key: 'HOLD', label: 'Holder concentrati' });
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
  // SHORT: specchio esatto della logica LONG (ribasso, sotto le EMA, RSI 28–50, momentum negativo)
  const down1 = e9[L] < e21[L] && last < e21[L];
  const slopeDown = e21[L] < e21[Math.max(0, L - 5)];
  const down5 = c5.length >= 10 ? f5[f5.length - 1] < s5[s5.length - 1] : down1;
  const shortChecks = {
    'EMA9<EMA21 (1m)': down1,
    'EMA21 in discesa': slopeDown,
    'Trend 5m ribassista': down5,
    'RSI 28–50': r != null && r >= 28 && r <= 50,
    'Momentum 15m < 0': m15 != null && m15 < 0,
    'Momentum 60m < +3%': m60 == null || m60 < 3,
  };
  const sPassed = Object.values(shortChecks).filter(Boolean).length;
  const shortConfidence = sPassed / Object.keys(shortChecks).length;
  const shortSignal = down1 && down5 && shortChecks['RSI 28–50'] && shortChecks['Momentum 15m < 0'] && sPassed >= 5;
  const shortScore = (down1 ? 1 : 0) + (down5 ? 1 : 0) + clamp(-(m15 || 0) / 2, -1, 1.5) + clamp(-(m60 || 0) / 5, -1, 1) - (r != null && r < 28 ? 1 : 0) + (slopeDown ? 0.5 : 0);
  const shortReason = shortSignal ? null : r != null && r < 28 ? 'RSI ipervenduto' : 'Ribasso debole';
  return { ok: true, last, ema9: e9[L], ema21: e21[L], rsi: r, atrPct: a, m5, m15, m60, trend1, trend5, checks, confidence, signal, score, reason, candles: c1.length,
    short: { signal: shortSignal, score: shortScore, checks: shortChecks, confidence: shortConfidence, reason: shortReason } };
}

// Flusso acquisti/vendite (dati reali DexScreener) come "sentiment" on-chain.
function flowScore(s) {
  const b = s.buys1h || 0, se = s.sells1h || 0, tot = b + se;
  const ratio = tot ? (b - se) / tot : 0;
  const volAccel = s.volume6h > 0 ? (s.volume1h * 6) / s.volume6h : 1;
  // il volume amplifica (o smorza) lo squilibrio acquisti/vendite ma non sceglie una direzione: prima un volume in calo
  // spingeva il punteggio verso il negativo anche con flusso neutro → voti SHORT in più (bias ribassista)
  const score = clamp(ratio * 1.5 * (1 + clamp(volAccel - 1, -0.5, 0.8) * 0.5), -1, 1);
  return { score, ratio, volAccel, buys: b, sells: se };
}

function riskPlan(atr, cfg, core) {
  const lo = core ? cfg.slMinPct : Math.max(cfg.slMinPct, 3);
  const hi = core ? Math.min(cfg.slMaxPct, 6) : cfg.slMaxPct;
  const slPct = clamp((atr || 1) * cfg.slAtrMult, lo, hi);
  const tpPct = slPct * cfg.rewardRisk;
  return { slPct, tpPct, trailPct: slPct * 0.7, leverage: 1 };
}

// capitale = budget + PnL realizzato, limitato dal valore effettivo.
// Rischio per operazione: si investe esattamente maxTradePct% del capitale (× memeSizeMult per i meme),
// mai più del contante disponibile. Lo stop-loss resta calcolato sulla volatilità (riskPlan).
// DIMENSIONE: margine = capitale × maxTradePct% (predefinito 20%, regolabile fino al 100%) × frac (forza del consenso dei trader, 0–1),
// mai oltre il contante disponibile; poi esposizione massima, perdita giornaliera, kill switch e stop restano attivi.
const MAX_TRADE_PCT = 100;
const SAFE_TRADE_PCT = 20; // oltre questo valore l'interfaccia mostra l'avviso rosso
function sizePosition({ capital, cash, cfg, core, minTrade, frac = 1 }) {
  const pct = Math.min(MAX_TRADE_PCT, Math.max(0, Number(cfg.maxTradePct) || 0));
  let size = capital * (pct / 100) * Math.min(1, Math.max(0, Number(frac) || 0));
  if (!core) size *= cfg.memeSizeMult;
  size = Math.min(size, cash);
  if (size < minTrade) return { size: 0, reason: `Importo sotto il minimo (${minTrade})` };
  return { size };
}

// ESPOSIZIONE: margine × leva di tutte le posizioni aperte + la nuova ≤ capitale × maxExposurePct%
function exposureFit({ positions, equity, cfg, size, lev = 1, minTrade = 0 }) {
  const cur = (positions || []).reduce((a, p) => a + (p.costBase || 0) * (p.lev || 1), 0);
  const cap = Math.max(0, equity) * ((Number(cfg.maxExposurePct) || 0) / 100);
  if (cur + size * lev <= cap + 1e-9) return { size, exposure: cur, cap };
  const fit = (cap - cur) / Math.max(1, lev);
  if (fit < minTrade || fit <= 0) return { size: 0, exposure: cur, cap, reason: `Esposizione massima raggiunta (${Math.round(cur)} su ${Math.round(cap)}, ${cfg.maxExposurePct}% del capitale)` };
  return { size: fit, exposure: cur, cap };
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

// ---------- USCITE FURBE
// Livelli (in % dal prezzo d'ingresso) scalati sulla volatilità: R = stop-loss iniziale (ATR × moltiplicatore).
function exitLevels(pos, cfg) {
  const k = pos.core === false ? cfg.memeExitMult : 1;
  const R = pos.slPct;
  const dist = pos.atrPct != null && pos.atrPct > 0 ? pos.atrPct * cfg.trailAtrMult * k : R * 0.7 * k;
  const m = pos.tpMult && pos.tpMult > 1 ? Math.min(1.4, pos.tpMult) : 1; // correzione del MENTORE (solo target più lontani, max ×1,4)
  return { R, tp1: R * cfg.tp1R * k * m, tp2: R * cfg.tp2R * k * m, trailAct: R * cfg.trailActR * k * m, trailDist: Math.min(R, Math.max(0.3, dist)) };
}
// Decide cosa fare con una posizione. Aggiorna sulla posizione: highest, trailStop.
// Ritorna { action: 'none'|'partial'|'close', frac (quota della quantità ATTUALE), stage, reason, events[], change }.
// SHORT: le stesse regole lavorano su un prezzo "specchiato" attorno all'entrata (2·entrata − prezzo),
// così un calo del prezzo è un guadagno. highest/trailStop/beStop di uno short sono salvati in questo spazio.
const mirror = (pos, x) => (x == null ? x : 2 * pos.entryPrice - x);
function exitPlan(pos, price, now, cfg, ctx = {}) {
  if (pos.side !== 'SHORT') return exitPlanCore(pos, price, now, cfg, ctx);
  const mctx = { ...ctx, m5: ctx.m5 != null ? -ctx.m5 : null, ema9: mirror(pos, ctx.ema9), flow: null };
  const r = exitPlanCore(pos, mirror(pos, price), now, cfg, mctx);
  for (const e of r.events || []) if (e.type === 'trail') { e.from = mirror(pos, e.from); e.to = mirror(pos, e.to); }
  if (r.reason) r.reason = r.reason.replace('Inversione rapida', 'Rimbalzo rapido').replace(/\((-?[\d.]+)% in 5 min\)/, (_, v) => `(+${Math.abs(+v).toFixed(2)}% in 5 min)`);
  return r;
}
// prezzo reale dello stop effettivo (long: sotto; short: sopra l'entrata)
function effectiveStop(pos) {
  const m = Math.max(pos.entryPrice * (1 - pos.slPct / 100), pos.beStop || 0, pos.trailStop || 0);
  return pos.side === 'SHORT' ? mirror(pos, m) : m;
}
// stop-loss di uno short sempre ben prima della liquidazione: al massimo il 40% della distanza
function shortStopCap(slPct, entry, liqPrice) {
  const liqDist = (Math.abs(liqPrice - entry) / entry) * 100; // vale per short (sopra) e long con leva (sotto)
  return Math.max(0.5, Math.min(slPct, liqDist * 0.4));
}
function exitPlanCore(pos, price, now, cfg, ctx = {}) {
  if (pos.edge) return require('./edge').exitEdge(pos, price, now); // posizioni TREND 4H: solo stop, trailing dopo +1R, tempo massimo
  if (!cfg.smartExits) { const r = exitCheck(pos, price, now, cfg); return { action: r.exit ? 'close' : 'none', reason: r.reason, change: r.change, events: [] }; }
  const events = [];
  pos.highest = Math.max(pos.highest || pos.entryPrice, price);
  const ch = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const gainHigh = ((pos.highest - pos.entryPrice) / pos.entryPrice) * 100;
  const L = exitLevels(pos, cfg);
  const fmt = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  // trailing: si attiva dopo +trailAct, segue il massimo, non scende mai e non è mai più largo dello stop iniziale
  if (cfg.trailOn && gainHigh >= L.trailAct) {
    const ts = pos.highest * (1 - L.trailDist / 100);
    if (!pos.trailStop || ts > pos.trailStop) { events.push({ type: 'trail', from: pos.trailStop || null, to: ts, pctFromEntry: ((ts - pos.entryPrice) / pos.entryPrice) * 100 }); pos.trailStop = ts; }
  }
  const sl = pos.entryPrice * (1 - pos.slPct / 100);
  const stop = Math.max(sl, pos.beStop || 0, pos.trailStop || 0);
  if (price <= stop) {
    const kind = stop === pos.trailStop ? 'Trailing stop' : stop === pos.beStop ? 'Stop a pareggio' : 'Stop-loss';
    return { action: 'close', reason: `${kind} (${fmt(ch)})`, change: ch, events };
  }
  // prese di profitto parziali
  const initQty = pos.initQty || pos.qty;
  if (cfg.partialTp) {
    // pos.runner (vecchie posizioni del derby): si incassa solo metà della prima presa e niente seconda: il resto corre col trailing stop
    if (!pos.tp1Done && ch >= L.tp1) return { action: 'partial', stage: 1, frac: Math.min(1, (cfg.tp1Pct / 100) * (pos.runner ? 0.5 : 1)), reason: `Presa parziale 1 (${fmt(ch)})`, change: ch, events };
    if (!pos.runner && pos.tp1Done && !pos.tp2Done && cfg.tp2Pct > 0 && ch >= Math.max(L.tp2, L.tp1)) {
      const rem = initQty > 0 ? pos.qty / initQty : 1;
      return { action: 'partial', stage: 2, frac: Math.min(1, (cfg.tp2Pct / 100) / Math.max(rem, 1e-9)), reason: `Presa parziale 2 (${fmt(ch)})`, change: ch, events };
    }
  }
  // senza trailing: chiude il resto al target classico (o oltre la seconda presa)
  if (!cfg.trailOn) {
    const tpFinal = cfg.partialTp ? Math.max(pos.tpPct, L.tp2 * 1.5) : pos.tpPct;
    if (ch >= tpFinal) return { action: 'close', reason: `Take-profit (${fmt(ch)})`, change: ch, events };
  }
  const held = now - pos.openedAt;
  // uscita rapida: crollo del momentum a 5 minuti sotto la EMA9, oppure vendite dominanti sui meme
  if (cfg.reversalExit && held >= 3 * 60000) {
    const thr = Math.max(cfg.reversalPct, (pos.atrPct || 0) * 2);
    if (ctx.m5 != null && ctx.m5 <= -thr && (ctx.ema9 == null || price < ctx.ema9)) return { action: 'close', reason: `Inversione rapida (${ctx.m5.toFixed(2)}% in 5 min)`, change: ch, events };
    if (pos.core === false && ctx.flow && ctx.flow.tot >= 40 && ctx.flow.ratio <= -0.5) return { action: 'close', reason: `Ondata di vendite (${Math.round(((1 - ctx.flow.ratio) / 2) * 100)}% vendite)`, change: ch, events };
  }
  if (cfg.timeStopOn && !pos.tp1Done && held >= cfg.timeStopMin * 60000 && ch < cfg.timeStopMinGainPct) return { action: 'close', reason: `Ferma da ${cfg.timeStopMin} min (${fmt(ch)})`, change: ch, events };
  if (held >= cfg.maxHoldMin * 60000) return { action: 'close', reason: `Tempo massimo (${cfg.maxHoldMin} min)`, change: ch, events };
  return { action: 'none', change: ch, events, levels: L };
}

// Segnale "contropiede" (mean reversion su candele 1m), usato dai bot di contropiede:
// LONG dopo un eccesso di vendite (RSI ≤ 30, chiusura sotto la banda di Bollinger bassa) con candela di inversione;
// SHORT specchiato. Stesse regole di rischio di tutti gli altri ingressi.
function reversion(c1) {
  if (!c1 || c1.length < 60) return { ok: false, LONG: { signal: false, conf: 0, score: -9, reason: 'Dati insufficienti', checks: {} }, SHORT: { signal: false, conf: 0, score: -9, reason: 'Dati insufficienti', checks: {} } };
  const closes = c1.map((x) => x.c); const n = 20; const w = closes.slice(-n);
  const m = w.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  const r = rsi(closes, 14); const last = closes[closes.length - 1], prev = closes[closes.length - 2], prev2 = closes[closes.length - 3];
  const lo = m - 2 * sd, hi = m + 2 * sd; const m60 = momentum(closes, 60);
  const minLow = Math.min(...c1.slice(-3).map((x) => x.l)), maxHigh = Math.max(...c1.slice(-3).map((x) => x.h));
  const mk = (dir) => {
    const checks = dir > 0
      ? { 'RSI ≤ 32': r != null && r <= 32, 'Eccesso sotto la banda bassa': minLow < lo, 'Candela di inversione': last > prev && prev <= prev2, 'Niente crollo > 6% in 1h': m60 == null || m60 > -6 }
      : { 'RSI ≥ 68': r != null && r >= 68, 'Eccesso sopra la banda alta': maxHigh > hi, 'Candela di inversione': last < prev && prev >= prev2, 'Niente razzo > 6% in 1h': m60 == null || m60 < 6 };
    const passed = Object.values(checks).filter(Boolean).length; const conf = passed / 4;
    const signal = passed === 4;
    const stretch = sd > 0 ? (dir > 0 ? (m - last) / sd : (last - m) / sd) : 0;
    const score = clamp(stretch, -2, 3) + (r == null ? 0 : dir > 0 ? clamp((50 - r) / 10, -2, 2) : clamp((r - 50) / 10, -2, 2));
    return { signal, conf, score, checks, rsi: r, reason: signal ? null : dir > 0 ? 'Nessun eccesso di vendite' : 'Nessun eccesso di acquisti' };
  };
  return { ok: true, LONG: mk(1), SHORT: mk(-1), rsi: r, mid: m, lo, hi };
}

module.exports = { MAX_TRADE_PCT, SAFE_TRADE_PCT, exposureFit, reversion, effectiveStop, shortStopCap, exitLevels, exitPlan, filterRules, safetyRules, analyze, flowScore, riskPlan, sizePosition, checkLimits, exitCheck };
