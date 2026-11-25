'use strict';
// Libreria di strategie documentate (letteratura e pratica di trading), come funzioni di segnale LONG/SHORT.
// Ogni strategia riceve il contesto (candele + serie indicatori + dati web) e ritorna, per ogni candela chiusa,
// +1 (ingresso LONG), −1 (ingresso SHORT) o 0. Solo informazioni disponibili alla chiusura di quella candela (nessun "futuro").

// ---------- serie di indicatori (lunghezza = numero candele, valori null finché non ci sono dati)
function emaS(v, n) { const k = 2 / (n + 1); const o = new Array(v.length); let e = null; for (let i = 0; i < v.length; i++) { e = e == null ? v[i] : v[i] * k + e * (1 - k); o[i] = i >= n - 1 ? e : null; } return o; }
function smaS(v, n) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function stdS(v, n, m = smaS(v, n)) { const o = new Array(v.length).fill(null); for (let i = n - 1; i < v.length; i++) { let q = 0; for (let j = i - n + 1; j <= i; j++) q += (v[j] - m[i]) ** 2; o[i] = Math.sqrt(q / n); } return o; }
function rsiS(c, n = 14) {
  const o = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function atrS(k, n = 14) { // ATR di Wilder (valore assoluto)
  const o = new Array(k.length).fill(null); let a = null; let s = 0;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
    if (i <= n) { s += tr; if (i === n) { a = s / n; o[i] = a; } } else { a = (a * (n - 1) + tr) / n; o[i] = a; }
  }
  return o;
}
function adxS(k, n = 14) {
  const o = new Array(k.length).fill(null); let tr = 0, pd = 0, md = 0, adx = null; const dx = [];
  for (let i = 1; i < k.length; i++) {
    const up = k[i].h - k[i - 1].h, dn = k[i - 1].l - k[i].l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
    if (i <= n) { tr += t; pd += p; md += m; if (i < n) continue; } else { tr = tr - tr / n + t; pd = pd - pd / n + p; md = md - md / n + m; }
    const pdi = tr ? (100 * pd) / tr : 0, mdi = tr ? (100 * md) / tr : 0; const d = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    dx.push(d);
    if (dx.length === n) adx = dx.reduce((a, b) => a + b, 0) / n; else if (dx.length > n) adx = (adx * (n - 1) + d) / n;
    if (adx != null) o[i] = adx;
  }
  return o;
}
const rollMax = (v, n) => v.map((_, i) => (i >= n ? Math.max(...v.slice(i - n, i)) : null)); // massimo delle n candele PRECEDENTI
const rollMin = (v, n) => v.map((_, i) => (i >= n ? Math.min(...v.slice(i - n, i)) : null));

// contesto con cache degli indicatori
function context(candles, extra = {}) {
  const c = candles.map((k) => k.c), h = candles.map((k) => k.h), l = candles.map((k) => k.l);
  const cache = new Map(); const memo = (key, fn) => (cache.has(key) ? cache.get(key) : (cache.set(key, fn()), cache.get(key)));
  const ctx = {
    k: candles, c, h, l, n: candles.length, ...extra,
    ema: (n) => memo('ema' + n, () => emaS(c, n)), sma: (n) => memo('sma' + n, () => smaS(c, n)), std: (n) => memo('std' + n, () => stdS(c, n, ctx.sma(n))),
    rsi: (n = 14) => memo('rsi' + n, () => rsiS(c, n)), atr: (n = 14) => memo('atr' + n, () => atrS(candles, n)), adx: (n = 14) => memo('adx' + n, () => adxS(candles, n)),
    hi: (n) => memo('hi' + n, () => rollMax(h, n)), lo: (n) => memo('lo' + n, () => rollMin(l, n)),
    vwap: (n) => memo('vwap' + n, () => { const o = new Array(c.length).fill(null); let pv = 0, vv = 0; for (let i = 0; i < c.length; i++) { const tp = (h[i] + l[i] + c[i]) / 3, v = candles[i].v || 0; pv += tp * v; vv += v; if (i >= n) { const j = i - n; const tpj = (h[j] + l[j] + c[j]) / 3, vj = candles[j].v || 0; pv -= tpj * vj; vv -= vj; } if (i >= n - 1 && vv > 0) o[i] = pv / vv; } return o; }),
    macd: (f = 12, s = 26, g = 9) => memo(`macd${f}.${s}.${g}`, () => { const a = emaS(c, f), b = emaS(c, s); const m = c.map((_, i) => (a[i] != null && b[i] != null ? a[i] - b[i] : null)); const start = m.findIndex((x) => x != null); const sig = new Array(c.length).fill(null); if (start >= 0) { const e = emaS(m.slice(start), g); for (let i = 0; i < e.length; i++) sig[start + i] = e[i]; } return m.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null)); }),
    // Supertrend: direzione +1/−1 per candela
    supertrend: (n, k) => memo(`st${n}.${k}`, () => { const a = atrS(candles, n); const o = new Array(c.length).fill(null); let up = null, dn = null, d = 1; for (let i = 0; i < c.length; i++) { if (a[i] == null) continue; const m = (h[i] + l[i]) / 2; const bu = m + k * a[i], bl = m - k * a[i]; up = up == null || bu < up || c[i - 1] > up ? bu : up; dn = dn == null || bl > dn || c[i - 1] < dn ? bl : dn; if (d === 1 && c[i] < dn) d = -1; else if (d === -1 && c[i] > up) d = 1; o[i] = d; } return o; }),
    // valore più recente di una serie temporale esterna (funding, Fear&Greed) noto alla chiusura della candela i
    at: (series, i, field) => { if (!series || !series.length) return null; const t = candles[i].t + (ctx.tfMs || 0); let lo = 0, hi = series.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r >= 0 ? series[r][field] : null; },
  };
  return ctx;
}
const nz = (x) => x != null && Number.isFinite(x);
const crossUp = (a, b, i) => nz(a[i]) && nz(b[i]) && nz(a[i - 1]) && nz(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a, b, i) => nz(a[i]) && nz(b[i]) && nz(a[i - 1]) && nz(b[i - 1]) && a[i - 1] >= b[i - 1] && a[i] < b[i];

// ---------- strategie (parametri: piccola griglia per il walk-forward, per limitare l'overfitting)
const STRATEGIES = [
  { id: 'ema_adx', name: 'Trend following EMA + ADX', desc: 'Incrocio EMA veloce/lenta solo con trend forte (ADX sopra soglia)', grid: [{ f: 9, s: 21, adx: 20 }, { f: 20, s: 50, adx: 20 }, { f: 20, s: 50, adx: 25 }],
    signal: (x, i, p) => { const a = x.ema(p.f), b = x.ema(p.s), d = x.adx(14)[i]; if (!nz(d) || d < p.adx) return 0; return crossUp(a, b, i) ? 1 : crossDn(a, b, i) ? -1 : 0; } },
  { id: 'donchian', name: 'Breakout Donchian (turtle)', desc: 'Chiusura oltre il massimo/minimo delle ultime N candele', grid: [{ n: 20 }, { n: 55 }],
    signal: (x, i, p) => { const hi = x.hi(p.n), lo = x.lo(p.n); if (!nz(hi[i]) || !nz(hi[i - 1])) return 0; if (x.c[i] > hi[i] && x.c[i - 1] <= hi[i - 1]) return 1; if (x.c[i] < lo[i] && x.c[i - 1] >= lo[i - 1]) return -1; return 0; } },
  { id: 'rsi_bb', name: 'Mean reversion RSI + Bollinger', desc: 'Eccesso fuori dalle bande con RSI estremo: si punta al rientro', grid: [{ n: 20, k: 2, lo: 30, hi: 70 }, { n: 20, k: 2.5, lo: 25, hi: 75 }],
    signal: (x, i, p) => { const m = x.sma(p.n)[i], s = x.std(p.n)[i], r = x.rsi(14)[i]; if (!nz(m) || !nz(s) || !nz(r)) return 0; if (x.c[i] < m - p.k * s && r < p.lo) return 1; if (x.c[i] > m + p.k * s && r > p.hi) return -1; return 0; } },
  { id: 'macd', name: 'Momentum MACD', desc: 'Istogramma MACD che cambia segno nella direzione del trend (EMA lunga)', grid: [{ t: 50 }, { t: 200 }],
    signal: (x, i, p) => { const hs = x.macd(), e = x.ema(p.t)[i]; if (!nz(hs[i]) || !nz(hs[i - 1]) || !nz(e)) return 0; if (hs[i - 1] <= 0 && hs[i] > 0 && x.c[i] > e) return 1; if (hs[i - 1] >= 0 && hs[i] < 0 && x.c[i] < e) return -1; return 0; } },
  { id: 'vwap', name: 'VWAP trend', desc: 'Prezzo che riconquista/perde il VWAP di 24h con EMA50 nella stessa direzione', grid: [{ e: 50 }, { e: 100 }],
    signal: (x, i, p) => { const w = x.vwap(x.dayBars || 96), e = x.ema(p.e); if (!nz(e[i]) || !nz(e[i - 3])) return 0; const cc = x.c; if (crossUp(cc, w, i) && e[i] > e[i - 3]) return 1; if (crossDn(cc, w, i) && e[i] < e[i - 3]) return -1; return 0; } },
  { id: 'squeeze', name: 'Volatility squeeze', desc: 'Bande di Bollinger dentro i canali di Keltner, poi esplosione nella direzione del momentum', grid: [{ n: 20, kc: 1.5, m: 6 }, { n: 20, kc: 2, m: 10 }],
    signal: (x, i, p) => {
      const sqz = (j) => { const m = x.sma(p.n)[j], s = x.std(p.n)[j], a = x.atr(p.n)[j]; return nz(m) && nz(s) && nz(a) && m + 2 * s < m + p.kc * a && m - 2 * s > m - p.kc * a; };
      if (i < p.m + 1 || sqz(i) || !sqz(i - 1)) return 0; for (let j = i - p.m; j < i; j++) if (!sqz(j)) return 0;
      const mo = x.c[i] - x.sma(p.n)[i]; return mo > 0 ? 1 : mo < 0 ? -1 : 0;
    } },
  { id: 'funding', name: 'Funding contrarian', desc: 'Funding dei perpetui estremo = posizioni affollate: si va contro quando il prezzo gira', grid: [{ hi: 0.0001, lo: -0.00002 }, { hi: 0.0001, lo: -0.00005 }],
    signal: (x, i, p) => { const f = x.at(x.funding, i, 'rate'); if (!nz(f)) return 0; const e = x.ema(20); if (f >= p.hi && crossDn(x.c, e, i)) return -1; if (f <= p.lo && crossUp(x.c, e, i)) return 1; return 0; } },
  { id: 'fng', name: 'Regime Fear & Greed', desc: 'Paura estrema + prezzo che torna sopra la EMA50 = LONG; avidità estrema + rottura sotto = SHORT', grid: [{ fear: 25, greed: 75 }, { fear: 35, greed: 65 }],
    signal: (x, i, p) => { const g = x.at(x.fng, i, 'value'); if (!nz(g)) return 0; const e = x.ema(50); if (g <= p.fear && crossUp(x.c, e, i)) return 1; if (g >= p.greed && crossDn(x.c, e, i)) return -1; return 0; } },
  { id: 'supertrend', name: 'Supertrend (ATR)', desc: 'Il prezzo rompe la banda ATR che segue il trend: si entra nella nuova direzione', grid: [{ n: 10, k: 3 }, { n: 14, k: 2.5 }],
    signal: (x, i, p) => { const d = x.supertrend(p.n, p.k); if (d[i] == null || d[i - 1] == null) return 0; return d[i] !== d[i - 1] ? d[i] : 0; } },
  { id: 'rsi2', name: 'Pullback RSI(2) Connors', desc: 'Nel trend di fondo (EMA200), si compra un ribasso estremo di breve (RSI a 2 periodi) e viceversa', grid: [{ lo: 10, hi: 90 }, { lo: 5, hi: 95 }],
    signal: (x, i, p) => { const r = x.rsi(2)[i], e = x.ema(200)[i]; if (!nz(r) || !nz(e)) return 0; if (x.c[i] > e && r < p.lo) return 1; if (x.c[i] < e && r > p.hi) return -1; return 0; } },
  { id: 'roc', name: 'Momentum di serie temporale (ROC)', desc: 'Rendimento delle ultime 24 ore che supera una soglia: si segue la direzione (time-series momentum)', grid: [{ th: 3 }, { th: 5 }],
    signal: (x, i, p) => { const n = x.dayBars || 96; if (i < n + 1) return 0; const r = (x.c[i] / x.c[i - n] - 1) * 100, r0 = (x.c[i - 1] / x.c[i - 1 - n] - 1) * 100; if (r > p.th && r0 <= p.th) return 1; if (r < -p.th && r0 >= -p.th) return -1; return 0; } },
  { id: 'lsratio', name: 'Contrarian long/short (OKX)', desc: 'Troppi conti long (o short) rispetto alla media di 7 giorni: si va contro la folla quando il prezzo gira', grid: [{ z: 1.5 }, { z: 2 }],
    signal: (x, i, p) => { const z = x.at(x.lsr, i, 'z'); if (!nz(z)) return 0; const e = x.ema(20); if (z >= p.z && crossDn(x.c, e, i)) return -1; if (z <= -p.z && crossUp(x.c, e, i)) return 1; return 0; } },
];
// regime di mercato alla candela i: rialzo / ribasso / laterale (EMA50 vs EMA200 + ADX)
function regimeAt(x, i) { const a = x.ema(50)[i], b = x.ema(200)[i], d = x.adx(14)[i]; if (!nz(a) || !nz(b) || !nz(d)) return 'laterale'; if (d >= 20 && a > b) return 'rialzo'; if (d >= 20 && a < b) return 'ribasso'; return 'laterale'; }
function signals(strategy, x, params) { const out = new Array(x.n).fill(0); for (let i = 2; i < x.n; i++) out[i] = strategy.signal(x, i, params) || 0; return out; }
module.exports = { STRATEGIES, context, signals, regimeAt, emaS, smaS, stdS, rsiS, atrS, adxS };
