'use strict';
// TREND 2–4H · logica di ingresso e uscita di Alpha (perps SOL/BTC/ETH) e Omega (spot, solo long, cripto CORE).
// Scelta con la ricerca walk-forward su 2 anni di candele Binance a 15 min (costi inclusi): fra 432 varianti su 2h/4h
// (incroci EMA, rotture Donchian, filtri di tendenza, stop/trailing ATR) i parametri sono quelli migliori sugli ultimi 12 mesi
// (stessa regola usata in ogni passo del walk-forward: profit factor più alto con almeno 2 trade al mese).
// Regole (identiche nella ricerca):
// - candele a 4 ore (da candele 1h, solo chiuse); segnale all'incrocio EMA veloce/lenta nel verso della EMA 200
// - ingresso entro la candela a 4h successiva al segnale; una posizione per cripto
// - stop = slAtr × ATR(14, 4h) (perps: mai oltre il 40% della distanza di liquidazione); dopo +1R trailing a trailAtr × ATR dal massimo
// - nessun target fisso, nessuno stop a tempo né uscite sul rumore a 1 minuto; durata massima 21 giorni
// - dimensione a rischio fisso: allo stop si perde circa riskPerTradePct% del capitale, mai oltre il margine massimo (20%)
const H1 = 3600e3;
const TF_MS = { '2h': 2 * H1, '4h': 4 * H1 };
const PARAMS = {
  perp: { tf: '4h', fast: 20, slow: 100, trend: 200, atrN: 14, slAtr: 4, trailAtr: 8, act: 1, maxHoldDays: 21, longOnly: false },
  spot: { tf: '4h', fast: 10, slow: 30, trend: 200, atrN: 14, slAtr: 1.5, trailAtr: 8, act: 1, maxHoldDays: 21, longOnly: true },
};
const PERP_ASSETS = ['SOL', 'BTC', 'ETH'];
const SPOT_ASSETS = ['JUP', 'RAY', 'JTO', 'PYTH', 'RENDER', 'W', 'ORCA', 'KMNO'];
const SYM_ALIAS = { cbBTC: 'BTC', WBTC: 'BTC', WETH: 'ETH' };

function ema(v, n) { const k = 2 / (n + 1); const o = new Array(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; o[i] = e; } return o; }
function atr(K, n) { const o = new Array(K.length).fill(null); let a = null; for (let i = 1; i < K.length; i++) { const tr = Math.max(K[i].h - K[i].l, Math.abs(K[i].h - K[i - 1].c), Math.abs(K[i].l - K[i - 1].c)); a = a == null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
// candele (1h o 15m) → candele del timeframe, allineate a UTC; solo blocchi completi e chiusi
function resampleTf(K, ms, now = Infinity) {
  const out = []; let cur = null;
  for (const k of K) { const t0 = Math.floor(k.t / ms) * ms;
    if (!cur || cur.t !== t0) { if (cur) out.push(cur); cur = { t: t0, o: k.o, h: k.h, l: k.l, c: k.c, n: 1 }; }
    else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.n++; } }
  if (cur) out.push(cur);
  const step = K.length > 1 ? K[1].t - K[0].t : H1; const need = Math.round(ms / step);
  return out.filter((b) => b.t + ms <= now && b.n >= need).map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
}
function prep(B, p) { const c = B.map((x) => x.c); return { B, c, f: ema(c, p.fast), s: ema(c, p.slow), tr: ema(c, p.trend), atr: atr(B, p.atrN), p }; }
// segnale sulla candela chiusa i
function signalAt(X, i, liqDistPct = null) {
  const p = X.p; if (i < p.trend + 5 || X.atr[i] == null) return null;
  const { f, s, tr, c } = X; const up = f[i] > s[i] && f[i - 1] <= s[i - 1] && c[i] > tr[i]; const dn = !p.longOnly && f[i] < s[i] && f[i - 1] >= s[i - 1] && c[i] < tr[i];
  if (!up && !dn) return null;
  const ms = TF_MS[p.tf]; const atrPct = (X.atr[i] / c[i]) * 100; const cap = liqDistPct != null ? liqDistPct * 0.4 : 100;
  return { dir: up ? 1 : -1, side: up ? 'LONG' : 'SHORT', atrPct, slPct: Math.min(p.slAtr * atrPct, cap), trailPct: p.trailAtr * atrPct, close: c[i], barT: X.B[i].t, closeT: X.B[i].t + ms, tf: p.tf };
}
// ancora valido? entro la candela successiva al segnale e prezzo non già oltre lo stop
function fresh(sg, px, now) {
  if (!(now >= sg.closeT && now < sg.closeT + TF_MS[sg.tf])) return false;
  const move = ((px - sg.close) / sg.close) * 100 * sg.dir; return move > -sg.slPct;
}
// frazione del margine massimo perché la perdita allo stop sia ≈ riskPerTradePct% del capitale
function riskFrac(cfg, slPct, lev) {
  const maxT = Math.max(0.01, (Number(cfg.maxTradePct) || 20) / 100); const risk = Math.max(0.001, (Number(cfg.riskPerTradePct) || 1) / 100);
  return Math.max(0.05, Math.min(1, risk / ((Math.max(1, lev) * Math.max(0.1, slPct)) / 100) / maxT));
}
// uscite (prezzo già «specchiato» per gli short da S.exitPlan): stop iniziale, trailing dopo +1R, durata massima
function exitTrend(pos, price, now) {
  pos.highest = Math.max(pos.highest || pos.entryPrice, price);
  const ch = ((price - pos.entryPrice) / pos.entryPrice) * 100; const gainHigh = ((pos.highest - pos.entryPrice) / pos.entryPrice) * 100;
  const fmt = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`; const events = []; const act = pos.edge.act != null ? pos.edge.act : 1;
  if (gainHigh >= pos.slPct * act) { const ts = pos.highest * (1 - pos.edge.trailPct / 100); if ((!pos.trailStop || ts > pos.trailStop) && ts > pos.entryPrice * (1 - pos.slPct / 100)) { events.push({ type: 'trail', from: pos.trailStop || null, to: ts, pctFromEntry: ((ts - pos.entryPrice) / pos.entryPrice) * 100 }); pos.trailStop = ts; } }
  const sl = pos.entryPrice * (1 - pos.slPct / 100); const stop = Math.max(sl, pos.trailStop || 0);
  if (price <= stop) return { action: 'close', reason: `${stop === pos.trailStop ? 'Trailing stop' : 'Stop-loss'} (${fmt(ch)})`, change: ch, events };
  const days = pos.edge.maxHoldDays || 21;
  if (now - pos.openedAt >= days * 864e5) return { action: 'close', reason: `Tempo massimo (${days} giorni)`, change: ch, events };
  return { action: 'none', change: ch, events, levels: { R: pos.slPct, trailAct: pos.slPct * act, trailDist: pos.edge.trailPct } };
}

// stato live: candele 1h (3000 ≈ 125 giorni) → 4h per ogni cripto, scaricate una volta per candela a 4h dalle fonti gratuite
class Trend {
  constructor(e) { this.e = e; this.X = {}; this.t = {}; this.err = {}; this.busy = false; this.lastRun = 0; }
  kindOf(a) { return PERP_ASSETS.includes(a) ? 'perp' : 'spot'; }
  assets() { return [...PERP_ASSETS, ...SPOT_ASSETS]; }
  async refresh(now = Date.now(), force = false) {
    if (this.busy) return; this.busy = true; this.lastRun = now;
    try { for (const a of this.assets()) { const p = PARAMS[this.kindOf(a)]; const ms = TF_MS[p.tf];
      const stale = !this.t[a] || Math.floor(this.t[a] / ms) < Math.floor(now / ms) || now - this.t[a] > H1;
      if (!force && !stale) continue;
      try { const r = await this.e.research.feeds.candles(a, '1h', 3000); const B = resampleTf(r.candles, ms, now);
        if (B.length >= p.trend + 10) { this.X[a] = prep(B, p); this.t[a] = now; this.err[a] = null; } else this.err[a] = `solo ${B.length} candele a ${p.tf}`; }
      catch (err) { this.err[a] = String(err.message || err).slice(0, 80); } } }
    finally { this.busy = false; }
  }
  liq() { try { return require('./perps').liqDistancePct(this.e.leverage()); } catch { return null; } }
  last(sym) { const a = SYM_ALIAS[sym] || sym; const X = this.X[a]; if (!X) return null; return signalAt(X, X.B.length - 1, this.kindOf(a) === 'perp' ? this.liq() : null); }
  mintOf(sym) {
    const a = SYM_ALIAS[sym] || sym;
    if (PERP_ASSETS.includes(a)) { const S = require('./perps').SHORT_MARKETS; return Object.keys(S).find((m) => S[m] === a); }
    const t = require('./tokens').CORE.find((x) => x.symbol === a); return t ? t.mint : null;
  }
  // segnale attivo e non ancora usato (nessuna posizione o trade su quella cripto aperto dopo il segnale)
  signal(sym, now = Date.now()) {
    const sg = this.last(sym); if (!sg) return null; const mint = this.mintOf(sym); const px = mint && this.e.market && this.e.market.usd ? this.e.market.usd(mint) : null;
    if (!px || !fresh(sg, px, now)) return null;
    const b = this.e.book; const used = (x) => x.mint === mint && x.openedAt >= sg.closeT;
    if (b && (b.positions.some(used) || b.trades.slice(0, 80).some(used))) return null;
    return { ...sg, sym: SYM_ALIAS[sym] || sym, mint, kind: this.kindOf(SYM_ALIAS[sym] || sym) };
  }
  nextCheck(now = Date.now()) { const ms = TF_MS['4h']; return Math.floor(now / ms) * ms + ms; }
  view(now = Date.now()) {
    return this.assets().map((a) => { const kind = this.kindOf(a); const X = this.X[a]; if (!X) return { asset: a, kind, ready: false, err: this.err[a] || 'candele in caricamento' };
      const i = X.B.length - 1; const p = X.p; const upF = X.f[i] > X.s[i]; const above = X.c[i] > X.tr[i];
      const trend = upF && above ? 'rialzo' : !upF && !above ? 'ribasso' : 'incerto';
      const sg = this.signal(a, now); return { asset: a, kind, ready: true, tf: p.tf, trend, signal: sg ? sg.side : null, atrPct: +((X.atr[i] / X.c[i]) * 100).toFixed(2), lastClose: X.B[i].t + TF_MS[p.tf], updated: this.t[a] }; });
  }
}
module.exports = { Trend, PARAMS, PERP_ASSETS, SPOT_ASSETS, TF_MS, resampleTf, prep, signalAt, fresh, riskFrac, exitTrend, ema, atr };
