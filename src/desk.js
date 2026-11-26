'use strict';
// SALA OPERATIVA: 12 ANALISTI + 2 TRADER.
// Gli analisti NON aprono operazioni: ognuno guarda il mercato con il suo metodo (trend, momentum, breakout, contropiede,
// flusso ordini, memecoin, notizie, funding, volatilità, multi-timeframe, balene/liquidità, macro BTC) ed emette un SEGNALE
// (cripto, direzione, fiducia 0–1, motivo). I 2 TRADER (Alpha e Omega) sono gli unici che operano: sommano i segnali con un
// CONSENSO PESATO (i pesi li aggiorna il MENTORE in base alla percentuale di successo di ogni analista) e aprono/gestiscono le
// posizioni, sempre dentro i limiti di rischio: margine fino al 20% del capitale per operazione (in base alla forza del
// consenso), massimo posizioni aperte, esposizione totale massima, stop-loss su ogni posizione (sui perps sempre prima della
// liquidazione), limite di perdita giornaliera, kill switch e blocchi REALE invariati.
// Leva e short solo su SOL/BTC/ETH (Jupiter Perps); sulle altre cripto spot 1x solo long (memecoin con i filtri anti-truffa).
const P = require('./perps');
const S = require('./strategy');
const K = require('./knowledge');
const U = require('./universe');
const { atrPct, momentum, resample } = require('./indicators');

const MAX_COINS = 12; // cripto spot sul radar (oltre a SOL/BTC/ETH con leva)
const MAX_ENTRIES_PER_TURN = 4; // ingressi totali per giro (ogni ~10 s)
const RULES = { PICK_EVERY_MS: 2 * 60e3, SEL_STEP: 0.05, SEL_MAX: 0.15, REST_MS: 2 * 60e3, W_MIN: 0.4, W_MAX: 1.6, FEED_MAX: 60 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ---------- i 12 analisti: fn(ctx) → { dir: 1 LONG | -1 SHORT | 0 nessun segnale, conf 0–1, why }
const V = (dir, conf, why) => ({ dir, conf: clamp(conf, 0, 1), why });
const NONE = (why = 'nessun segnale') => ({ dir: 0, conf: 0, why });
const lib = (c, ids, dir) => { if (!c.perp || !c.rs) return 0; const r = c.rs(dir > 0 ? 'LONG' : 'SHORT', ids); return r.score > 0 && r.against < r.score ? 0.15 : r.against > r.score ? -0.15 : 0; };
const ANALYSTS = [
  { id: 'trend', name: 'Trend', icon: '📈', desc: 'Medie mobili EMA 9/21 su 1 e 5 minuti, pendenza e RSI: segue la direzione del mercato.',
    fn(c) { const a = c.a; if (!a.ok) return NONE('dati insufficienti');
      if (a.signal === 'LONG') return V(1, a.confidence + lib(c, ['ema_adx', 'supertrend'], 1), 'trend rialzista 1m+5m');
      if (a.short.signal) return V(-1, a.short.confidence + lib(c, ['ema_adx', 'supertrend'], -1), 'trend ribassista 1m+5m');
      if (a.trend1 && a.trend5 && a.confidence >= 0.67) return V(1, a.confidence * 0.7, 'trend rialzista in formazione');
      if (a.short.confidence >= 0.67 && a.short.checks['EMA9<EMA21 (1m)']) return V(-1, a.short.confidence * 0.7, 'trend ribassista in formazione');
      return NONE(a.reason || 'trend debole'); } },
  { id: 'momentum', name: 'Momentum', icon: '🚀', desc: 'Forza del movimento a 15 e 60 minuti (MACD/ROC): entra quando il prezzo accelera.',
    fn(c) { const a = c.a; if (!a.ok) return NONE('dati insufficienti'); const m15 = a.m15 || 0, m60 = a.m60 || 0; const k = c.perp ? 1 : 2.5;
      if (m15 > 0.35 * k && m60 > 0.7 * k) return V(1, 0.4 + m15 / (3 * k) + m60 / (8 * k) + lib(c, ['macd', 'roc'], 1), `+${m15.toFixed(1)}% in 15 min`);
      if (m15 < -0.35 * k && m60 < -0.7 * k) return V(-1, 0.4 - m15 / (3 * k) - m60 / (8 * k) + lib(c, ['macd', 'roc'], -1), `${m15.toFixed(1)}% in 15 min`);
      return NONE('momentum piatto'); } },
  { id: 'breakout', name: 'Breakout', icon: '💥', desc: 'Rottura del massimo/minimo delle ultime 20 candele a 5 minuti (canale di Donchian).',
    fn(c) { const k5 = resample(c.c1, 5); if (k5.length < 22) return NONE('dati insufficienti'); const prev = k5.slice(-21, -1); const last = k5[k5.length - 1].c;
      const hi = Math.max(...prev.map((x) => x.h)), lo = Math.min(...prev.map((x) => x.l));
      if (last > hi) return V(1, 0.6 + Math.min(0.3, ((last - hi) / hi) * 100 / 2) + lib(c, ['donchian'], 1), 'rottura del massimo a 100 min');
      if (last < lo) return V(-1, 0.6 + Math.min(0.3, ((lo - last) / lo) * 100 / 2) + lib(c, ['donchian'], -1), 'rottura del minimo a 100 min');
      return NONE('dentro il canale'); } },
  { id: 'reversion', name: 'Contropiede', icon: '🔄', desc: 'Eccessi fuori dalle bande di Bollinger con RSI estremo e candela di inversione: punta sul rientro.',
    fn(c) { const r = c.rev; if (!r.ok) return NONE('dati insufficienti');
      if (r.LONG.signal) return V(1, 0.75 + lib(c, ['rsi_bb', 'rsi2'], 1), 'eccesso di vendite + inversione');
      if (r.SHORT.signal) return V(-1, 0.75 + lib(c, ['rsi_bb', 'rsi2'], -1), 'eccesso di acquisti + inversione');
      if (r.LONG.conf >= 0.75) return V(1, 0.5, 'vendite eccessive'); if (r.SHORT.conf >= 0.75) return V(-1, 0.5, 'acquisti eccessivi');
      return NONE('nessun eccesso'); } },
  { id: 'flow', name: 'Flusso ordini', icon: '🌊', desc: 'Acquisti contro vendite dell\'ultima ora e accelerazione del volume (dati on-chain DexScreener).',
    fn(c) { const f = c.f; if (!(f.buys + f.sells)) return NONE('nessun dato di flusso'); if (Math.abs(f.score) < 0.3) return NONE('flusso bilanciato');
      return V(sgn(f.score), 0.3 + Math.abs(f.score) * 0.6, `${f.buys} acquisti / ${f.sells} vendite`); } },
  { id: 'meme', name: 'Cacciatore meme', icon: '🐸', desc: 'Solo memecoin che hanno passato i filtri anti-truffa: momentum, flusso e crescita sana (niente pump estremi).', spotOnly: true,
    fn(c) { if (c.perp || !c.coin.meme) return NONE('non è una memecoin'); const ch1 = c.ch1, ch5 = c.ch5, f = c.f;
      if (ch1 != null && ch1 < -8) return V(-1, 0.55, `${ch1.toFixed(0)}% in 1h: evitare`);
      if (ch1 != null && ch1 >= 1.5 && ch1 <= 30 && (ch5 == null || ch5 > -1) && f.ratio > 0.05) return V(1, 0.45 + Math.min(0.3, ch1 / 40) + Math.min(0.2, f.ratio), `+${ch1.toFixed(1)}% in 1h con acquisti`);
      return NONE('memecoin senza spinta'); } },
  { id: 'news', name: 'Notizie', icon: '📰', desc: 'Sentiment delle notizie crypto (controllate dal Mentore ogni 90 s) su SOL, BTC ed ETH.', perpOnly: true,
    fn(c) { const n = c.news; if (!c.perp || !n || !n.fresh) return NONE('nessuna notizia recente'); if (n.risk > 0.6) return V(-1, 0.4, 'notizie di rischio');
      if (Math.abs(n.sentiment) < 0.15) return NONE('notizie neutre'); return V(sgn(n.sentiment), Math.min(0.85, 0.35 + Math.abs(n.sentiment)), n.sentiment > 0 ? 'notizie positive' : 'notizie negative'); } },
  { id: 'funding', name: 'Funding & L/S', icon: '⚖️', desc: 'Funding dei perpetui e rapporto long/short (OKX): quando un lato è troppo affollato va contro.', perpOnly: true,
    fn(c) { if (!c.perp) return NONE('solo SOL/BTC/ETH'); const fr = num(c.mc.funding), z = num(c.mc.lsrZ); let s = 0; const why = [];
      if (fr != null && fr > 0.0003) { s -= 1; why.push('funding alto'); } else if (fr != null && fr < -0.0001) { s += 1; why.push('funding negativo'); }
      if (z != null && z > 1.5) { s -= 1; why.push('troppi long'); } else if (z != null && z < -1.5) { s += 1; why.push('troppi short'); }
      if (!s) return NONE('posizionamento equilibrato'); return V(sgn(s), 0.45 + 0.15 * Math.abs(s) + lib(c, ['funding', 'lsratio'], sgn(s)), why.join(' + ')); } },
  { id: 'volatility', name: 'Volatilità', icon: '⚡', desc: 'Compressione delle bande (squeeze) seguita da esplosione, o volatilità che si espande nella direzione del movimento.',
    fn(c) { const cl = c.c1.map((x) => x.c); if (cl.length < 140) return NONE('dati insufficienti');
      const w = (end) => { const s = cl.slice(end - 20, end); const m = s.reduce((x, y) => x + y, 0) / 20; return (Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / 20) * 4) / m; };
      const now = w(cl.length), before = w(cl.length - 5); let avg = 0; for (let i = 0; i < 6; i++) avg += w(cl.length - 20 - i * 20) / 6;
      const m5 = c.a.m5 || 0;
      if (before < avg * 0.6 && now > before * 1.3 && Math.abs(m5) > 0.15) return V(sgn(m5), 0.65 + lib(c, ['squeeze'], sgn(m5)), 'esplosione dopo la compressione');
      const a1 = atrPct(c.c1.slice(-15), 14), a0 = atrPct(c.c1.slice(-75, -60), 14);
      if (a1 && a0 && a1 > a0 * 1.6 && Math.abs(m5) > 0.3) return V(sgn(m5), 0.5, 'volatilità in espansione');
      return NONE('volatilità normale'); } },
  { id: 'mtf', name: 'Multi-timeframe', icon: '🧭', desc: 'Allineamento delle direzioni a 5 min, 15 min, 1 ora e 6 ore: entra solo quando i tempi concordano.',
    fn(c) { const a = c.a; if (!a.ok) return NONE('dati insufficienti'); const xs = [a.m5, a.m15, a.m60, c.ch6].filter((x) => x != null && Math.abs(x) > 0.05).map(sgn);
      if (xs.length < 3) return NONE('direzioni deboli'); const up = xs.filter((x) => x > 0).length, dn = xs.filter((x) => x < 0).length;
      if (up === xs.length) return V(1, xs.length === 4 ? 0.85 : 0.65, `${up}/${xs.length} tempi al rialzo`); if (dn === xs.length) return V(-1, xs.length === 4 ? 0.85 : 0.65, `${dn}/${xs.length} tempi al ribasso`);
      if (up >= 3 && sgn(a.m60) > 0) return V(1, 0.5, '3 tempi su 4 al rialzo'); if (dn >= 3 && sgn(a.m60) < 0) return V(-1, 0.5, '3 tempi su 4 al ribasso');
      return NONE('tempi in disaccordo'); } },
  { id: 'whale', name: 'Balene & liquidità', icon: '🐋', desc: 'Volume dell\'ultima ora molto sopra la media (grandi ordini) con il prezzo che si muove: segue i soldi grossi.',
    fn(c) { const f = c.f; const ch5 = c.ch5 != null ? c.ch5 : c.a.m5; if (c.liq != null && c.liq < 50000) return NONE('liquidità troppo bassa');
      if (f.volAccel > 1.8 && ch5 != null && Math.abs(ch5) > 0.3) return V(sgn(ch5), 0.4 + Math.min(0.45, (f.volAccel - 1.8) * 0.2), `volume ×${f.volAccel.toFixed(1)} sulla media`);
      return NONE('nessun grande ordine'); } },
  { id: 'macro', name: 'Macro BTC', icon: '🌍', desc: 'Direzione di Bitcoin, capitalizzazione totale e Fear & Greed: le altcoin di solito seguono BTC.',
    fn(c) { const m = c.macro; if (!m) return NONE('dati macro non pronti'); let s = 0;
      if (m.btc60 != null) s += clamp(m.btc60 / 1.5, -1.5, 1.5); if (m.mcap24 != null) s += clamp(m.mcap24 / 3, -1, 1);
      if (m.fng != null && m.fng < 20 && (m.btc60 || 0) > 0) s += 0.5; if (m.fng != null && m.fng > 80 && (m.btc60 || 0) < 0) s -= 0.5;
      if (Math.abs(s) < 0.5) return NONE('mercato senza direzione'); return V(sgn(s), Math.min(0.85, 0.3 + Math.abs(s) * 0.25), s > 0 ? 'BTC e mercato in salita' : 'BTC e mercato in discesa'); } },
];
const ANALYST_IDS = ANALYSTS.map((a) => a.id);

// ---------- i 2 trader: gli unici che aprono operazioni
const EXECUTORS = [
  { id: 'alpha', name: 'Alpha', role: 'Aggressivo · momentum e leva', desc: 'Opera con leva (5x–10x) long e short su SOL, BTC ed ETH (Jupiter Perps). Dà più peso a trend, momentum, breakout e multi-timeframe; entra con un consenso più basso.',
    domain: 'perp', thr: 0.28, minAgree: 3, maxPerTurn: 3, boost: { trend: 1.3, momentum: 1.3, breakout: 1.3, mtf: 1.2, funding: 1.1, news: 1.1, volatility: 1.1 }, hue: 190 },
  { id: 'omega', name: 'Omega', role: 'Selettivo · spot e memecoin', desc: 'Compra spot 1x (solo long) sulle altre cripto di Solana, memecoin comprese, solo dopo i controlli anti-truffa. Dà più peso a flusso, memecoin, balene e contropiede; chiede un consenso più alto.',
    domain: 'spot', thr: 0.36, minAgree: 4, maxPerTurn: 3, boost: { meme: 1.4, flow: 1.3, whale: 1.3, reversion: 1.2, mtf: 1.1, macro: 1.1 }, hue: 280 },
];
const EXEC_IDS = EXECUTORS.map((x) => x.id);
const BOT_IDS = [...EXEC_IDS, ...ANALYST_IDS];
// migrazione dalle versioni precedenti: i vecchi bot (pianeti, giocatori) passano al trader del loro tipo di operazione
const OLD_BOTS = ['nova', 'orione', 'vega', 'lyra', 'atlante', 'sirio', 'titano', 'zefiro', 'selene', 'andromeda', 'polaris', 'nebula', 'aurora', 'calipso'];
const OLD_PLAYERS = { A1: 1, A2: 1, A3: 1, A4: 1, A5: 1, A6: 1, B1: 1, B2: 1, B3: 1, B4: 1, B5: 1, B6: 1 };
const execFor = (p) => (p.perp || P.SHORT_MARKETS[p.mint] ? 'alpha' : 'omega');

const coinView = (c, lev) => ({ mint: c.mint, symbol: c.symbol, name: c.name, icon: c.icon || null, perp: !!c.perp, market: c.market || null, color: c.color || U.coinColor(c.mint, c.symbol), phantom: !!c.phantom, meme: !!c.meme, label: U.offer(c, lev).label });
function newState() { return { coins: [], coinsAt: 0, paused: {}, analysts: {}, execs: {}, signals: {}, feed: [], decisions: {}, insight: null, breaker: null }; }

class Desk {
  constructor(engine) { this.e = engine; this.votes = {}; this.lastSig = {}; this.migrate(); }
  get st() { const e = this.e; if (!e.st.desk) e.st.desk = newState(); return e.st.desk; }
  migrate() {
    const e = this.e; let ch = false;
    if (e.st.match) { delete e.st.match; ch = true; }
    if (e.st.galaxy) { delete e.st.galaxy; ch = true; } // Osservatorio: statistiche dei pianeti non più usate (posizioni e storico restano)
    if (!e.st.desk) { e.st.desk = newState(); ch = true; }
    const d = e.st.desk; const fresh = newState();
    for (const k of Object.keys(fresh)) if (d[k] === undefined || (typeof fresh[k] === 'object' && fresh[k] !== null && (typeof d[k] !== 'object' || d[k] === null) && k !== 'insight' && k !== 'breaker')) { d[k] = fresh[k]; ch = true; }
    for (const bk of Object.values(e.st.books || {})) {
      for (const p of [...(bk.positions || []), ...(bk.trades || [])]) {
        if (p.player !== undefined || p.team !== undefined || p.matchId !== undefined) { if (!p.bot && p.player && OLD_PLAYERS[p.player]) p.bot = execFor(p); delete p.team; delete p.player; delete p.matchId; ch = true; }
        if (p.bot && !EXEC_IDS.includes(p.bot)) { p.origBot = p.bot; p.bot = execFor(p); ch = true; } // ex pianeta → trader
      }
      for (const k of Object.keys(bk.cooldown || {})) { const pre = k.split(':')[0]; if (k.includes(':') && !EXEC_IDS.includes(pre)) { delete bk.cooldown[k]; ch = true; } }
    }
    if (ch && e.save) e.save();
  }
  analyst(id) { return ANALYSTS.find((a) => a.id === id) || null; }
  exec(id) { return EXECUTORS.find((x) => x.id === id) || null; }
  aState(id) { const s = this.st; if (!s.analysts[id]) s.analysts[id] = { hits: 0, n: 0, weight: 1, last: null }; return s.analysts[id]; }
  xState(id) { const s = this.st; if (!s.execs[id]) s.execs[id] = { wins: 0, losses: 0, streak: 0, selectivity: 0, restUntil: 0, note: null }; return s.execs[id]; }
  isPaused(id) { return !!this.st.paused[id]; }
  setPaused(id, paused) {
    if (!BOT_IDS.includes(id)) throw new Error('Bot sconosciuto');
    if (paused) this.st.paused[id] = Date.now(); else delete this.st.paused[id];
    const n = this.exec(id) ? this.exec(id).name : this.analyst(id).name;
    this.e.log('SALA', `${n} ${paused ? 'in pausa (le posizioni aperte restano gestite)' : 'di nuovo al lavoro'}`);
    this.e.save(); return { id, paused: !!paused };
  }
  weight(id) { const a = this.aState(id); return a.weight || 1; }

  // ---------- radar: SOL/BTC/ETH con leva + fino a 12 cripto spot (memecoin comprese) che superano i filtri anti-truffa
  candidates() {
    const e = this.e; let pool = e.universe ? e.universe.eligible() : [];
    if (!pool.some((c) => c.perp)) pool = [...pool, ...Object.entries(P.SHORT_MARKETS).map(([mint, sym]) => { const st = e.market.stats[mint] || {}; return { mint, symbol: sym, name: U.PERP_INFO[sym].name, perp: true, market: sym, color: U.coinColor(mint), volume24h: st.volume24h || 1e8, change1h: st.change1h, change24h: st.change24h, icon: st.icon || null }; })];
    if (!e.cfg.spotLongs) pool = pool.filter((c) => c.perp);
    pool = pool.filter((c) => !this.unsafe(c));
    return pool;
  }
  unsafe(c) { if (c.perp) return false; const sf = this.e.market.safety[c.mint]; return !!(sf && S.safetyRules(sf, this.e.cfg, false).length); }
  coinScore(c) {
    const ch1 = clamp(num(c.change1h) || 0, -15, 15), ch6 = clamp(num(c.change6h) || 0, -15, 15);
    return 0.6 * Math.max(0, Math.log10(Math.max(1e5, c.volume24h || 0)) - 5) + (c.phantom ? 0.3 : 0) + Math.abs(ch1) * 0.25 + Math.max(0, ch6) * 0.05 + (c.meme ? 0.2 : 0);
  }
  pickCoins(now = Date.now(), announce = true) {
    const e = this.e; const s = this.st; const lev = e.leverage(); const held = new Set(e.book.positions.map((p) => p.mint));
    const pool = this.candidates(); const perps = pool.filter((c) => c.perp); const spot = pool.filter((c) => !c.perp).map((c) => ({ c, s: this.coinScore(c) })).sort((a, b) => b.s - a.s).map((x) => x.c);
    const keep = (s.coins || []).filter((c) => !c.perp && held.has(c.mint));
    const chosen = [...keep]; for (const c of spot) { if (chosen.length >= MAX_COINS) break; if (!chosen.some((x) => x.mint === c.mint)) chosen.push(c); }
    const before = (s.coins || []).map((c) => c.mint).join(',');
    s.coins = [...perps, ...chosen].map((c) => (c.label ? c : coinView(c, lev))); s.coinsAt = now;
    if (announce && s.coins.map((c) => c.mint).join(',') !== before && s.coins.length) e.log('SALA', `📡 radar: ${s.coins.map((c) => c.symbol).join(', ')}`);
    return s.coins;
  }
  coinMints() { return (this.st.coins || []).map((c) => c.mint); }
  insight(text, now = Date.now()) { this.st.insight = { t: now, text }; this.e.emit('ev', { type: 'insight', text }); }

  // ogni secondo: radar, fine delle pause dei trader, interruttore della perdita giornaliera
  tick(now = Date.now()) {
    const s = this.st; const uts = this.e.universe ? this.e.universe.ts : 0;
    const held = (mint) => this.e.book.positions.some((p) => p.mint === mint);
    const f = s.coins || [];
    if (!f.length || now - (s.coinsAt || 0) >= RULES.PICK_EVERY_MS || (f.some((x) => this.unsafe(x) && !held(x.mint)) && now - (s.coinsAt || 0) > 10e3) || (uts > (s.coinsAt || 0) && now - (s.coinsAt || 0) > 30e3)) this.pickCoins(now, true);
    for (const id of EXEC_IDS) { const x = this.xState(id); if (x.restUntil && x.restUntil <= now) { x.restUntil = 0; x.note = null; } }
    this.checkBreaker(now);
  }
  // limite di perdita giornaliera: oltre la soglia nessun nuovo ingresso fino a domani (le posizioni aperte restano protette dagli stop)
  checkBreaker(now = Date.now()) {
    const e = this.e; const b = e.book; const eq = e.equity(); const s = this.st;
    const dayLoss = b.dayStartEquity > 0 ? ((b.dayStartEquity - eq) / b.dayStartEquity) * 100 : 0;
    const hit = dayLoss >= e.cfg.dailyLossPct;
    if (hit && (!s.breaker || s.breaker.day !== b.dayKey)) {
      s.breaker = { day: b.dayKey, at: now, pct: +dayLoss.toFixed(2), limit: e.cfg.dailyLossPct };
      const t = `Limite di perdita giornaliera raggiunto (−${dayLoss.toFixed(1)}% ≥ ${e.cfg.dailyLossPct}%): nessun nuovo ingresso fino a domani. Le posizioni aperte restano protette da stop e target.`;
      e.log('RISCHIO', `⛔ ${t}`, 'warn'); this.insight(t, now); e.emit('ev', { type: 'breaker', text: t }); e.save();
    }
    if (s.breaker && s.breaker.day !== b.dayKey) s.breaker = null;
    return s.breaker && s.breaker.day === b.dayKey ? s.breaker : null;
  }

  // ---------- contesto di una cripto per gli analisti
  context(coin, cache) {
    const e = this.e; const mint = coin.mint; const c1 = e.market.candles[mint]; if (!c1 || c1.length < 60) return null;
    if (cache[mint]) return cache[mint];
    const st = e.market.stats[mint] || {}; const uc = (e.universe && e.universe.get && e.universe.get(mint)) || {};
    const pick = (k) => (num(st[k]) != null ? num(st[k]) : num(coin[k]) != null ? num(coin[k]) : num(uc[k]));
    const symbol = coin.perp ? coin.market || coin.symbol : coin.symbol; const r = e.research;
    let mc = {}, news = null; try { mc = coin.perp ? r.marketContext(symbol) : {}; news = coin.perp ? r.newsFor(symbol) : null; } catch { /* ricerca non pronta */ }
    const x = { coin, perp: !!coin.perp, symbol, mint, c1, a: S.analyze(c1), rev: S.reversion(c1), st, f: st.buys1h != null ? S.flowScore(st) : { score: 0, ratio: 0, volAccel: num(uc.volAccel) || 1, buys: 0, sells: 0 },
      ch1: pick('change1h'), ch5: pick('change5m'), ch6: pick('change6h'), liq: pick('liquidityUsd'), mc, news, macro: cache.__macro,
      rs: coin.perp ? (side, ids) => { try { return r.signalFor(symbol, side, ids); } catch { return { score: 0, against: 0, strategies: [] }; } } : null };
    cache[mint] = x; return x;
  }
  macro() {
    const e = this.e; const btcMint = Object.keys(P.SHORT_MARKETS).find((m) => P.SHORT_MARKETS[m] === 'BTC'); const c = btcMint && e.market.candles[btcMint];
    let mc = {}; try { mc = e.research.marketContext('BTC') || {}; } catch { /* */ }
    const btc60 = c && c.length > 60 ? momentum(c.map((x) => x.c), 60) : null;
    return { btc60, mcap24: num(mc.mcap24h), fng: num(mc.fng) };
  }
  // tutti gli analisti votano su una cripto
  analyze(ctx) {
    const out = [];
    for (const A of ANALYSTS) {
      if (this.isPaused(A.id)) continue;
      if (A.perpOnly && !ctx.perp) continue; if (A.spotOnly && ctx.perp) continue;
      let v; try { v = A.fn(ctx); } catch (err) { v = NONE('errore: ' + err.message); }
      out.push({ id: A.id, dir: v.dir, conf: v.dir ? v.conf : 0, why: v.why });
    }
    return out;
  }
  // consenso pesato per un trader: (a favore − contro) / (peso di chi ha votato + 30% del peso di chi si astiene)
  consensus(votes, side, X) {
    const want = side === 'SHORT' ? -1 : 1; let pro = 0, con = 0, voted = 0, abst = 0; const yes = [], no = [];
    for (const v of votes) {
      const w = this.weight(v.id) * ((X && X.boost[v.id]) || 1);
      if (!v.dir) { abst += w; continue; }
      voted += w;
      if (v.dir === want) { pro += w * v.conf; yes.push(v.id); } else { con += w * v.conf; no.push(v.id); }
    }
    const den = voted + 0.3 * abst; const score = den > 0 ? (pro - con) / den : 0;
    return { score, yes, no, pro, con };
  }
  // registra i segnali più forti di ogni analista (per la griglia e il flusso dei segnali)
  record(ctx, votes, now) {
    const s = this.st;
    for (const v of votes) {
      const a = this.aState(v.id); const cur = s.signals[v.id];
      if (v.dir && (!cur || cur.t < now - 15e3 || v.conf > cur.conf || cur.symbol === ctx.coin.symbol)) s.signals[v.id] = { t: now, symbol: ctx.coin.symbol, side: v.dir > 0 ? 'LONG' : 'SHORT', conf: +v.conf.toFixed(2), why: v.why, meme: !!ctx.coin.meme };
      else if (!v.dir && cur && cur.symbol === ctx.coin.symbol && now - cur.t > 60e3) delete s.signals[v.id];
      const key = `${v.id}:${ctx.mint}`; const prev = this.lastSig[key];
      if (v.dir && v.conf >= 0.5 && prev !== v.dir) this.feed({ t: now, kind: 'signal', who: v.id, symbol: ctx.coin.symbol, side: v.dir > 0 ? 'LONG' : 'SHORT', conf: +v.conf.toFixed(2), text: v.why });
      this.lastSig[key] = v.dir && v.conf >= 0.5 ? v.dir : 0;
      a.last = now;
    }
  }
  feed(item) { const s = this.st; s.feed.unshift(item); if (s.feed.length > RULES.FEED_MAX) s.feed.length = RULES.FEED_MAX; this.e.emit('ev', { type: 'signal', item }); }

  // ---------- giro: analisti → consenso → i trader aprono (max 4 ingressi per giro, max 3 per trader)
  async turn(now = Date.now()) {
    const e = this.e; const cfg = e.cfg; const b = e.book; const s = this.st;
    if (b.killed) return [];
    if (this.checkBreaker(now)) { e.agent('RISCHIO', `limite di perdita giornaliera (${cfg.dailyLossPct}%): nessun nuovo ingresso fino a domani`, 'block'); return []; }
    if (!s.coins || !s.coins.length) this.pickCoins(now, false);
    const coins = s.coins || []; const cache = { __macro: this.macro() };
    const perpBlk = e.perpBlock(), spotBlk = e.spotBlock();
    e.agent('SCANSIONE', `12 analisti su ${coins.length} cripto (${coins.filter((c) => c.perp).length} con leva, ${coins.filter((c) => !c.perp).length} spot)`, 'scan');
    const cands = [];
    for (const coin of coins) {
      const ctx = this.context(coin, cache); if (!ctx) continue;
      if (!coin.perp && !e.watch.has(coin.mint)) continue; // spot: solo dopo i controlli di VERIFICA (RugCheck, autorità, liquidità)
      const votes = this.analyze(ctx); this.votes[coin.mint] = { t: now, symbol: coin.symbol, votes };
      this.record(ctx, votes, now);
      if (!ctx.a.ok) continue;
      for (const X of EXECUTORS) {
        if (this.isPaused(X.id)) continue; const xs = this.xState(X.id); if (xs.restUntil > now) continue;
        if ((X.domain === 'perp') !== !!coin.perp) continue;
        if (coin.perp ? perpBlk : spotBlk) continue;
        for (const side of coin.perp ? ['LONG', 'SHORT'] : ['LONG']) {
          if (coin.perp && side === 'LONG' && !cfg.perpLongs) continue;
          if (coin.perp && side === 'SHORT' && !cfg.shortsOn) continue;
          if (!coin.perp && !cfg.spotLongs) continue;
          if (b.positions.some((p) => p.mint === coin.mint)) continue; // una posizione per cripto (sui perps: mai long e short insieme, stesso conto on-chain)
          const cdKey = `${X.id}:${coin.mint}:${side}`; if ((b.cooldown[cdKey] && b.cooldown[cdKey] > now) || (b.cooldown[coin.mint] && b.cooldown[coin.mint] > now)) continue;
          const cs = this.consensus(votes, side, X); const thr = X.thr + xs.selectivity;
          const sym = ctx.symbol; const st = { ...ctx.st, symbol: coin.perp ? sym : coin.symbol };
          const feat = [...K.featuresOf({ s: st, a: ctx.a, f: ctx.f, core: !!coin.perp, solMom60: e.solMom60(), side: side === 'SHORT' ? 'short' : 'long' }), coin.perp ? `${side === 'SHORT' ? 'short.' : ''}leva:${e.leverage()}x` : 'spot:1x', ...cs.yes.map((id) => (side === 'SHORT' ? 'short.' : '') + 'analista:' + id)];
          const kn = K.assess(e.kb, feat);
          const x = { m: coin.mint, s: st, a: ctx.a, f: ctx.f, feat, kn, rs: { score: 0, against: 0, strategies: [], opposite: [], atrPct: null }, side, coin, X, cs, thr, conf: clamp(cs.score, 0, 1), total: cs.score + kn.adj * 0.1, votes };
          e.mentorGate(x);
          cands.push(x);
        }
      }
    }
    if (!cands.length) { e.agent('CAPO', 'nessun mercato libero per i trader (pausa, cooldown, posizioni o candele in caricamento)', 'idle'); return []; }
    cands.sort((p, q) => q.cs.score - p.cs.score);
    const ok = cands.filter((x) => x.cs.score >= x.thr && x.cs.yes.length >= x.X.minAgree && x.cs.yes.length > x.cs.no.length && !x.kn.skip && !x.block);
    const top = cands[0];
    if (!ok.length) {
      const blocked = cands.find((x) => x.block && x.cs.score >= x.thr);
      const t = blocked ? `${blocked.X.name} su $${blocked.coin.symbol}: ${blocked.block}` : `${top.X.name}: miglior consenso $${top.coin.symbol} ${top.side} ${(top.cs.score * 100).toFixed(0)}% (serve ${(top.thr * 100).toFixed(0)}% e ${top.X.minAgree} analisti d'accordo, ora ${top.cs.yes.length})`;
      e.agent('CAPO', t, 'idle', { token: top.coin.symbol }); this.st.decisions[top.X.id] = { t: now, kind: 'wait', symbol: top.coin.symbol, side: top.side, score: +top.cs.score.toFixed(3), thr: top.thr, yes: top.cs.yes, no: top.cs.no, text: t };
      return [];
    }
    const opened = []; const per = {};
    for (const best of ok) {
      if (opened.length >= MAX_ENTRIES_PER_TURN) break;
      if (b.positions.length >= cfg.maxOpen) break;
      if ((per[best.X.id] || 0) >= best.X.maxPerTurn) continue;
      if (b.positions.some((p) => p.mint === best.m)) continue;
      const prev = e.actx; e.actx = { bot: best.X.id };
      try {
        const lev = best.coin.perp ? e.tradeLev(null) : 1; // leva scelta da te (5x o 10x), mai oltre il limite rigido 10x
        const frac = clamp(0.4 + best.cs.score, 0.4, 1); // forza del consenso → dimensione (fino al 100% del massimo per operazione)
        const yesN = best.cs.yes.map((id) => this.analyst(id).name);
        e.agent('CAPO', `${best.X.name} entra ${best.side === 'SHORT' ? 'SHORT ▼' : 'LONG ▲'}${best.coin.perp ? ` ${lev}x` : ' spot 1x'} su $${best.coin.symbol}: consenso ${(best.cs.score * 100).toFixed(0)}% · ${yesN.length} analisti (${yesN.join(', ')})`, 'pick', { token: best.coin.symbol, side: best.side });
        e.log('SALA', `${best.X.name} sceglie $${best.coin.symbol} ${best.side} · consenso ${(best.cs.score * 100).toFixed(0)}% · a favore: ${yesN.join(', ')}${best.cs.no.length ? ' · contro: ' + best.cs.no.map((id) => this.analyst(id).name).join(', ') : ''}`);
        const before = new Set(b.positions.map((p) => p.id));
        const ret = await e.enterTrade(best, { conf: best.conf, bot: best.X.id, perp: best.coin.perp, lev: best.coin.perp ? lev : null, frac });
        const p = (ret && ret.mint ? ret : null) || b.positions.find((q) => !before.has(q.id) && q.bot === best.X.id);
        if (p) {
          p.votes = best.votes.filter((v) => v.dir).map((v) => ({ id: v.id, dir: v.dir, conf: +v.conf.toFixed(2) })); p.consensus = +best.cs.score.toFixed(3);
          opened.push(p); per[best.X.id] = (per[best.X.id] || 0) + 1;
          const d = { t: now, kind: 'open', symbol: p.symbol, side: p.side || 'LONG', lev: p.lev || 1, score: p.consensus, yes: best.cs.yes, no: best.cs.no, size: p.costBase, text: `aperto ${p.side || 'LONG'} su $${p.symbol}` };
          this.st.decisions[best.X.id] = d; this.feed({ ...d, who: best.X.id });
          e.emit('ev', { type: 'open', bot: best.X.id, symbol: p.symbol, side: p.side || 'LONG' });
          e.save();
        }
      } finally { e.actx = prev; }
      if (b.killed) break;
    }
    return opened;
  }

  // ---------- trade chiuso: il MENTORE aggiorna i pesi degli analisti (chi aveva ragione pesa di più) e corregge il trader
  onClose(tr, now = Date.now()) {
    if (!tr) return;
    const win = (tr.pnl || 0) >= 0; const want = tr.side === 'SHORT' ? -1 : 1;
    for (const v of tr.votes || []) {
      if (!this.analyst(v.id) || !v.dir) continue; const a = this.aState(v.id);
      a.n++; if ((v.dir === want) === win) a.hits++;
      const rate = (a.hits + 2) / (a.n + 4); // media prudente (parte dal 50%)
      a.weight = +clamp(1 + 2 * (rate - 0.5), RULES.W_MIN, RULES.W_MAX).toFixed(3);
    }
    const X = tr.bot && this.exec(tr.bot); if (!X) { this.e.save(); return; }
    const x = this.xState(X.id);
    if (win) { x.wins++; x.streak = Math.max(0, x.streak) + 1; if (x.selectivity > 0) x.selectivity = +Math.max(0, x.selectivity - RULES.SEL_STEP).toFixed(2); if (!x.selectivity) x.note = null; }
    else {
      x.losses++; x.streak = Math.min(0, x.streak) - 1;
      if (x.streak <= -3) { x.restUntil = now + RULES.REST_MS; x.streak = 0; x.note = `${X.name}: 3 perdite di fila, 2 minuti di pausa per ricalibrare`; }
      else if (x.streak <= -2) { x.selectivity = +Math.min(RULES.SEL_MAX, x.selectivity + RULES.SEL_STEP).toFixed(2); x.note = `${X.name}: 2 perdite di fila, chiede un consenso più alto (+${Math.round(x.selectivity * 100)} punti)`; }
      if (x.note) { this.insight(x.note, now); this.e.log('MENTORE', `🔧 ${x.note}`); this.e.emit('ev', { type: 'correct', bot: X.id, text: x.note }); }
    }
    this.feed({ t: now, kind: 'close', who: X.id, symbol: tr.symbol, side: tr.side || 'LONG', pnl: tr.pnl, text: `${win ? 'chiuso in guadagno' : 'chiuso in perdita'} · ${tr.reason || ''}` });
    this.e.save();
  }
  corrections(now = Date.now()) {
    return EXEC_IDS.map((id) => ({ id, x: this.xState(id) })).filter(({ x }) => x.selectivity > 0 || x.restUntil > now).map(({ id, x }) => ({ bot: id, text: x.note || '', resting: x.restUntil > now }));
  }

  // ---------- vista per l'interfaccia
  view(now = Date.now()) {
    const e = this.e; const b = e.book; const s = this.st;
    const execs = EXECUTORS.map((X) => {
      const tr = b.trades.filter((t) => t.bot === X.id); const op = b.positions.filter((p) => p.bot === X.id);
      const realized = tr.reduce((a, t) => a + (t.pnl || 0), 0); const unreal = op.reduce((a, p) => a + (e.posValue(p) - p.costBase - p.feesBase + (p.realizedPart || 0)), 0);
      const wins = tr.filter((t) => t.pnl >= 0).length; const x = this.xState(X.id);
      return { id: X.id, name: X.name, role: X.role, desc: X.desc, hue: X.hue, domain: X.domain, thr: +(X.thr + x.selectivity).toFixed(2), baseThr: X.thr, minAgree: X.minAgree, paused: this.isPaused(X.id), resting: x.restUntil > now ? x.restUntil : 0, note: x.note,
        pnl: realized + unreal, realized, unrealized: unreal, trades: tr.length, wins, losses: tr.length - wins, winRate: tr.length ? (wins / tr.length) * 100 : null, open: op.length, exposure: op.reduce((a, p) => a + p.costBase * (p.lev || 1), 0),
        positions: op.map((p) => p.id), decision: s.decisions[X.id] || null, history: tr.slice(0, 10).map((t) => ({ symbol: t.symbol, side: t.side || 'LONG', lev: t.lev || 1, pnl: t.pnl, pnlPct: t.pnlPct, closedAt: t.closedAt, reason: t.reason })) };
    });
    const analysts = ANALYSTS.map((A) => {
      const a = this.aState(A.id); const sig = s.signals[A.id] && now - s.signals[A.id].t < 5 * 60e3 ? s.signals[A.id] : null;
      return { id: A.id, name: A.name, icon: A.icon, desc: A.desc, scope: A.perpOnly ? 'SOL/BTC/ETH' : A.spotOnly ? 'memecoin' : 'tutte', paused: this.isPaused(A.id), weight: a.weight || 1, hits: a.hits, n: a.n, hitRate: a.n ? (a.hits / a.n) * 100 : null, signal: sig };
    });
    const block = e.entryBlock(); const pb = e.perpBlock(); const sb = e.spotBlock(); const br = this.checkBreaker(now);
    const notional = b.positions.reduce((a, p) => a + p.costBase * (p.lev || 1), 0); const eq = e.equity();
    return { execs, analysts, coins: s.coins || [], coinsAt: s.coinsAt || null, maxCoins: MAX_COINS, feed: s.feed.slice(0, 40), insight: s.insight || null, corrections: this.corrections(now), breaker: br,
      risk: { maxTradePct: e.cfg.maxTradePct, maxOpen: e.cfg.maxOpen, dailyLossPct: e.cfg.dailyLossPct, maxExposurePct: e.cfg.maxExposurePct, open: b.positions.length, exposure: notional, exposurePct: eq > 0 ? (notional / eq) * 100 : 0, margin: b.positions.reduce((a, p) => a + p.costBase, 0),
        dayPnl: eq - (b.dayStartEquity || eq), dayPnlPct: b.dayStartEquity > 0 ? ((eq - b.dayStartEquity) / b.dayStartEquity) * 100 : 0 },
      realWaiting: block && e.cfg.mode === 'REAL' ? `REALE in attesa del test con 5-10 USDC: nessun ordine reale finché non approvi il test.${e.cfg.spotLongs ? ' Lo spot reale (solo long, 1x) è spento: si può attivare in Impostazioni.' : ''}` : null,
      realNote: !block && e.cfg.mode === 'REAL' && (pb || sb) ? (pb ? 'REALE: opera solo Omega (spot 1x long con swap veri su Jupiter). Leva e short (Alpha) in attesa del test con 5-10 USDC.' : 'REALE: opera solo Alpha (perps); spot reale spento.') : null,
      paused: Object.keys(s.paused).length };
  }
}
module.exports = { Desk, ANALYSTS, ANALYST_IDS, EXECUTORS, EXEC_IDS, BOT_IDS, MAX_COINS, MAX_ENTRIES_PER_TURN, RULES, OLD_BOTS, execFor };
