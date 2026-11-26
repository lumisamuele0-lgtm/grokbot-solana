'use strict';
// OSSERVATORIO GALATTICO: 14 bot indipendenti ("pianeti") che orbitano attorno al portafoglio ("sole").
// Ogni bot ha UNA strategia sua (8 di trend, 6 di contropiede) e opera da solo, con le stesse fasi e gli stessi limiti di
// rischio di sempre (scansione, verifica, flusso, scelta, dimensione 7%, stop prima della liquidazione, kill switch, limiti
// giornalieri, blocchi REALE). Il MENTORE ("faro") sceglie al massimo 3 cripto di "focus" fra tutte quelle scambiabili su
// Solana con Phantom/Jupiter che superano i filtri di sicurezza (memecoin comprese, con i controlli anti-truffa), e corregge i
// bot in difficoltà in modo limitato: più selettività dopo 2 perdite di fila, una pausa di 2 minuti dopo 3. Non cambia MAI
// margine, leva, stop o kill switch. Leva e short solo su SOL/BTC/ETH (Jupiter Perps); sulle altre cripto spot 1x solo long.
// Ogni bot si può mettere in pausa singolarmente. Nessun limite di tempo: si opera finché non premi Pausa.
const P = require('./perps');
const S = require('./strategy');
const K = require('./knowledge');
const U = require('./universe');

const MAX_COINS = 3; // cripto di focus scelte dal Mentore
const MAX_ENTRIES_PER_TURN = 2;
const RULES = { PICK_EVERY_MS: 5 * 60e3, SEL_MAX: 2, REST_MS: 2 * 60e3, BONUS_STEP: 0.15, BONUS_MAX: 0.3, ACTIVE_MS: 60 * 60e3 };
const clampCh = (x) => Math.max(-15, Math.min(15, Number(x) || 0));

// i 14 bot: nome del pianeta, strategia, stile (trend = segue il movimento, contra = contropiede sugli eccessi), colore base
const BOTS = [
  { id: 'nova', name: 'Nova', strategy: null, stratName: 'Trend EMA 9/21 + flusso', style: 'trend', hue: 158 },
  { id: 'orione', name: 'Orione', strategy: 'ema_adx', style: 'trend', hue: 172 },
  { id: 'vega', name: 'Vega', strategy: 'donchian', style: 'trend', hue: 188 },
  { id: 'lyra', name: 'Lyra', strategy: 'macd', style: 'trend', hue: 202 },
  { id: 'atlante', name: 'Atlante', strategy: 'vwap', style: 'trend', hue: 216 },
  { id: 'sirio', name: 'Sirio', strategy: 'squeeze', style: 'trend', hue: 230 },
  { id: 'titano', name: 'Titano', strategy: 'supertrend', style: 'trend', hue: 246 },
  { id: 'zefiro', name: 'Zefiro', strategy: 'roc', style: 'trend', hue: 262 },
  { id: 'selene', name: 'Selene', strategy: null, stratName: 'Contropiede RSI + bande', style: 'contra', hue: 280 },
  { id: 'andromeda', name: 'Andromeda', strategy: 'rsi_bb', style: 'contra', hue: 296 },
  { id: 'polaris', name: 'Polaris', strategy: 'rsi2', style: 'contra', hue: 312 },
  { id: 'nebula', name: 'Nebula', strategy: 'funding', style: 'contra', hue: 328 },
  { id: 'aurora', name: 'Aurora', strategy: 'fng', style: 'contra', hue: 34 },
  { id: 'calipso', name: 'Calipso', strategy: 'lsratio', style: 'contra', hue: 48 },
];
const BOT_IDS = BOTS.map((b) => b.id);
const STYLE_TXT = { trend: 'trend e momentum', contra: 'contropiede sugli eccessi' };
// vecchie posizioni della partita a squadre: restano gestite e passano a un pianeta (migrazione senza perdite)
const LEGACY = { A1: 'nova', A2: 'orione', A3: 'vega', A4: 'lyra', A5: 'atlante', A6: 'sirio', B1: 'selene', B2: 'andromeda', B3: 'polaris', B4: 'nebula', B5: 'aurora', B6: 'calipso' };

const coinView = (c, lev) => ({ mint: c.mint, symbol: c.symbol, name: c.name, icon: c.icon || null, perp: !!c.perp, market: c.market || null, color: c.color || U.coinColor(c.mint, c.symbol), phantom: !!c.phantom, meme: !!c.meme, label: U.offer(c, lev).label });

class Galaxy {
  constructor(engine) {
    this.e = engine;
    this.migrate();
  }
  get st() { const e = this.e; if (!e.st.galaxy) e.st.galaxy = newState(); return e.st.galaxy; }
  // dati vecchi: la partita a squadre sparisce dallo stato (lo storico resta in matches.json, intatto); posizioni e trade passano ai pianeti
  migrate() {
    const e = this.e; let ch = false;
    if (e.st.match) { delete e.st.match; ch = true; }
    if (!e.st.galaxy) { e.st.galaxy = newState(); ch = true; }
    const g = e.st.galaxy; for (const k of ['paused', 'bots']) if (!g[k] || typeof g[k] !== 'object') { g[k] = {}; ch = true; }
    if (!Array.isArray(g.focus)) { g.focus = []; ch = true; }
    for (const bk of Object.values(e.st.books || {})) {
      for (const p of [...(bk.positions || []), ...(bk.trades || [])]) {
        if (p.player !== undefined || p.team !== undefined || p.matchId !== undefined) {
          if (!p.bot && p.player && LEGACY[p.player]) p.bot = LEGACY[p.player];
          delete p.team; delete p.player; delete p.matchId; ch = true;
        }
      }
      for (const k of Object.keys(bk.cooldown || {})) if (/^[AB]:/.test(k)) { delete bk.cooldown[k]; ch = true; }
    }
    if (ch) e.save();
    return ch;
  }
  bot(id) { return BOTS.find((b) => b.id === id) || null; }
  botState(id) { const g = this.st; if (!g.bots[id]) g.bots[id] = { losses: 0, wins: 0, selectivity: 0, restUntil: 0, bonus: 0, note: null }; return g.bots[id]; }
  isPaused(id) { return !!this.st.paused[id]; }
  setPaused(id, paused) {
    if (!this.bot(id)) throw new Error('Bot sconosciuto');
    if (paused) this.st.paused[id] = true; else delete this.st.paused[id];
    this.e.save();
    this.e.log('OSSERVATORIO', `${this.bot(id).name} ${paused ? 'in pausa (le sue posizioni aperte restano gestite)' : 'riattivato'}`);
    return !!paused;
  }
  live() { return !!this.e.cfg.trading; }

  // ---------- cripto di focus (max 3) scelte dal MENTORE
  candidates() {
    const e = this.e; let pool = e.universe ? e.universe.eligible() : [];
    if (!pool.length) pool = Object.entries(P.SHORT_MARKETS).map(([mint, sym]) => { const st = e.market.stats[mint] || {}; return { mint, symbol: sym, name: U.PERP_INFO[sym].name, perp: true, market: sym, color: U.coinColor(mint), volume24h: st.volume24h || 1e8, change1h: st.change1h, change24h: st.change24h, icon: st.icon || null }; });
    if (!e.cfg.spotLongs) pool = pool.filter((c) => c.perp);
    pool = pool.filter((c) => !this.unsafe(c)); // scartate dal controllo on-chain/RugCheck: fuori dal focus
    const perpOk = !e.perpBlock(), spotOk = !e.spotBlock();
    if (perpOk !== spotOk) { const f = pool.filter((c) => (c.perp ? perpOk : spotOk)); if (f.length) pool = f; }
    return pool;
  }
  unsafe(c) { if (c.perp) return false; const sf = this.e.market.safety[c.mint]; return !!(sf && S.safetyRules(sf, this.e.cfg, false).length); }
  // punteggio di una cripto: volume, movimento utile a entrambi gli stili, strategie studiate e notizie sui mercati principali
  coinScore(c) {
    const r = this.e.research;
    const ch1 = clampCh(c.change1h), ch6 = clampCh(c.change6h), ch5 = clampCh(c.change5m);
    let s = 0.5 * Math.max(0, Math.log10(Math.max(1e5, c.volume24h || 0)) - 5) + (c.phantom ? 0.3 : 0) + (c.perp ? 0.3 : 0);
    const trend = c.perp ? (Math.abs(ch1) + Math.abs(ch6) * 0.3) / 2 : (Math.max(0, ch1) + Math.max(0, ch6) * 0.3) / 2 - Math.max(0, -ch1) * 0.3;
    const contra = c.perp ? Math.abs(ch1) * 0.4 + Math.abs(ch5) * 0.3 : Math.max(0, -ch1) * 0.5 + Math.max(0, -ch5) * 0.3 - Math.max(0, ch1 - 8) * 0.2;
    s += Math.max(trend, contra);
    if (c.perp && c.market && r) {
      try {
        for (const side of ['LONG', 'SHORT']) s += 0.5 * r.signalFor(c.market, side).score;
        const nw = r.newsFor(c.market); s += Math.abs(nw.sentiment) * 0.3 - nw.risk * 0.5;
      } catch { /* ricerca non pronta */ }
    }
    return s;
  }
  pickFocus(now = Date.now(), announce = true) {
    const e = this.e; const g = this.st; const lev = e.leverage();
    const held = new Set(e.book.positions.map((p) => p.mint));
    const scored = this.candidates().map((c) => ({ c, s: this.coinScore(c) })).sort((a, b) => b.s - a.s);
    const prev = g.focus || []; const chosen = [];
    for (const c of prev) if (held.has(c.mint) && chosen.length < MAX_COINS) chosen.push(c); // mai cambiare una cripto con posizioni aperte
    const cut = scored[Math.min(MAX_COINS, scored.length) - 1];
    for (const c of prev) { if (chosen.length >= MAX_COINS || chosen.some((x) => x.mint === c.mint)) continue; const r = scored.find((x) => x.c.mint === c.mint); if (r && cut && r.s >= cut.s - 0.5) chosen.push(c); } // isteresi
    for (const { c } of scored) { if (chosen.length >= MAX_COINS) break; if (!chosen.some((x) => x.mint === c.mint)) chosen.push(c); }
    const before = prev.map((c) => c.mint).join(',');
    g.focus = chosen.slice(0, MAX_COINS).map((c) => coinView(c, lev)); g.focusAt = now;
    if (announce && g.focus.map((c) => c.mint).join(',') !== before && g.focus.length) {
      const txt = g.focus.map((c) => `${c.symbol} (${c.label})`).join(', ');
      this.insight(`Focus su ${txt}`, now);
      e.log('MENTORE', `🔭 cripto di focus: ${txt}`);
    }
    return g.focus;
  }
  focusMints() { return (this.st.focus || []).map((c) => c.mint); }
  insight(text, now = Date.now()) { this.st.insight = { t: now, text }; this.e.emit('ev', { type: 'beacon', text }); }

  // ---------- giro dell'orologio (ogni secondo)
  tick(now = Date.now()) {
    const g = this.st; const uts = this.e.universe ? this.e.universe.ts : 0;
    const held = (mint) => this.e.book.positions.some((p) => p.mint === mint);
    const f = g.focus || [];
    if (!f.length || (f.some((x) => this.unsafe(x) && !held(x.mint)) && now - (g.focusAt || 0) > 10e3) || now - (g.focusAt || 0) >= RULES.PICK_EVERY_MS
      || (uts > (g.focusAt || 0) && (f.length < MAX_COINS || f.every((x) => x.perp)) && now - (g.focusAt || 0) > 30e3)) this.pickFocus(now, true);
    for (const id of BOT_IDS) { const b = this.botState(id); if (b.restUntil && b.restUntil <= now) { b.restUntil = 0; b.note = null; } }
  }

  // trade chiuso: il MENTORE corregge il bot (limitato): più selettivo dopo 2 perdite, pausa di 2 minuti dopo 3
  onClose(tr, now = Date.now()) {
    if (!tr || !tr.bot || !this.bot(tr.bot)) return;
    const b = this.botState(tr.bot); const B = this.bot(tr.bot);
    if (tr.pnl >= 0) {
      b.wins++; b.losses = 0; b.bonus = Math.min(RULES.BONUS_MAX, b.bonus + RULES.BONUS_STEP);
      if (b.selectivity > 0) b.selectivity--;
      if (!b.selectivity) b.note = null;
    } else {
      b.losses++; b.wins = 0; b.bonus = 0;
      if (b.losses >= 3) { b.restUntil = now + RULES.REST_MS; b.losses = 0; b.note = `${B.name}: 3 perdite di fila, 2 minuti di pausa per ricalibrare`; }
      else if (b.losses >= 2) { b.selectivity = Math.min(RULES.SEL_MAX, b.selectivity + 1); b.note = `${B.name}: 2 perdite di fila, entra solo con segnali più forti`; }
      if (b.note) { this.insight(b.note, now); this.e.log('MENTORE', `🔦 ${b.note}`); this.e.emit('ev', { type: 'correct', bot: tr.bot, text: b.note }); }
    }
    this.e.save();
  }
  // bot che il MENTORE sta correggendo (per il fascio del faro)
  corrections(now = Date.now()) {
    return BOT_IDS.map((id) => ({ id, b: this.botState(id) })).filter(({ b }) => b.selectivity > 0 || b.restUntil > now).map(({ id, b }) => ({ bot: id, text: b.note || '', resting: b.restUntil > now }));
  }

  // ---------- turno: ogni bot valuta le cripto di focus con la sua strategia; entrano i migliori (max 2 per giro)
  async turn(now = Date.now()) {
    const e = this.e; const cfg = e.cfg; const b = e.book;
    if (b.killed) return []; // kill switch: nessun ingresso finché non riarmi
    if (!this.st.focus || !this.st.focus.length) this.pickFocus(now, false);
    const focus = this.st.focus || [];
    e.agent('SCANSIONE', `focus del Mentore: ${focus.map((x) => x.symbol).join(', ') || '—'} (max ${MAX_COINS} cripto) · ${BOT_IDS.length - Object.keys(this.st.paused).length} bot attivi`, 'scan');
    const perpBlk = e.perpBlock(), spotBlk = e.spotBlock();
    const cands = []; const cache = {};
    for (const B of BOTS) {
      if (this.isPaused(B.id)) continue;
      const bs = this.botState(B.id); if (bs.restUntil > now) continue;
      if (b.positions.some((p) => p.bot === B.id)) continue; // una posizione alla volta per bot
      for (const coin of focus) {
        const mint = coin.mint; const asset = coin.symbol;
        for (const side of coin.perp ? ['LONG', 'SHORT'] : ['LONG']) { // short e leva solo sui mercati Jupiter Perps
          if (coin.perp ? perpBlk : spotBlk) continue;
          if (coin.perp && side === 'LONG' && !cfg.perpLongs) continue;
          if (coin.perp && side === 'SHORT' && !cfg.shortsOn) continue;
          if (!coin.perp && !cfg.spotLongs) continue;
          if (!coin.perp && !e.watch.has(mint)) continue; // spot: solo dopo i controlli di VERIFICA (RugCheck, autorità, liquidità)
          const candles = e.market.candles[mint]; if (!candles) continue;
          if (b.positions.some((p) => p.mint === mint && (p.side || 'LONG') === side)) continue; // mai due posizioni uguali (stesso conto on-chain)
          const cdKey = `${B.id}:${mint}:${side}`; if (b.cooldown[cdKey] && b.cooldown[cdKey] > now) continue;
          if (!cache[mint]) { const st = e.market.stats[mint] || {}; cache[mint] = { a: S.analyze(candles), rev: S.reversion(candles), st, f: st.buys1h != null ? S.flowScore(st) : { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 } }; }
          const { a, rev, st, f } = cache[mint]; if (!a.ok) continue;
          const s = { ...st, symbol: asset }; const d = side === 'SHORT' ? -1 : 1;
          const contra = B.style === 'contra';
          const sig = contra ? { ...rev[side] }
            : side === 'SHORT' ? { signal: a.short.signal, conf: a.short.confidence, score: a.short.score, reason: a.short.reason, checks: a.short.checks } : { signal: a.signal === 'LONG', conf: a.confidence, score: a.score, reason: a.reason, checks: a.checks };
          // la strategia del bot (studiata dal MENTORE con backtest) conta sui mercati perps; i bot "base" usano solo il loro segnale
          const rs = coin.perp && B.strategy ? e.research.signalFor(asset, side, [B.strategy]) : { score: 0, against: 0, strategies: [], opposite: [], atrPct: null };
          const feat = [...K.featuresOf({ s, a, f, core: coin.perp, solMom60: e.solMom60(), side: side === 'SHORT' ? 'short' : 'long' }), coin.perp ? `${side === 'SHORT' ? 'short.' : ''}leva:${e.leverage()}x` : 'spot:1x', ...rs.strategies.map((id) => (side === 'SHORT' ? 'short.' : '') + 'strat:' + id)];
          const kn = K.assess(e.kb, feat);
          const flowW = contra ? 0.3 : 1;
          const x = { m: mint, s, a, f, feat, kn, rs, side, sig, B, bs, coin, contra, conf: sig.conf, total: sig.score + d * f.score * flowW + kn.adj + rs.score - rs.against + bs.bonus };
          e.mentorGate(x);
          if (rs.against >= 1 && rs.against > rs.score && !x.block) x.block = 'strategia contraria';
          cands.push(x);
        }
      }
    }
    if (!cands.length) { e.agent('CAPO', 'nessun mercato libero per i bot attivi (pausa, cooldown, posizioni o candele in caricamento)', 'idle'); return []; }
    const libOk = (x) => x.rs.score >= 1 && x.rs.against < 1;
    const sigOk = (x) => x.sig.signal || libOk(x);
    const flowOk = (x) => (x.contra ? (x.side === 'SHORT' ? x.f.score < 0.6 : x.f.score > -0.6) : x.side === 'SHORT' ? x.f.score < 0.2 : x.f.score > -0.2);
    const selOk = (x) => x.bs.selectivity === 0 || (x.bs.selectivity === 1 ? x.sig.conf >= 0.75 || libOk(x) : x.total >= 2 && (x.sig.conf >= 0.9 || libOk(x)));
    cands.sort((x, y) => y.total - x.total);
    const top = cands[0];
    e.agent('SOCIAL', `${top.B.name}: $${top.s.symbol} ${top.f.buys} acquisti / ${top.f.sells} vendite (1h)`, 'flow', { token: top.s.symbol, bot: top.B.id });
    const ok = cands.filter((x) => sigOk(x) && flowOk(x) && !x.kn.skip && !x.block && selOk(x));
    if (!ok.length) {
      const blocked = cands.find((x) => x.block && sigOk(x));
      e.agent('CAPO', blocked ? `${blocked.B.name}: ${blocked.block}` : `nessun segnale (${top.B.name} su $${top.s.symbol}: ${top.sig.reason || 'segnale debole'})`, 'idle', { token: top.s.symbol, bot: top.B.id });
      return [];
    }
    const opened = []; const usedBots = new Set(); const usedKeys = new Set();
    for (const best of ok) {
      if (opened.length >= MAX_ENTRIES_PER_TURN) break;
      const key = `${best.m}:${best.side}`; if (usedBots.has(best.B.id) || usedKeys.has(key)) continue;
      usedBots.add(best.B.id); usedKeys.add(key);
      const prev = e.actx; e.actx = { bot: best.B.id };
      try {
        const lev = best.coin.perp ? e.tradeLev(null) : 1;
        const passed = Object.values(best.sig.checks || {}).filter(Boolean).length;
        e.agent('CAPO', `${best.B.name} entra ${best.side === 'SHORT' ? 'SHORT ▼' : 'LONG ▲'}${best.coin.perp ? ` ${lev}x` : ' spot 1x'} su $${best.s.symbol}: ${passed}/${Object.keys(best.sig.checks || {}).length} condizioni${best.rs.strategies.length ? ' · strategia ' + best.rs.strategies.join(', ') : ''}`, 'pick', { token: best.s.symbol, side: best.side });
        e.log('OSSERVATORIO', `${best.B.name} (${this.stratLabel(best.B)}) sceglie $${best.s.symbol} ${best.side} · punteggio ${best.total.toFixed(2)} · fiducia ${(best.sig.conf * 100).toFixed(0)}%`);
        const pos = await e.enterTrade(best, { conf: best.sig.conf, fromLib: !best.sig.signal, bot: best.B.id, perp: best.coin.perp, lev: best.coin.perp ? lev : null });
        const p = (pos && pos.mint ? pos : null) || b.positions.find((q) => q.bot === best.B.id);
        if (p) { opened.push(p); e.emit('ev', { type: 'comet', bot: best.B.id, symbol: p.symbol, side: p.side || 'LONG', mint: p.mint }); }
      } finally { e.actx = prev; }
      if (b.killed) break;
    }
    return opened;
  }
  stratLabel(B) { if (!B.strategy) return B.stratName; const st = require('./strategies').STRATEGIES.find((s) => s.id === B.strategy); return st ? st.name : B.strategy; }

  // ---------- vista per l'interfaccia
  view(now = Date.now()) {
    const e = this.e; const b = e.book; const g = this.st;
    const share = Math.max(0, b.budget || 0) / BOTS.length;
    const corr = new Map(this.corrections(now).map((c) => [c.bot, c]));
    let strats = []; try { strats = e.research.summary().strategies; } catch { /* ricerca non pronta */ }
    const bots = BOTS.map((B) => {
      const tr = b.trades.filter((x) => x.bot === B.id); const op = b.positions.filter((p) => p.bot === B.id);
      const realized = tr.reduce((a, x) => a + (x.pnl || 0), 0);
      const unreal = op.reduce((a, p) => a + (e.posValue(p) - p.costBase - p.feesBase + (p.realizedPart || 0)), 0);
      const recent = tr.filter((x) => now - x.closedAt < RULES.ACTIVE_MS).length + op.length;
      const bs = this.botState(B.id); const c = corr.get(B.id);
      const sinfo = B.strategy ? (strats.find((s) => s.id === B.strategy) || null) : null;
      return { id: B.id, name: B.name, style: B.style, styleLabel: STYLE_TXT[B.style], strategy: B.strategy, strategyName: this.stratLabel(B), hue: B.hue,
        strategyDesc: sinfo ? sinfo.desc : (B.style === 'trend' ? 'Incrocio EMA 9/21, RSI e flusso di acquisti: entra quando il mercato corre' : 'RSI estremo fuori dalle bande di Bollinger: entra sul rientro dopo un eccesso'),
        strategyActive: sinfo ? sinfo.active : null, strategyOn: sinfo ? sinfo.activeOn : [],
        paused: this.isPaused(B.id), resting: bs.restUntil > now ? bs.restUntil : 0, selectivity: bs.selectivity, corrected: !!c, note: c ? c.text : null,
        capital: share + realized, share, pnl: realized + unreal, realized, unrealized: unreal, trades: tr.length, open: op.length, wins: tr.filter((x) => x.pnl >= 0).length, losses: tr.filter((x) => x.pnl < 0).length,
        activity: Math.min(1, recent / 6), positions: op.map((p) => p.id), last: tr[0] ? { symbol: tr[0].symbol, pnl: tr[0].pnl, closedAt: tr[0].closedAt, side: tr[0].side || 'LONG' } : null,
        history: tr.slice(0, 8).map((x) => ({ symbol: x.symbol, side: x.side || 'LONG', lev: x.lev || 1, pnl: x.pnl, pnlPct: x.pnlPct, closedAt: x.closedAt, reason: x.reason })) };
    });
    const block = e.entryBlock(); const pb = e.perpBlock(); const sb = e.spotBlock();
    return { bots, focus: g.focus || [], focusAt: g.focusAt || null, maxCoins: MAX_COINS, insight: g.insight || null, corrections: [...corr.values()],
      realWaiting: block && e.cfg.mode === 'REAL' ? `REALE in attesa del test con 5-10 USDC: nessun ordine reale finché non approvi il test.${e.cfg.spotLongs ? ' Lo spot reale (solo long, 1x) è spento: si può attivare in Impostazioni.' : ''}` : null,
      realNote: !block && e.cfg.mode === 'REAL' && (pb || sb) ? (pb ? 'REALE: solo spot 1x long con swap veri su Jupiter. Leva e short in attesa del test con 5-10 USDC.' : 'REALE: solo perps (spot reale spento).') : null,
      paused: Object.keys(g.paused).length };
  }
}
function newState() { return { focus: [], focusAt: 0, paused: {}, bots: {}, insight: null }; }
module.exports = { Galaxy, BOTS, BOT_IDS, MAX_COINS, MAX_ENTRIES_PER_TURN, RULES, LEGACY };
