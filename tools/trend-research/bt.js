'use strict';
// Ricerca trend su 15m/1h: segnali su TF, uscite simulate su barre 15m (high/low), costi inclusi.
const fs = require('fs');
const M15 = 9e5, H1 = 36e5, H4 = 4 * H1;
const PERPS = ['SOL', 'BTC', 'ETH'];
const COST = { perp: { side: 9e-4 * 0 + 0.0009, borrowH: 0.00002 }, spot: { side: +(process.env.SPOTSIDE || 0.002), borrowH: 0 } }; // perps: 6 bps fee + 3 bps slip per lato; spot: 20 bps per lato
function load(sym) { const r = JSON.parse(fs.readFileSync(require('path').join(process.env.DATA || './bt-data', `${sym}USDT_15m.json`), 'utf8')); return r.map((x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] })); }
function agg(K, ms) { const out = []; let cur = null; const need = ms / M15;
  for (const k of K) { const t0 = Math.floor(k.t / ms) * ms; if (!cur || cur.t !== t0) { if (cur && cur.n === need) out.push(cur); cur = { t: t0, o: k.o, h: k.h, l: k.l, c: k.c, n: 1 }; } else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.n++; } }
  if (cur && cur.n === need) out.push(cur); return out; }
function ema(v, n) { const k = 2 / (n + 1); const o = new Float64Array(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; } return o; }
function atr(B, n) { const o = new Float64Array(B.length).fill(NaN); let a = null; for (let i = 1; i < B.length; i++) { const tr = Math.max(B[i].h - B[i].l, Math.abs(B[i].h - B[i - 1].c), Math.abs(B[i].l - B[i - 1].c)); a = a == null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
function hhll(B, n) { const hh = new Float64Array(B.length).fill(NaN), ll = new Float64Array(B.length).fill(NaN); for (let i = n; i < B.length; i++) { let h = -Infinity, l = Infinity; for (let j = i - n; j < i; j++) { if (B[j].h > h) h = B[j].h; if (B[j].l < l) l = B[j].l; } hh[i] = h; ll[i] = l; } return { hh, ll }; }

const cache = {};
function prepCoin(sym) {
  if (cache[sym]) return cache[sym];
  const K = load(sym); const tfs = { '15m': K, '1h': agg(K, H1), '4h': agg(K, H4), '2h': agg(K, 2 * H1) }; const B4 = agg(K, H4); const e4 = ema(B4.map((x) => x.c), 50);
  const idx15 = new Map(); K.forEach((k, i) => idx15.set(k.t, i));
  const P = { sym, K, idx15, tfs, B4, e4, ind: {} };
  for (const [tf, B] of Object.entries(tfs)) { const c = B.map((x) => x.c); P.ind[tf] = { c, atr: atr(B, 14), e: {}, d: {} }; for (const n of [10, 20, 30, 50, 100, 200]) P.ind[tf].e[n] = ema(c, n); for (const n of [20, 55, 100]) P.ind[tf].d[n] = hhll(B, n); }
  return (cache[sym] = P);
}
// trend 4h all'istante T (ultima candela 4h chiusa)
function htf(P, T) { let lo = 0, hi = P.B4.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (P.B4[m].t + H4 <= T) { r = m; lo = m + 1; } else hi = m - 1; } return r < 50 ? 0 : P.B4[r].c > P.e4[r] ? 1 : -1; }
// segnali: [{i, T, dir, atr, px}]
function signals(P, tf, E) {
  const B = P.tfs[tf]; const I = P.ind[tf]; const ms = tf === '4h' ? H4 : tf === '2h' ? 2 * H1 : tf === '1h' ? H1 : M15; const out = [];
  for (let i = 210; i < B.length; i++) {
    let dir = 0;
    if (E.fam === 'cross') { const f = I.e[E.f], s = I.e[E.s]; if (f[i] > s[i] && f[i - 1] <= s[i - 1]) dir = 1; else if (f[i] < s[i] && f[i - 1] >= s[i - 1]) dir = -1; }
    else { const d = I.d[E.n]; if (I.c[i] > d.hh[i] && I.c[i - 1] <= d.hh[i - 1]) dir = 1; else if (I.c[i] < d.ll[i] && I.c[i - 1] >= d.ll[i - 1]) dir = -1; }
    if (!dir || !Number.isFinite(I.atr[i])) continue;
    const T = B[i].t + ms;
    if (E.filt === 'htf' && htf(P, T) !== dir) continue;
    if (E.filt === 'e200' && Math.sign(I.c[i] - I.e[200][i]) !== dir) continue;
    out.push({ T, dir, atr: I.atr[i], px: I.c[i] });
  }
  return out;
}
// simulazione delle operazioni su barre 15m; una posizione per volta per moneta
function trades(P, sigs, X, kind, longOnly) {
  const K = P.K; const out = []; let busyUntil = 0; const c = COST[kind];
  for (const sg of sigs) {
    if (longOnly && sg.dir < 0) continue; if (sg.T < busyUntil) continue;
    const j0 = P.idx15.get(sg.T); if (j0 == null) continue;
    const d = sg.dir; const entry = K[j0].o; const A = sg.atr; const R = X.sl * A; let stop = entry - d * R; let best = entry; let exit = null, jx = j0;
    const maxJ = Math.min(K.length - 1, j0 + X.hold);
    for (let j = j0; j <= maxJ; j++) { const k = K[j];
      if (d > 0 ? k.l <= stop : k.h >= stop) { exit = d > 0 ? Math.min(k.o, stop) : Math.max(k.o, stop); jx = j; break; }
      best = d > 0 ? Math.max(best, k.h) : Math.min(best, k.l);
      if ((best - entry) * d >= X.act * R) { const tr = best - d * X.tr * A; if (d > 0 ? tr > stop : tr < stop) stop = tr; }
      jx = j; }
    if (exit == null) exit = K[jx].c;
    const hours = (K[jx].t + M15 - sg.T) / H1; const slPct = R / entry;
    const ret = d * (exit / entry - 1) - 2 * c.side - c.borrowH * hours; // per unità di nozionale
    out.push({ sym: P.sym, kind, T: sg.T, X: K[jx].t + M15, dir: d, ret, r: ret / slPct, slPct });
    busyUntil = K[jx].t + M15;
  }
  return out;
}
// portafoglio: rischio fisso per operazione, margine ≤ 20% capitale (perps 5x, spot 1x), somma margini ≤ capitale
function portfolio(T, risk = 0.01, from = -Infinity, to = Infinity) {
  const tr = T.filter((x) => x.T >= from && x.T < to).sort((a, b) => a.T - b.T);
  let eq = 1, peak = 1, dd = 0; const open = []; const done = [];
  for (const t of tr) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].X <= t.T) { eq += open[k].pnl; open.splice(k, 1); }
    if (open.some((o) => o.sym === t.sym)) continue;
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    const lev = t.kind === 'perp' ? 5 : 1; let notional = Math.min(risk / t.slPct, 0.2 * eq * lev / eq) * eq; // nozionale
    const margin = notional / lev; const used = open.reduce((a, o) => a + o.margin, 0); if (used + margin > eq) continue;
    const pnl = notional * t.ret; open.push({ sym: t.sym, X: t.X, pnl, margin }); done.push({ ...t, pnl, eqBefore: eq });
  }
  for (const o of open.sort((a, b) => a.X - b.X)) { eq += o.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  // drawdown sulla sequenza di chiusure
  let e2 = 1, p2 = 1, dd2 = 0; for (const t of [...done].sort((a, b) => a.X - b.X)) { e2 += t.pnl; p2 = Math.max(p2, e2); dd2 = Math.max(dd2, 1 - e2 / p2); }
  const gw = done.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), gl = -done.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  const months = (Math.min(to, Date.now()) - Math.max(from, tr.length ? tr[0].T : 0)) / (30.44 * 864e5);
  return { n: done.length, perMonth: months > 0 ? done.length / months : null, win: done.length ? done.filter((x) => x.pnl > 0).length / done.length : 0, pf: gl ? gw / gl : gw ? 99 : 0, ret: eq - 1, dd: Math.max(dd, dd2), done };
}
function rstats(T) { const gw = T.filter((x) => x.r > 0).reduce((a, x) => a + x.r, 0), gl = -T.filter((x) => x.r <= 0).reduce((a, x) => a + x.r, 0); return { n: T.length, pf: gl ? gw / gl : 0, expR: T.length ? T.reduce((a, x) => a + x.r, 0) / T.length : 0, win: T.length ? T.filter((x) => x.r > 0).length / T.length : 0 }; }
module.exports = { load, agg, prepCoin, signals, trades, portfolio, rstats, PERPS, M15, H1, H4 };
