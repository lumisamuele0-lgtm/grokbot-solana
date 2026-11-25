'use strict';
// MENTORE · ricerca sul web: studia le strategie di trading più usate e documentate (trend following,
// breakout, mean reversion, momentum, VWAP, squeeze, funding, Fear & Greed) su dati reali e gratuiti,
// con un backtest walk-forward ogni 4 ore. Attiva SOLO quelle con risultati positivi FUORI CAMPIONE
// (dopo commissioni, con shrinkage) per ogni cripto e regime di mercato, e le passa come consiglio al CAPO.
// Non tocca mai i limiti: margine 7%, leva 5–10x, stop prima della liquidazione, kill switch.
const path = require('path');
const { readJson, debounceWriter } = require('./store');
const { Feeds, TF_MIN } = require('./feeds');
const ST = require('./strategies');
const B = require('./backtest');

const ASSETS = ['SOL', 'BTC', 'ETH'];
const TFS = { '5m': { bars: 2880, dayBars: 288 }, '15m': { bars: 2688, dayBars: 96 }, '1h': { bars: 1440, dayBars: 24 } }; // ~10, 28, 60 giorni
const LIVE_BARS = 420;
const BACKTEST_MS = 4 * 3600e3, FEEDS_MS = 15 * 60e3;
const VERSION = 1;
const SYMBOL_ASSET = { SOL: 'SOL', BTC: 'BTC', cbBTC: 'BTC', WBTC: 'BTC', ETH: 'ETH', WETH: 'ETH' };
const pct = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d).replace('.', ',') + '%';

// peso di una strategia attiva: più è solida fuori campione (t-stat), più conta (0,5 – 1,5)
const weightOf = (s) => Math.max(0.5, Math.min(1.5, 0.4 + 0.3 * s.tstat));

// valuta una strategia su un asset: il timeframe si sceglie SOLO sui dati di allenamento (in campione),
// poi il giudizio (attiva/scartata) usa esclusivamente il periodo fuori campione: niente "scelta del migliore a posteriori"
function evaluate(perTf) {
  let best = null;
  for (const [tf, w] of Object.entries(perTf)) if (w && (!best || (w.isScore ?? -99) > (best.w.isScore ?? -99))) best = { tf, w };
  if (!best) return null;
  const s = best.w.oos; const active = B.passes(s);
  const reason = active ? 'risultati positivi fuori campione' : s.n < B.RULES.minTrades ? `poche operazioni (${s.n})` : s.shrunkPct <= 0 ? 'rendimento atteso negativo dopo commissioni' : s.pf < B.RULES.minPf ? 'profit factor basso' : s.ddPct > B.RULES.maxDd ? 'drawdown troppo alto' : 'risultato non abbastanza solido (t-stat)';
  const regimeOff = Object.entries(best.w.byRegime).filter(([, r]) => r.n >= 5 && r.shrunkPct <= 0).map(([k]) => k);
  return { tf: best.tf, params: best.w.params, oos: s, byRegime: best.w.byRegime, longs: best.w.longs, shorts: best.w.shorts, spanDays: best.w.spanDays,
    active, reason, weight: active ? weightOf(s) : 0, regimeOff,
    tfs: Object.fromEntries(Object.entries(perTf).filter(([, w]) => w).map(([tf, w]) => [tf, { n: w.oos.n, winRate: w.oos.winRate, expPct: w.oos.expPct, retPct: w.oos.retPct, ddPct: w.oos.ddPct }])) };
}

class Research {
  constructor({ dataDir, log = () => {}, agent = () => {}, getCfg = () => ({}), getLev = () => 5, feeds = null }) {
    this.log = log; this.agent = agent; this.getCfg = getCfg; this.getLev = getLev;
    const saved = dataDir ? readJson(path.join(dataDir, 'research.json'), null) : null;
    this.st = saved && saved.v === VERSION ? saved : { v: VERSION, results: {}, live: {}, fng: null, funding: {}, oi: {}, health: {}, sources: {}, lastBacktest: null, lastFeeds: null, backtestLev: null, runs: 0, lastError: null };
    this.feeds = feeds || new Feeds(this.st.health);
    this.writer = dataDir ? debounceWriter(path.join(dataDir, 'research.json'), () => this.st, 2000) : { schedule() {}, flush() {} };
    this.running = false; this.timers = [];
  }
  start() {
    const due = this.st.lastBacktest ? Math.max(30e3, BACKTEST_MS - (Date.now() - this.st.lastBacktest)) : 30e3;
    this.timers.push(setTimeout(() => this.refreshFeeds().catch(() => {}), 8e3));
    this.timers.push(setTimeout(() => { this.backtest().catch(() => {}); this.timers.push(setInterval(() => this.backtest().catch(() => {}), BACKTEST_MS)); }, due));
    this.timers.push(setInterval(() => this.refreshFeeds().catch(() => {}), FEEDS_MS));
  }
  stop() { this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); this.writer.flush(); }

  // ---------- dati web (Fear & Greed, funding, open interest) + segnali live delle strategie attive
  async refreshFeeds() {
    const st = this.st; const parts = [];
    try { const g = await this.feeds.fearGreed(); st.fng = { series: g.series, source: g.source, t: Date.now() }; const l = g.series[g.series.length - 1]; parts.push(`Fear & Greed ${l.value} (${itFng(l.label)})`); st.sources.fng = g.source; }
    catch (e) { parts.push('Fear & Greed non disponibile'); }
    for (const a of ASSETS) {
      try { const f = await this.feeds.funding(a); st.funding[a] = { series: f.series.slice(-500), source: f.source, t: Date.now() }; st.sources.funding = f.source; } catch { /* fonte successiva al prossimo giro */ }
      try { const o = await this.feeds.openInterest(a); st.oi[a] = { usd: o.usd, source: o.source, t: Date.now() }; st.sources.oi = o.source; } catch { /* idem */ }
    }
    const fs = ASSETS.map((a) => st.funding[a] && `${a} ${(st.funding[a].series.at(-1).rate * 100).toFixed(4).replace('.', ',')}%`).filter(Boolean);
    if (fs.length) parts.push(`funding ${fs.join(' · ')} (${st.sources.funding})`);
    const ois = ASSETS.map((a) => st.oi[a] && `${a} ${(st.oi[a].usd / 1e9).toFixed(2).replace('.', ',')} mld $`).filter(Boolean);
    if (ois.length) parts.push(`open interest ${ois.join(' · ')} (${st.sources.oi})`);
    await this.liveSignals();
    st.lastFeeds = Date.now(); this.writer.schedule();
    this.agent('MENTORE', 'leggo il web: ' + parts[0], 'web');
    this.log('MENTORE', `leggo il web: ${parts.join(' · ')}`);
    if (st.lastBacktest && st.backtestLev !== this.getLev() && !this.running) this.backtest().catch(() => {}); // leva cambiata: si ristudia
  }
  ctxFor(asset, candles, tf) {
    return ST.context(candles, { dayBars: TFS[tf].dayBars, tfMs: TF_MIN[tf] * 60e3, funding: this.st.funding[asset] && this.st.funding[asset].series, fng: this.st.fng && this.st.fng.series });
  }
  async liveSignals() {
    const now = Date.now();
    for (const a of ASSETS) {
      const res = this.st.results[a] || {}; const act = Object.entries(res).filter(([, r]) => r && r.active);
      const tfs = [...new Set(['1h', ...act.map(([, r]) => r.tf)])];
      const live = { t: now, regime: null, signals: [] };
      for (const tf of tfs) {
        let c; try { c = (await this.feeds.candles(a, tf, LIVE_BARS)).candles; } catch { continue; }
        if (c.length < 250) continue;
        const x = this.ctxFor(a, c, tf);
        if (tf === '1h') live.regime = ST.regimeAt(x, x.n - 1);
        const look = Math.ceil(15 / TF_MIN[tf]) + 1;
        for (const [id, r] of act.filter(([, r]) => r.tf === tf)) {
          const s = ST.STRATEGIES.find((q) => q.id === id); if (!s) continue;
          for (let i = x.n - 1; i >= Math.max(2, x.n - look); i--) {
            const d = s.signal(x, i, r.params);
            if (d) { live.signals.push({ id, tf, dir: d, barT: c[i].t, until: c[i].t + 2 * TF_MIN[tf] * 60e3 + FEEDS_MS, atrPct: x.atr(14)[i] / x.c[i] * 100 }); break; }
          }
        }
      }
      this.st.live[a] = live;
    }
  }

  // ---------- backtest walk-forward su settimane di candele reali
  async backtest() {
    if (this.running) return; this.running = true; const t0 = Date.now();
    const cfg = this.getCfg(); const lev = this.getLev();
    try {
      this.agent('MENTORE', 'studio le strategie di trading più usate su dati reali (backtest)…', 'web');
      if (!this.st.fng || Date.now() - this.st.fng.t > 3600e3) await this.refreshFeeds().catch(() => {});
      const results = {}; const used = new Set(); let ok = 0;
      for (const a of ASSETS) {
        const perStrat = Object.fromEntries(ST.STRATEGIES.map((s) => [s.id, {}]));
        for (const [tf, def] of Object.entries(TFS)) {
          let got; try { got = await this.feeds.candles(a, tf, def.bars); } catch (e) { this.log('MENTORE', `candele ${a} ${tf} non disponibili da nessuna fonte: ${e.message}`, 'warn'); continue; }
          if (got.candles.length < 600) continue;
          used.add(got.source); ok++;
          const x = this.ctxFor(a, got.candles, tf);
          for (const s of ST.STRATEGIES) {
            if ((s.id === 'funding' && !(this.st.funding[a] && this.st.funding[a].series.length)) || (s.id === 'fng' && !(this.st.fng && this.st.fng.series.length))) continue;
            perStrat[s.id][tf] = B.walkForward(s, x, { cfg, lev, tfMin: TF_MIN[tf] });
          }
        }
        results[a] = Object.fromEntries(Object.entries(perStrat).map(([id, p]) => [id, evaluate(p)]));
      }
      if (!ok) throw new Error('nessuna candela disponibile');
      this.st.results = results; this.st.lastBacktest = Date.now(); this.st.backtestLev = lev; this.st.runs++; this.st.sources.candles = [...used].join(', '); this.st.lastError = null; this.st.durationMs = Date.now() - t0;
      await this.liveSignals().catch(() => {});
      this.writer.schedule();
      const sm = this.summary();
      const act = sm.strategies.filter((s) => s.active).map((s) => `${s.name} (${s.activeOn.join('/')})`);
      this.log('MENTORE', `studiate ${ST.STRATEGIES.length} strategie su SOL, BTC, ETH (5m/15m/1h, leva ${lev}x, fonte ${this.st.sources.candles}) · test fuori campione: ${act.length ? 'attive ' + act.join(', ') : 'nessuna strategia batte le commissioni, il CAPO usa solo la sua analisi'} · scartate ${sm.strategies.length - act.length}`);
      for (const s of sm.strategies) this.log('MENTORE', `${s.name}: ${s.best ? `${s.best.asset} ${s.best.tf} · ${s.best.n} operazioni · vincenti ${s.best.winRate.toFixed(0)}% · resa media ${pct(s.best.expPct)} sul margine · capitale ${pct(s.best.retPct)} · drawdown ${s.best.ddPct.toFixed(1).replace('.', ',')}%` : 'dati insufficienti'} → ${s.active ? 'ATTIVA' : 'scartata'}`);
      this.agent('MENTORE', act.length ? `strategie attive: ${act.slice(0, 2).join(', ')}` : 'nessuna strategia supera il test fuori campione', 'teach');
    } catch (e) {
      this.st.lastError = e.message; this.log('MENTORE', `studio delle strategie non riuscito: ${e.message} (riprovo più tardi)`, 'warn');
    } finally { this.running = false; }
  }

  // ---------- consiglio al CAPO: punteggio delle strategie attive che hanno appena dato un segnale
  signalFor(symbol, side) {
    const a = SYMBOL_ASSET[symbol]; const live = a && this.st.live[a]; const res = a && this.st.results[a];
    const out = { score: 0, against: 0, strategies: [], opposite: [], atrPct: null };
    if (!live || !res) return out;
    const now = Date.now(); const want = side === 'SHORT' ? -1 : 1;
    for (const sg of live.signals) {
      if (sg.until < now) continue;
      const r = res[sg.id]; if (!r || !r.active) continue;
      if (live.regime && r.regimeOff.includes(live.regime)) continue; // perdente in questo regime di mercato
      if (sg.dir === want) { out.score += r.weight; out.strategies.push(sg.id); if (out.atrPct == null || r.weight > 1) out.atrPct = sg.atrPct; }
      else { out.against += r.weight; out.opposite.push(sg.id); }
    }
    return out;
  }
  summary() {
    const st = this.st;
    const strategies = ST.STRATEGIES.map((s) => {
      const per = ASSETS.map((a) => (st.results[a] && st.results[a][s.id] ? { asset: a, ...st.results[a][s.id] } : null)).filter(Boolean);
      const best = per.slice().sort((x, y) => y.oos.shrunkPct - x.oos.shrunkPct)[0];
      const activeOn = per.filter((p) => p.active).map((p) => p.asset);
      return { id: s.id, name: s.name, desc: s.desc, active: activeOn.length > 0, activeOn, reason: best ? best.reason : 'in attesa del primo studio',
        best: best ? { asset: best.asset, tf: best.tf, n: best.oos.n, winRate: best.oos.winRate, expPct: best.oos.expPct, retPct: best.oos.retPct, ddPct: best.oos.ddPct, sharpe: best.oos.sharpe, pf: best.oos.pf, weight: best.weight } : null,
        assets: per.map((p) => ({ asset: p.asset, tf: p.tf, active: p.active, n: p.oos.n, winRate: p.oos.winRate, expPct: p.oos.expPct, retPct: p.oos.retPct, ddPct: p.oos.ddPct })) };
    });
    const fngL = st.fng && st.fng.series.length ? st.fng.series[st.fng.series.length - 1] : null;
    return { strategies, lastBacktest: st.lastBacktest, lastFeeds: st.lastFeeds, running: this.running, runs: st.runs, lev: st.backtestLev, lastError: st.lastError,
      sources: { candele: st.sources.candles || null, funding: st.sources.funding || null, openInterest: st.sources.oi || null, fearGreed: st.sources.fng || null },
      fng: fngL ? { value: fngL.value, label: itFng(fngL.label) } : null,
      regimes: Object.fromEntries(ASSETS.map((a) => [a, st.live[a] ? st.live[a].regime : null])),
      liveSignals: ASSETS.flatMap((a) => (st.live[a] ? st.live[a].signals.filter((s) => s.until > Date.now()).map((s) => ({ asset: a, id: s.id, tf: s.tf, dir: s.dir })) : [])),
      rules: B.RULES };
  }
  // stato pubblico (nessun dato sensibile): quali fonti funzionano dal server
  publicStatus() {
    const sm = this.summary();
    return { lastBacktest: sm.lastBacktest, lastFeeds: sm.lastFeeds, running: sm.running, runs: sm.runs, lastError: sm.lastError, durationMs: this.st.durationMs || null, sources: sm.sources, fng: sm.fng, regimes: sm.regimes,
      health: Object.fromEntries(Object.entries(this.st.health).map(([k, h]) => [k, { ok: h.ok, lastOk: h.lastOk, lastErr: h.lastErr }])),
      strategies: sm.strategies.map((s) => ({ id: s.id, active: s.active, activeOn: s.activeOn, best: s.best && { asset: s.best.asset, tf: s.best.tf, n: s.best.n, winRate: +s.best.winRate.toFixed(1), expPct: +s.best.expPct.toFixed(3), retPct: +s.best.retPct.toFixed(3), ddPct: +s.best.ddPct.toFixed(2) } })) };
  }
}
function itFng(l) { return ({ 'Extreme Fear': 'paura estrema', Fear: 'paura', Neutral: 'neutrale', Greed: 'avidità', 'Extreme Greed': 'avidità estrema' })[l] || l; }
module.exports = { Research, evaluate, weightOf, SYMBOL_ASSET, ASSETS, TFS };
