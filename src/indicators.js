'use strict';
// Indicatori tecnici su candele {t,o,h,l,c,v}.
function ema(values, n) {
  if (!values.length) return [];
  const k = 2 / (n + 1); const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
function atrPct(c, n = 14) {
  if (c.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  const a = tr.slice(-n).reduce((s, x) => s + x, 0) / n;
  return (a / c[c.length - 1].c) * 100;
}
function momentum(closes, n) {
  if (closes.length <= n) return null;
  const a = closes[closes.length - 1 - n]; return a > 0 ? ((closes[closes.length - 1] - a) / a) * 100 : null;
}
function resample(c1, m) {
  const out = []; let cur = null;
  for (const k of c1) {
    const b = Math.floor(k.t / (m * 60000)) * m * 60000;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v || 0 }; }
    else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.v += k.v || 0; }
  }
  if (cur) out.push(cur);
  return out;
}
module.exports = { ema, rsi, atrPct, momentum, resample };
