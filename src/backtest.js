'use strict';
// Backtest realistico delle strategie sui perps (stesse regole del bot):
// margine = maxTradePct% del capitale, leva dell'utente (5x/10x), stop calcolato sulla volatilità ma sempre entro il 40%
// della distanza di liquidazione, presa parziale a 1R con stop a pareggio, trailing, tempo massimo;
// commissioni Jupiter 0,06% + 0,06% sull'esposizione, prestito orario, slittamento. Ingresso all'apertura della candela successiva.
const P = require('./perps');
const ST = require('./strategies');

const DEF = { slippageBps: 3, atrMult: 1.5, prior: 20 };

function riskFor(atrPct, cfg, lev) {
  const liqDist = P.liqDistancePct(lev);
  const hi = Math.min(cfg.slMaxPct, 6, liqDist * 0.4);
  const slPct = Math.max(Math.min(cfg.slMinPct, hi), Math.min(hi, (atrPct || 1) * DEF.atrMult));
  return { slPct, liqDist };
}
// costo totale di un'operazione in % del margine: apertura + chiusura + slittamento (×2) + prestito
function feePctOnMargin(lev, hours, fees = P.FEES, slipBps = DEF.slippageBps) {
  return lev * ((fees.openBps + fees.closeBps + 2 * slipBps) / 100 + fees.borrowHourlyPct * hours);
}

// Simula una strategia; ritorna l'elenco delle operazioni { i, j, dir, r (rendimento netto sul margine, frazione), regime }
function simulate(x, sig, { cfg, lev, tfMin, from = 0, to = x.n, regimes = null }) {
  const trades = []; const atr = x.atr(14); const fees = P.FEES;
  const k = cfg.smartExits !== false; const maxBars = Math.max(1, Math.round(cfg.maxHoldMin / tfMin));
  let i = Math.max(from, 2);
  while (i < to - 1) {
    const d = sig[i];
    if (!d || atr[i] == null) { i++; continue; }
    const e = x.k[i + 1].o; // ingresso all'apertura della candela successiva (lo slittamento è conteggiato nei costi)
    const { slPct } = riskFor((atr[i] / x.c[i]) * 100, cfg, lev);
    const R = slPct / 100; let stop = e * (1 - d * R); let best = e; let tp1Done = false; let rem = 1; let gross = 0; let exitJ = null;
    const tp1 = e * (1 + d * R * cfg.tp1R);
    const trailAct = R * cfg.trailActR; const trailDist = Math.max(0.002, Math.min(R, (atr[i] / x.c[i]) * cfg.trailAtrMult));
    for (let j = i + 1; j < x.n; j++) {
      const b = x.k[j];
      // 1) stop (con gap: se l'apertura è già oltre lo stop si esce all'apertura)
      const hitStop = d > 0 ? b.l <= stop : b.h >= stop;
      if (hitStop) { const px = d > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o); gross += rem * d * (px - e) / e; rem = 0; exitJ = j; break; }
      // 2) presa parziale a 1R e stop a pareggio (+ buffer commissioni)
      if (k && cfg.partialTp && !tp1Done && (d > 0 ? b.h >= tp1 : b.l <= tp1)) {
        const f = cfg.tp1Pct / 100; gross += f * d * (tp1 - e) / e; rem -= f; tp1Done = true;
        const be = e * (1 + (d * cfg.beBufferPct) / 100); stop = d > 0 ? Math.max(stop, be) : Math.min(stop, be);
      }
      // 3) trailing dal miglior prezzo
      best = d > 0 ? Math.max(best, b.h) : Math.min(best, b.l);
      if (k && cfg.trailOn && d * (best - e) / e >= trailAct) { const ts = best * (1 - d * trailDist); stop = d > 0 ? Math.max(stop, ts) : Math.min(stop, ts); }
      // 4) senza trailing: target classico
      if ((!k || !cfg.trailOn) && d * (b.c - e) / e >= R * cfg.rewardRisk) { gross += rem * d * (b.c - e) / e; rem = 0; exitJ = j; break; }
      // 5) tempo massimo
      if (j - i >= maxBars) { gross += rem * d * (b.c - e) / e; rem = 0; exitJ = j; break; }
    }
    if (exitJ == null) break; // operazione ancora aperta a fine dati: non contata
    const hours = ((exitJ - i) * tfMin) / 60;
    let r = lev * gross - feePctOnMargin(lev, hours, fees) / 100;
    r = Math.max(-1, r); // al massimo si perde il margine (lo stop entro il 40% della liquidazione lo evita)
    trades.push({ i, j: exitJ, t: x.k[i].t, dir: d, r, regime: regimes ? regimes[i] : null });
    i = exitJ + 1;
  }
  return trades;
}

// Statistiche: rendimenti per operazione sul margine; il capitale cresce di (margine% × r) per operazione
function stats(trades, { marginPct = 7, prior = DEF.prior, spanDays = null } = {}) {
  const n = trades.length; const rs = trades.map((t) => t.r);
  const mean = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  let eq = 1, peak = 1, dd = 0; for (const r of rs) { eq *= 1 + (marginPct / 100) * r; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  const wins = rs.filter((r) => r > 0); const gw = wins.reduce((a, b) => a + b, 0); const gl = -rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0);
  const perYear = spanDays ? (n / spanDays) * 365 : n;
  return { n, winRate: n ? (wins.length / n) * 100 : 0, expPct: mean * 100, shrunkPct: (mean * 100 * n) / (n + prior), sd: sd * 100,
    tstat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(Math.max(1, perYear)) : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, retPct: (eq - 1) * 100, ddPct: dd * 100 };
}
// criteri per attivare una strategia (fuori campione)
const RULES = { minTrades: 8, minT: 1.0, minPf: 1.1, maxDd: 25 };
const passes = (s) => s.n >= RULES.minTrades && s.shrunkPct > 0 && s.tstat >= RULES.minT && s.pf >= RULES.minPf && s.ddPct <= RULES.maxDd;

// Walk-forward ancorato: 3 finestre di test consecutive (40–60%, 60–80%, 80–100%); per ognuna i parametri
// sono scelti SOLO sui dati precedenti (train), poi valutati sul periodo successivo mai visto.
function walkForward(strategy, x, { cfg, lev, tfMin }) {
  const N = x.n; const regimes = Array.from({ length: N }, (_, i) => ST.regimeAt(x, i));
  const sigs = strategy.grid.map((p) => ST.signals(strategy, x, p));
  const oos = []; const chosen = []; const isScores = [];
  for (const [a, b] of [[0.4, 0.6], [0.6, 0.8], [0.8, 1]]) {
    const trEnd = Math.floor(N * a), teEnd = Math.floor(N * b);
    let bi = 0, bs = -Infinity;
    sigs.forEach((sg, gi) => { const st = stats(simulate(x, sg, { cfg, lev, tfMin, from: 0, to: trEnd, regimes })); const sc = st.n >= 3 ? st.shrunkPct : -Infinity; if (sc > bs) { bs = sc; bi = gi; } });
    chosen.push(bi); isScores.push(Number.isFinite(bs) ? bs : -99);
    oos.push(...simulate(x, sigs[bi], { cfg, lev, tfMin, from: trEnd, to: teEnd, regimes }));
  }
  const spanDays = ((x.k[N - 1].t - x.k[Math.floor(N * 0.4)].t) / 864e5) || 1;
  const all = stats(oos, { marginPct: cfg.maxTradePct, spanDays });
  const byRegime = {};
  for (const rg of ['rialzo', 'ribasso', 'laterale']) { const tt = oos.filter((t) => t.regime === rg); byRegime[rg] = stats(tt, { marginPct: cfg.maxTradePct }); }
  const last = chosen[chosen.length - 1];
  return { oos: all, isScore: isScores.reduce((a, b) => a + b, 0) / isScores.length, byRegime, params: strategy.grid[last], paramIdx: last, longs: oos.filter((t) => t.dir > 0).length, shorts: oos.filter((t) => t.dir < 0).length, spanDays, bars: N };
}
module.exports = { simulate, stats, walkForward, riskFor, feePctOnMargin, passes, RULES, DEF };
