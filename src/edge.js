'use strict';
// TREND 4H · la strategia di ingresso di Alpha (SOL/BTC/ETH con leva), scelta con backtest walk-forward su 2 anni di candele reali
// (tools/deskbt.js, dati da tools/fetch-klines.js). Regole, identiche nel bot e nel backtest:
// - candele a 4 ore (da candele 1h di Binance/Bybit/OKX/Coinbase/Kraken, solo candele chiuse)
// - LONG quando la EMA 20 incrocia sopra la EMA 100 e la chiusura è sopra la EMA 200; SHORT specchiato
// - si entra solo entro la candela a 4h successiva al segnale e solo se il prezzo non è già scappato (≤ 0,5 ATR dalla chiusura)
// - stop = 3 × ATR(14, 4h), mai oltre il 40% della distanza di liquidazione; nessun target fisso: dopo +1R trailing a 5 × ATR dal massimo
// - nessuno stop a tempo né uscite sul rumore a 1 minuto (erano la prima causa delle perdite); tempo massimo 21 giorni
// - dimensione a rischio fisso: una perdita allo stop costa circa riskPerTradePct% del capitale (predefinito 2%), mai oltre il margine massimo
const H4 = 4 * 3600e3;
const P = { fast: 20, slow: 100, trend: 200, atrN: 14, slAtr: 3, trailAtr: 5, chaseAtr: 0.5, maxHoldDays: 21, breakout: 0 };
const ASSET = { SOL: 'SOL', BTC: 'BTC', ETH: 'ETH', cbBTC: 'BTC', WBTC: 'BTC', WETH: 'ETH' };

function ema(v, n) { const k = 2 / (n + 1); const o = new Array(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; } return o; }
function atr(K, n) { const o = new Array(K.length).fill(null); let a = null; for (let i = 1; i < K.length; i++) { const tr = Math.max(K[i].h - K[i].l, Math.abs(K[i].h - K[i - 1].c), Math.abs(K[i].l - K[i - 1].c)); a = a == null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
// candele (1m, 15m o 1h) → candele a 4h allineate a UTC; solo blocchi completi e chiusi
function to4h(K, now = Infinity) {
  const out = []; let cur = null;
  for (const k of K) { const t0 = Math.floor(k.t / H4) * H4;
    if (!cur || cur.t !== t0) { if (cur) out.push(cur); cur = { t: t0, o: k.o, h: k.h, l: k.l, c: k.c, last: k.t, n: 1 }; }
    else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.last = k.t; cur.n++; } }
  if (cur) out.push(cur);
  const step = K.length > 1 ? K[1].t - K[0].t : 3600e3; const need = Math.round(H4 / step);
  return out.filter((b) => b.t + H4 <= now && b.n >= need).map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
}
function prep(B) { const c = B.map((x) => x.c); const X = { B, c, f: ema(c, P.fast), s: ema(c, P.slow), tr: ema(c, P.trend), atr: atr(B, P.atrN) };
  if (P.breakout) { const n = P.breakout; X.hh = B.map((_, i) => (i >= n ? Math.max(...B.slice(i - n, i).map((x) => x.h)) : null)); X.ll = B.map((_, i) => (i >= n ? Math.min(...B.slice(i - n, i).map((x) => x.l)) : null)); }
  return X; }
// segnale sulla candela a 4h chiusa i: { dir, atrPct, slPct, trailPct, close, barT (apertura), closeT }
function signalAt(X, i, lev = 5, liqDistPct = null) {
  if (i < P.trend + 5 || X.atr[i] == null) return null;
  const { f, s, tr, c } = X; let up = f[i] > s[i] && f[i - 1] <= s[i - 1] && c[i] > tr[i]; let dn = f[i] < s[i] && f[i - 1] >= s[i - 1] && c[i] < tr[i];
  if (P.breakout && X.hh && !up && !dn) { up = c[i] > X.hh[i] && c[i] > tr[i]; dn = c[i] < X.ll[i] && c[i] < tr[i]; }
  if (!up && !dn) return null;
  const atrPct = (X.atr[i] / c[i]) * 100; const cap = liqDistPct != null ? liqDistPct * 0.4 : 100;
  return { dir: up ? 1 : -1, side: up ? 'LONG' : 'SHORT', atrPct, slPct: Math.min(P.slAtr * atrPct, cap), trailPct: P.trailAtr * atrPct, close: c[i], barT: X.B[i].t, closeT: X.B[i].t + H4,
    ema20: f[i], ema100: s[i], ema200: tr[i] };
}
// il prezzo è ancora vicino al segnale? (niente inseguimenti)
const fresh = (sg, px, now) => now < sg.closeT + H4 && Math.abs(px - sg.close) / sg.close * 100 <= P.chaseAtr * sg.atrPct;
// frazione del margine massimo da usare perché la perdita allo stop sia ≈ riskPerTradePct% del capitale
function riskFrac(cfg, slPct, lev) {
  const maxT = Math.max(0.01, (Number(cfg.maxTradePct) || 20) / 100); const risk = Math.max(0.001, (Number(cfg.riskPerTradePct) || 2) / 100);
  return Math.max(0.05, Math.min(1, risk / (Math.max(1, lev) * Math.max(0.1, slPct) / 100) / maxT));
}
// uscite di una posizione trend: stop iniziale, trailing dopo +1R, tempo massimo (prezzo già «specchiato» per gli short)
function exitEdge(pos, price, now) {
  pos.highest = Math.max(pos.highest || pos.entryPrice, price);
  const ch = ((price - pos.entryPrice) / pos.entryPrice) * 100; const gainHigh = ((pos.highest - pos.entryPrice) / pos.entryPrice) * 100;
  const fmt = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`; const events = [];
  if (gainHigh >= pos.slPct) { const ts = pos.highest * (1 - pos.edge.trailPct / 100); if (!pos.trailStop || ts > pos.trailStop) { events.push({ type: 'trail', from: pos.trailStop || null, to: ts, pctFromEntry: ((ts - pos.entryPrice) / pos.entryPrice) * 100 }); pos.trailStop = ts; } }
  const sl = pos.entryPrice * (1 - pos.slPct / 100); const stop = Math.max(sl, pos.trailStop || 0);
  if (price <= stop) return { action: 'close', reason: `${stop === pos.trailStop ? 'Trailing stop' : 'Stop-loss'} (${fmt(ch)})`, change: ch, events };
  if (now - pos.openedAt >= P.maxHoldDays * 864e5) return { action: 'close', reason: `Tempo massimo (${P.maxHoldDays} giorni)`, change: ch, events };
  return { action: 'none', change: ch, events, levels: { R: pos.slPct, trailAct: pos.slPct, trailDist: pos.edge.trailPct } };
}

// stato live: 3000 candele 1h (~125 giorni, EMA 200 a 4h stabile) → 4h per SOL/BTC/ETH, aggiornate ogni 10 minuti dalle fonti gratuite (con cascata di fonti)
class Edge {
  constructor(e) { this.e = e; this.X = {}; this.t = {}; this.err = {}; this.busy = false; }
  async refresh(now = Date.now(), force = false) {
    if (this.busy) return; this.busy = true;
    try { for (const a of ['SOL', 'BTC', 'ETH']) { if (!force && this.t[a] && now - this.t[a] < 10 * 60e3) continue;
      try { const r = await this.e.research.feeds.candles(a, '1h', 3000); const B = to4h(r.candles, now); if (B.length >= P.trend + 10) { this.X[a] = prep(B); this.t[a] = now; this.err[a] = null; } else this.err[a] = `solo ${B.length} candele a 4h`; }
      catch (err) { this.err[a] = String(err.message || err).slice(0, 80); } } }
    finally { this.busy = false; }
  }
  last(sym) { const a = ASSET[sym] || sym; const X = this.X[a]; if (!X) return null; return signalAt(X, X.B.length - 1, this.e.leverage ? this.e.leverage() : 5, this.liq()); }
  liq() { try { return require('./perps').liqDistancePct(this.e.leverage()); } catch { return null; } }
  // segnale attivo e ancora valido per un nuovo ingresso (non già usato da una posizione aperta dopo il segnale)
  signal(sym, now = Date.now()) {
    const sg = this.last(sym); if (!sg) return null; const px = this.e.market && this.e.market.usd ? this.e.market.usd(this.mintOf(sym)) : null;
    if (!px || !fresh(sg, px, now)) return null;
    const b = this.e.book; const used = (x) => x.perp && (x.market === (ASSET[sym] || sym) || x.symbol === sym) && x.openedAt >= sg.closeT;
    if (b && (b.positions.some(used) || b.trades.slice(0, 50).some(used))) return null;
    return sg;
  }
  mintOf(sym) { const S = require('./perps').SHORT_MARKETS; return Object.keys(S).find((m) => S[m] === (ASSET[sym] || sym)); }
  view(now = Date.now()) {
    return ['SOL', 'BTC', 'ETH'].map((a) => { const X = this.X[a]; if (!X) return { asset: a, ready: false, err: this.err[a] || 'candele a 4h in caricamento' };
      const i = X.B.length - 1; const trend = X.f[i] > X.s[i] ? (X.c[i] > X.tr[i] ? 'rialzo' : 'rialzo debole') : (X.c[i] < X.tr[i] ? 'ribasso' : 'ribasso debole');
      const sg = this.signal(a, now); return { asset: a, ready: true, trend, close: X.c[i], ema20: X.f[i], ema100: X.s[i], ema200: X.tr[i], atrPct: +((X.atr[i] / X.c[i]) * 100).toFixed(2), signal: sg ? sg.side : null, barT: X.B[i].t, updated: this.t[a] }; });
  }
}
module.exports = { Edge, P, H4, to4h, prep, signalAt, fresh, riskFrac, exitEdge, ema, atr };
