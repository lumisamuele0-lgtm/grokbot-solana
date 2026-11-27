'use strict';
// Backtest della SALA (Alpha sui perps SOL/BTC/ETH) su candele 1m reali di Binance, con la logica vera del bot:
// analisti (src/desk.js), consenso pesato di Alpha, piano di rischio (src/strategy.js riskPlan + stop entro la liquidazione),
// uscite furbe (S.exitPlan: stop, prese parziali, pareggio, trailing, inversione rapida, stop a tempo), commissioni Jupiter
// (0,06% + 0,06% sull'esposizione), slittamento, prestito orario. Ingresso all'apertura della candela successiva.
// Uso: node tools/deskbt.js [baseline|edge] [dataDir] [1m|15m]   (dati: node tools/fetch-klines.js <dir> 730 15m)
// Prima parte dei dati (2/3) = in campione (scelta dei parametri), ultimo terzo = fuori campione (verifica). TREND 4H: policy «edge».
const fs = require('fs'); const path = require('path');
const D = require('../src/desk'); const S = require('../src/strategy'); const P = require('../src/perps'); const C = require('../src/config');
const { ema, momentum, atrPct } = require('../src/indicators');
const E = require('../src/edge');

const SLIP_BPS = 3; const WIN = 240;
function load(dir, tf = '1m') {
  const out = {};
  for (const [sym, f] of [['BTC', 'BTCUSDT'], ['SOL', 'SOLUSDT'], ['ETH', 'ETHUSDT']]) out[sym] = JSON.parse(fs.readFileSync(path.join(dir, f + (tf === '1m' ? '' : '_' + tf) + '.json'), 'utf8')).map((x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] }));
  const n = Math.min(...Object.values(out).map((a) => a.length)); for (const k of Object.keys(out)) out[k] = out[k].slice(-n); return out;
}
const pct = (a, b) => (a && b ? ((a - b) / b) * 100 : null);

// voti degli analisti come nel bot (senza dati che non esistono nello storico: flusso DexScreener, notizie, funding OKX)
function ctxAt(K, sym, i, btc) {
  const c1 = K[sym].slice(i - WIN + 1, i + 1); const last = c1[c1.length - 1].c;
  const at = (m) => K[sym][i - m] && K[sym][i - m].c;
  const btc60 = btc && i >= 60 ? momentum(K.BTC.slice(i - 60, i + 1).map((x) => x.c), 60) : null;
  return { coin: { perp: true, meme: false, symbol: sym, market: sym }, perp: true, symbol: sym, mint: sym, c1, a: S.analyze(c1), rev: S.reversion(c1), st: {},
    f: { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 }, ch1: pct(last, at(60)), ch5: pct(last, at(5)), ch6: pct(last, at(360)), liq: 5e7, mc: {}, news: null,
    macro: { btc60, mcap24: null, fng: null }, rs: null };
}
const ALPHA = D.EXECUTORS.find((x) => x.id === 'alpha');
function consensus(votes, side) {
  const want = side === 'SHORT' ? -1 : 1; let pro = 0, con = 0, voted = 0, abst = 0; const yes = [], no = [];
  for (const v of votes) { const w = ALPHA.boost[v.id] || 1; if (!v.dir) { abst += w; continue; } voted += w; if (v.dir === want) { pro += w * v.conf; yes.push(v.id); } else { con += w * v.conf; no.push(v.id); } }
  const den = voted + 0.3 * abst; return { score: den > 0 ? (pro - con) / den : 0, yes, no };
}
function votesOf(ctx) { const out = []; for (const A of D.ANALYSTS) { if (A.spotOnly) continue; let v; try { v = A.fn(ctx); } catch { v = { dir: 0, conf: 0 }; } out.push({ id: A.id, dir: v.dir, conf: v.dir ? v.conf : 0 }); } return out; }

// POLITICHE: baseline = bot attuale (Ritmo Normale); edge = nuova logica (src/edge.js)
const POLICIES = {
  baseline: { cfg: { ...C.DEFAULTS }, lev: 5, decide(K, sym, i, st) {
    const ctx = ctxAt(K, sym, i, true); if (!ctx.a.ok) return null; const votes = votesOf(ctx); let best = null;
    for (const side of ['LONG', 'SHORT']) { const cs = consensus(votes, side); if (cs.score >= 0.22 && cs.yes.length >= 2 && cs.yes.length > cs.no.length && (!best || cs.score > best.cs.score)) best = { side, cs }; }
    if (!best) return null; const plan = S.riskPlan(ctx.a.atrPct, this.cfg, true);
    return { side: best.side, frac: Math.min(1, Math.max(0.4, 0.4 + best.cs.score)), slPct: plan.slPct, tpPct: plan.tpPct, atrPct: ctx.a.atrPct, cfg: this.cfg }; } },
  // TREND 4H (src/edge.js): stesso segnale e stesse uscite del bot; ingresso al minuto dopo la chiusura della candela a 4h
  edge: { cfg: { ...C.DEFAULTS, edgeOn: true }, lev: 5, decide(K, sym, i, st) {
    st.x4 = st.x4 || {}; if (!st.x4[sym]) { const X = E.prep(E.to4h(K[sym])); X.byClose = new Map(X.B.map((b, j) => [b.t + E.H4, j])); st.x4[sym] = X; }
    const X = st.x4[sym]; const step = K[sym][1].t - K[sym][0].t; const j = X.byClose.get(K[sym][i].t + step); if (j == null) return null;
    const sg = E.signalAt(X, j, this.lev, P.liqDistancePct(this.lev)); if (!sg || !E.fresh(sg, K[sym][i].c, K[sym][i].t + step)) return null;
    return { side: sg.side, frac: E.riskFrac(this.cfg, sg.slPct, this.lev), slPct: sg.slPct, tpPct: sg.slPct * 2, atrPct: sg.atrPct, edge: { trailPct: sg.trailPct, atrPct: sg.atrPct, barT: sg.barT }, cfg: this.cfg }; } },
};

function run(K, policy, { from, to, capital = 100, marginPct = 20 }) {
  const cfg = policy.cfg; const lev = policy.lev; const syms = Object.keys(K);
  let eq = capital, peak = capital, maxDD = 0; const trades = []; const pos = {}; const cd = {}; const st = { hist: [], lastLoss: {}, perHour: [] };
  for (let i = Math.max(from, WIN + 360); i < to - 1; i++) {
    for (const sym of syms) {
      const k = K[sym];
      const p = pos[sym];
      if (p) {
        const b = k[i]; const now = b.t + (k[1].t - k[0].t); const cl = k.slice(i - 59, i + 1).map((x) => x.c); const e9 = ema(cl, 9);
        const ctx = { m5: momentum(cl, 5), ema9: e9[e9.length - 1] };
        // dentro la candela: prima il lato avverso (stop), poi quello favorevole, poi la chiusura
        const seq = p.side === 'LONG' ? [b.l, b.h, b.c] : [b.h, b.l, b.c];
        for (const px of seq) {
          const r = S.exitPlan(p, px, px === b.c ? now : now - 30e3, cfg, px === b.c ? ctx : {});
          if (r.action === 'partial') { const f = r.frac; p.realized += p.qty * f * gross(p, px); p.qty *= 1 - f; if (r.stage === 1) { p.tp1Done = true; p.beStop = Math.max(p.beStop || 0, p.entryPrice * (1 + cfg.beBufferPct / 100)); } if (r.stage === 2) p.tp2Done = true; }
          if (r.action === 'close') { const exitPx = px; const g = p.realized + p.qty * gross(p, exitPx); const hours = (now - p.openedAt) / 3.6e6;
            const fee = lev * ((P.FEES.openBps + P.FEES.closeBps + 2 * SLIP_BPS) / 1e4 + (P.FEES.borrowHourlyPct / 100) * hours);
            const rM = Math.max(-1, lev * g - fee); const pnl = p.margin * rM; eq += pnl;
            trades.push({ sym, side: p.side, t: p.openedAt, hold: (now - p.openedAt) / 60e3, rM, pnl, feeM: fee, reason: r.reason.split(' (')[0], is: p.is });
            if (pnl < 0) st.lastLoss[sym] = now; cd[sym] = now + cfg.cooldownMin * 60e3; delete pos[sym];
            peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); break; }
        }
        continue;
      }
      if (cd[sym] && cd[sym] > k[i].t) continue;
      const d = policy.decide(K, sym, i, st); if (!d) continue;
      const entry = k[i + 1].o; const liq = P.liqDistancePct(lev);
      const slPct = Math.max(0.5, Math.min(d.slPct, liq * 0.4, 6));
      const margin = eq * (marginPct / 100) * d.frac;
      pos[sym] = { side: d.side, entryPrice: entry, slPct, tpPct: d.tpPct, atrPct: d.atrPct, core: true, openedAt: k[i + 1].t, qty: 1, initQty: 1, realized: 0, margin, tpMult: 1, edge: d.edge || null };
      st.perHour.push(k[i].t);
    }
  }
  return { trades, eq, ret: (eq / capital - 1) * 100, maxDD: maxDD * 100 };
}
function gross(p, px) { const d = p.side === 'SHORT' ? -1 : 1; return (d * (px - p.entryPrice)) / p.entryPrice; }
function stats(r) {
  const T = r.trades; const w = T.filter((t) => t.rM > 0); const gw = w.reduce((a, t) => a + t.pnl, 0); const gl = -T.filter((t) => t.rM <= 0).reduce((a, t) => a + t.pnl, 0);
  const by = (f) => { const g = {}; for (const t of T) { const k = f(t); (g[k] = g[k] || { n: 0, pnl: 0, w: 0 }); g[k].n++; g[k].pnl += t.pnl; if (t.rM > 0) g[k].w++; } for (const v of Object.values(g)) v.pnl = +v.pnl.toFixed(2); return g; };
  return { trades: T.length, winRate: T.length ? +((w.length / T.length) * 100).toFixed(1) : null, profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : gw > 0 ? Infinity : null,
    expectancyPctMargin: T.length ? +((T.reduce((a, t) => a + t.rM, 0) / T.length) * 100).toFixed(2) : null, feesPctMargin: T.length ? +((T.reduce((a, t) => a + t.feeM, 0) / T.length) * 100).toFixed(2) : null,
    returnPct: +r.ret.toFixed(2), maxDDPct: +r.maxDD.toFixed(2), avgHoldMin: T.length ? +(T.reduce((a, t) => a + t.hold, 0) / T.length).toFixed(0) : null, side: by((t) => t.side), reason: by((t) => t.reason) };
}
module.exports = { load, run, stats, POLICIES, ctxAt, votesOf, consensus };
if (require.main === module) {
  const pol = process.argv[2] || 'baseline'; const dir = process.argv[3] || '/workspace/sb-data'; const tf = process.argv[4] || '1m';
  const K = load(dir, tf); const n = K.BTC.length; const split = Math.floor(n * 2 / 3);
  const t0 = Date.now();
  const is = stats(run(K, POLICIES[pol], { from: 0, to: split })); const oos = stats(run(K, POLICIES[pol], { from: split - 600, to: n }));
  console.log(JSON.stringify({ policy: pol, tf, days: +((K.BTC[n - 1].t - K.BTC[0].t) / 864e5).toFixed(1), splitAt: new Date(K.BTC[split].t).toISOString().slice(0, 10), inSample: is, outOfSample: oos, sec: (Date.now() - t0) / 1000 }, null, 1));
}
