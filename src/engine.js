'use strict';
// Motore del bot: 9 agenti in pipeline (LONG spot o con leva + SHORT su Jupiter Perps, leva 2x/5x/10x), esecuzione SIMULAZIONE (paper su quote reali Jupiter) o REALE.
const path = require('path');
const EventEmitter = require('events');
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { readJson, debounceWriter } = require('./store');
const { DEFAULTS, LEVERAGES, snapLeverage, sanitize, migrateConfig } = require('./config');
const { CORE, BASES, SOL, USDC } = require('./tokens');
const S = require('./strategy');
const K = require('./knowledge');
const P = require('./perps');
const { capitalBreakdown, fmtMoney } = require('./capital');
const { momentum, ema } = require('./indicators');
const jup = require('./jupiter');
const chain = require('./chain');
const { Market } = require('./market');
const { Research } = require('./research');
const { Mentor } = require('./mentor');
const { STRATEGIES } = require('./strategies');
const { uid, sleep, round } = require('./util');

const AGENTS = [
  { id: 'SCANSIONE', role: 'Scout · scopre i token', color: '#3B82F6', icon: 'scout', unit: 'analizzati' },
  { id: 'VERIFICA', role: 'Filtro · regole anti-rug', color: '#EAB308', icon: 'shield', unit: 'scartati' },
  { id: 'SOCIAL', role: 'Flusso · acquisti/vendite', color: '#EC4899', icon: 'social', unit: 'letti' },
  { id: 'CAPO', role: 'Analista · sceglie il trade', color: '#F97316', icon: 'brain', unit: 'valutati' },
  { id: 'DIMENSIONE', role: 'Dimensione · quanto investire', color: '#06B6D4', icon: 'scale', unit: 'calcoli' },
  { id: 'RISCHIO', role: 'Rischio · stop e limiti', color: '#EF4444', icon: 'risk', unit: 'bloccati' },
  { id: 'ESECUZIONE', role: 'Esecutore · swap su Jupiter', color: '#22C55E', icon: 'exec', unit: 'ordini' },
  { id: 'SORVEGLIANZA', role: 'Sorveglianza · posizioni', color: '#A855F7', icon: 'eye', unit: 'chiusi' },
  { id: 'MENTORE', role: 'Mentore · insegna a tutti i bot', color: '#E5E7EB', icon: 'book', unit: 'lezioni' },
];
const dayKey = () => new Date().toISOString().slice(0, 10);
const coreMints = new Set(CORE.map((t) => t.mint));
// posizione su Jupiter Perps (short, o long con leva)
const isPerp = (p) => !!(p && (p.perp || p.side === 'SHORT'));

function newBook(budget, cfg) {
  return { cash: budget, solReserve: cfg.feeReserveSol, positions: [], trades: [], startEquity: budget, budget, realizedPnl: 0, feesBase: 0,
    dayKey: dayKey(), dayStartEquity: budget, killed: false, killReason: null, equityHist: [], cooldown: {}, startedAt: Date.now(), wins: 0, losses: 0 };
}
function newCounters() {
  return { analyzed: 0, rejected: 0, approved: 0, rules: {}, agents: Object.fromEntries(AGENTS.map((a) => [a.id, 0])) };
}

const stratName = (id) => { const s = STRATEGIES.find((q) => q.id === id); return s ? s.name : id; };

class Engine extends EventEmitter {
  constructor({ dataDir, keystore }) {
    super();
    this.dataDir = dataDir;
    this.ks = keystore;
    const savedCfg = readJson(path.join(dataDir, 'config.json'), null);
    const mig = migrateConfig(savedCfg || {});
    this.cfg = { ...DEFAULTS, ...mig.cfg };
    this.cfgMigrated = !!savedCfg && mig.changed;
    this.cfg.trading = false; // dopo un riavvio si riparte sempre in pausa... salvo autostart
    const saved = readJson(path.join(dataDir, 'state.json'), null);
    this.st = saved || { books: {}, counters: newCounters(), agents: {}, log: [], userWallet: null, withdrawAddress: null, deposits: [], realTxs: [] };
    if (!this.st.books.SIM) this.st.books.SIM = newBook(this.cfg.budget, this.cfg);
    this.cfgWriter = debounceWriter(path.join(dataDir, 'config.json'), () => this.cfg, 300);
    this.stWriter = debounceWriter(path.join(dataDir, 'state.json'), () => this.st, 2000);
    // MENTORE: base di conoscenza condivisa, salvata su /data/knowledge.json
    this.kb = K.load(readJson(path.join(dataDir, 'knowledge.json'), null));
    this.kbWriter = debounceWriter(path.join(dataDir, 'knowledge.json'), () => this.kb, 1000);
    let boot = 0;
    for (const [mode, bk] of Object.entries(this.st.books)) for (const tr of [...(bk.trades || [])].reverse()) if (K.learn(this.kb, { id: tr.id, feat: tr.feat || [], pnlPct: tr.pnlPct, mode: tr.mode || mode })) boot++;
    if (boot) this.kbWriter.schedule();
    this.lastMentorIdle = 0;
    if (this.cfgMigrated) this.cfgWriter.flush(); // salva subito i nuovi parametri sul volume
    if (this.cfgMigrated) this.log('SISTEMA', `Parametri aggiornati: rischio ${this.cfg.maxTradePct}% per operazione, volume 24h min ${this.cfg.minVolume24hUsd} $, età min ${this.cfg.minPairAgeMin} min`);
    this.market = new Market((lvl, t) => this.log('SISTEMA', t, lvl));
    this.watch = new Map(); // mint -> {symbol, approvedAt}
    this.seen = {}; // mint -> ultimo controllo filtri
    this.busy = false; this.timers = []; this.bal = null; this.userBal = null; this.lastPriceOk = 0; this.lastErr = null;
    this.analysisRejectTs = {};
    // MENTORE · ricerca sul web: libreria di strategie con backtest walk-forward su dati reali gratuiti
    this.research = new Research({ dataDir, log: (a, t, l) => this.log(a, t, l), agent: (id, t, act, ex) => this.agent(id, t, act, ex), getCfg: () => this.cfg, getLev: () => this.leverage() });
    // MENTORE · diario post-mortem e correzioni automatiche (limitate, con rollback), salvati su /data/mentor.json
    this.mentor = new Mentor({ dataDir, log: (a, t, l) => this.log(a, t, l) });
    this.research.mentorStatus = () => this.mentor.publicSummary();
  }

  get conn() { return chain.connection(this.cfg.rpcUrl); }
  get book() { return this.st.books[this.cfg.mode]; }
  get base() { return BASES[this.cfg.baseCurrency]; }
  saveCfg() { this.cfgWriter.schedule(); }
  save() { this.stWriter.schedule(); }

  log(agent, text, level = 'info') {
    const e = { t: Date.now(), agent, level, text };
    this.st.log.push(e); if (this.st.log.length > 500) this.st.log.splice(0, this.st.log.length - 500);
    this.emit('ev', { type: 'log', ...e });
    this.save();
  }
  agent(id, text, action = 'work', extra = {}) {
    this.st.agents[id] = { text, t: Date.now(), action, ...extra };
    this.emit('ev', { type: 'agent', agent: id, action, text, ...extra });
    if (['fail', 'block', 'kill'].includes(action) && this.st.lastAgentLog !== id + text) { this.st.lastAgentLog = id + text; this.log(id, text, action === 'block' ? 'info' : 'warn'); }
  }
  bump(id, n = 1) { this.st.counters.agents[id] = (this.st.counters.agents[id] || 0) + n; }
  rule(label) { const r = this.st.counters.rules; r[label] = (r[label] || 0) + 1; }

  // ---------- prezzi e valutazioni
  priceBase(mint) {
    const u = this.market.usd(mint), b = this.market.usd(this.base.mint);
    return u && b ? u / b : null;
  }
  toUsd(xBase) { const b = this.market.usd(this.base.mint); return b ? xBase * b : null; }
  equity(book = this.book) {
    // capitale di trading: liquidità + valore posizioni − commissioni pagate in SOL fuori dalla valuta base
    return this.capital(book).total;
  }
  posValue(p) {
    if (isPerp(p)) return this.shortValueBase(p);
    const px = this.priceBase(p.mint); return px ? p.qty * px : p.costBase;
  }
  // Capitale totale / Disponibile / In posizioni (stessa contabilità di equity)
  capital(book = this.book) { return capitalBreakdown(book, (p) => this.posValue(p)); }
  // registra e mostra lo spostamento di soldi tra Disponibile e posizioni (delta = variazione reale della cassa)
  cashMove(kind, p, before, pnl = null) {
    const b = this.book; const base = this.cfg.baseCurrency; const delta = b.cash - before;
    const m = (x, sg) => fmtMoney(x, base, sg);
    const tag = `$${p.symbol}${isPerp(p) ? ` ${p.side} ${p.lev}x` : ''}`;
    const text = kind === 'open'
      ? `aperta posizione ${tag}: ${m(delta, true)} dal disponibile (resta ${m(b.cash)})`
      : `${kind === 'partial' ? 'presa parziale' : 'chiusa posizione'} ${tag}: ${m(delta, true)} rientrano nel disponibile${pnl != null ? ` (PnL ${m(pnl, true)})` : ''} · disponibile ${m(b.cash)}`;
    this.log(kind === 'open' ? 'DIMENSIONE' : 'SORVEGLIANZA', text);
    this.emit('ev', { type: 'cash', kind, symbol: p.symbol, id: p.id, delta, after: b.cash, pnl, mode: this.cfg.mode });
  }
  baseUsd() { return this.market.usd(this.base.mint) || (this.cfg.baseCurrency === 'USDC' ? 1 : null); }
  // valore netto di uno short se chiuso ora (collaterale + PnL − prestito − commissione di chiusura), in valuta base
  shortValueBase(p, now = Date.now()) {
    const px = this.market.usd(p.mint), bu = this.baseUsd();
    if (!px || !bu) return p.costBase;
    return P.shortState(p, px, now).valueUsd / bu;
  }
  posPrice(p) { return isPerp(p) ? this.market.usd(p.mint) : this.priceBase(p.mint); }

  // ---------- avvio
  start() {
    this.log('SISTEMA', `Avvio motore · modalità ${this.cfg.mode === 'SIM' ? 'SIMULAZIONE' : 'REALE'} · base ${this.cfg.baseCurrency}`);
    const every = (ms, fn) => { const run = async () => { try { await fn(); } catch (e) { this.lastErr = e.message; this.log('SISTEMA', `Errore: ${e.message}`, 'error'); } }; run(); this.timers.push(setInterval(run, ms)); };
    every(15000, () => this.priceTick());
    setTimeout(() => every(60000, () => this.scan()), 1500);
    this.loopTimer = setTimeout(() => this.cycleLoop(), 8000);
    every(30000, () => this.recordEquity());
    setTimeout(() => every(5 * 60000, () => this.mentorReview()), 20000);
    every(20000, () => this.refreshBalances());
    every(3600000, () => this.market.refreshEur());
    if (process.env.NO_RESEARCH !== '1') this.research.start();
    if (process.env.BOT_WALLET_PASSWORD && this.ks.exists()) {
      try { this.ks.unlock(process.env.BOT_WALLET_PASSWORD); this.log('SISTEMA', 'Portafoglio del bot sbloccato da variabile d\'ambiente'); } catch (e) { this.log('SISTEMA', `Sblocco automatico fallito: ${e.message}`, 'error'); }
    }
    if (process.env.BOT_AUTOSTART === '1') { this.cfg.trading = true; this.log('SISTEMA', 'Avvio automatico del trading (BOT_AUTOSTART=1)'); }
  }
  stop() { this.timers.forEach(clearInterval); clearTimeout(this.loopTimer); this.cfgWriter.flush(); this.stWriter.flush(); this.kbWriter.flush(); this.research.stop(); this.mentor.flush(); }
  async cycleLoop() {
    try { await this.cycle(); } catch (e) { this.log('SISTEMA', `Errore ciclo: ${e.message}`, 'error'); }
    this.loopTimer = setTimeout(() => this.cycleLoop(), this.cfg.cycleSec * 1000);
  }

  tradeMints() {
    const set = new Set([SOL, USDC, ...this.cfg.tokens, ...this.watch.keys()]);
    for (const b of Object.values(this.st.books)) for (const p of b.positions) set.add(p.mint);
    return [...set];
  }

  async priceTick() {
    await this.market.refreshPrices(this.tradeMints());
    this.lastPriceOk = Date.now();
    const b = this.book;
    if (b.dayKey !== dayKey()) { b.dayKey = dayKey(); b.dayStartEquity = this.equity(); }
    await this.monitor();
  }

  recordEquity() {
    const b = this.book; const eq = this.equity();
    if (!Number.isFinite(eq)) return;
    b.equityHist.push({ t: Date.now(), v: round(eq, 6) });
    if (b.equityHist.length > 2880) b.equityHist.splice(0, b.equityHist.length - 2880);
    this.save();
  }

  // ---------- SCANSIONE + VERIFICA: scoperta e filtri
  async scan() {
    const cfg = this.cfg;
    // sempre con leva: si lavora solo su SOL/BTC/ETH (Jupiter Perps); gli altri token solo se c'è ancora una posizione aperta da gestire
    const held = Object.values(this.st.books).flatMap((bk) => bk.positions.map((p) => p.mint));
    let mints = [...Object.keys(P.SHORT_MARKETS), ...held];
    const discovered = 0;
    mints = [...new Set(mints)].filter((m) => m !== this.base.mint && m !== USDC);
    this.agent('SCANSIONE', `scansione: SOL, BTC, ETH (leva ${this.leverage()}x)${held.length ? ` + ${held.length} posizioni da gestire` : ''}`, 'scan');
    await this.market.refreshStats(mints, coreMints);
    const shortMints = cfg.shortsOn || cfg.perpLongs ? Object.keys(P.SHORT_MARKETS).filter((m) => !mints.includes(m)) : [];
    if (shortMints.length) { try { await this.market.refreshStats(shortMints, coreMints); } catch (e) { this.log('SCANSIONE', `dati short: ${e.message}`, 'warn'); } }
    const now = Date.now();
    let newOnes = 0, rej = 0, ok = 0;
    for (const m of mints) {
      const s = this.market.stats[m];
      if (!s) continue;
      const prev = this.seen[m];
      const fresh = !prev || now - prev > 30 * 60000;
      const core = coreMints.has(m) || cfg.tokens.includes(m) && coreMints.has(m);
      s.core = core;
      const reasons = S.filterRules(s, cfg);
      if (!reasons.length && !core) {
        if (fresh || this.watch.has(m)) {
          const sf = await this.market.checkSafety(m, (x) => chain.mintInfo(this.conn, x));
          reasons.push(...S.safetyRules(sf, cfg, false));
        } else if (!this.watch.has(m)) continue;
      }
      if (fresh) {
        this.seen[m] = now; newOnes++;
        this.st.counters.analyzed++; this.bump('SCANSIONE');
        if (reasons.length) {
          this.st.counters.rejected++; this.bump('VERIFICA'); rej++;
          reasons.forEach((r) => this.rule(r.label));
          this.log('VERIFICA', `scartato $${s.symbol} - ${reasons.map((r) => r.label).join(', ')}`);
          this.agent('VERIFICA', `scartato $${s.symbol} - ${reasons[0].label}`, 'reject', { token: s.symbol });
        } else {
          this.st.counters.approved++; ok++;
          this.log('VERIFICA', `approvato $${s.symbol} · liq ${Math.round(s.liquidityUsd / 1000)}k · vol ${Math.round(s.volume24h / 1000)}k`);
          this.agent('VERIFICA', `approvato $${s.symbol}`, 'approve', { token: s.symbol });
        }
      }
      if (reasons.length) { if (this.watch.has(m) && !this.holding(m)) this.watch.delete(m); continue; }
      if (!P.SHORT_MARKETS[m] && !this.holding(m)) continue; // solo mercati con leva (o posizioni ancora aperte)
      if (!this.watch.has(m)) this.watch.set(m, { symbol: s.symbol, approvedAt: now, core });
    }
    for (const m of [...this.watch.keys()]) if (!P.SHORT_MARKETS[m] && !this.holding(m)) this.watch.delete(m);
    // limita la watchlist: core + meme più liquidi
    if (this.watch.size > cfg.maxWatch) {
      // ordine: token principali, poi ciò che il MENTORE ha visto funzionare, poi volume
      const kAdj = (m, core) => K.assess(this.kb, K.featuresOf({ s: this.market.stats[m] || {}, core, solMom60: this.solMom60() })).adj;
      const arr = [...this.watch.entries()].map((e) => [...e, kAdj(e[0], e[1].core)])
        .sort((a, b) => (b[1].core - a[1].core) || (b[2] - a[2]) || ((this.market.stats[b[0]] || {}).volume24h - (this.market.stats[a[0]] || {}).volume24h));
      for (const [m] of arr.slice(cfg.maxWatch)) if (!this.holding(m)) this.watch.delete(m);
    }
    this.agent('SCANSIONE', `${newOnes} nuovi controllati · ${ok} ok · ${rej} scartati · in osservazione ${this.watch.size}`, 'scan');
    this.save();
    // candele reali per la watchlist (rispettando i limiti gratuiti)
    const candleMints = new Set([...this.watch.keys(), ...(cfg.shortsOn || cfg.perpLongs ? Object.keys(P.SHORT_MARKETS) : [])]);
    for (const m of candleMints) {
      if (this.market.needsBackfill(m)) {
        try { await this.market.backfill(m); } catch (e) { this.log('SCANSIONE', `candele ${(this.watch.get(m) || { symbol: P.SHORT_MARKETS[m] }).symbol}: ${e.message}`, 'warn'); }
      }
    }
  }
  holding(mint) { return Object.values(this.st.books).some((b) => b.positions.some((p) => p.mint === mint)); }

  // ---------- ciclo decisionale
  async cycle() {
    if (!this.cfg.trading || this.busy) return;
    const b = this.book;
    if (b.killed) return;
    if (this.cfg.mode === 'REAL' && !this.ks.kp) { this.agent('RISCHIO', 'portafoglio bloccato: inserisci la password per operare', 'block'); return; }
    if (!this.lastPriceOk || Date.now() - this.lastPriceOk > 60000) { this.agent('RISCHIO', 'prezzi non aggiornati: attendo', 'block'); return; }
    this.busy = true;
    try { await this.pipeline(); } finally { this.busy = false; }
  }

  async pipeline() {
    const cfg = this.cfg; const b = this.book; const now = Date.now();
    // REALE: con la leva obbligatoria e i perps reali non ancora verificati, nessuna nuova operazione
    const block = this.entryBlock();
    if (block) {
      this.bump('RISCHIO'); this.agent('RISCHIO', block, 'block');
      if (now - (this.analysisRejectTs.REALBLOCK || 0) > 30 * 60000) { this.analysisRejectTs.REALBLOCK = now; this.log('RISCHIO', `${block} Le posizioni già aperte continuano a essere gestite.`, 'warn'); }
      return;
    }
    this.emit('ev', { type: 'pipe', step: 'start' });
    // SOCIAL + CAPO: nuovi ingressi solo con leva su SOL/BTC/ETH
    const cands = [];
    if (cfg.perpLongs) for (const m of Object.keys(P.SHORT_MARKETS)) {
      if (b.positions.some((p) => p.mint === m)) continue;
      if (b.cooldown[m] && b.cooldown[m] > now) continue;
      const c = this.market.candles[m]; if (!c) continue;
      const st = this.market.stats[m] || {};
      const s = { ...st, symbol: P.SHORT_MARKETS[m] };
      const a = S.analyze(c);
      const f = st.buys1h != null ? S.flowScore(st) : { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 };
      this.bump('SOCIAL'); this.bump('CAPO');
      const rs = this.research.signalFor(s.symbol, 'LONG'); // strategie studiate dal MENTORE
      const feat = a.ok ? [...K.featuresOf({ s, a, f, core: true, solMom60: this.solMom60() }), `leva:${this.leverage()}x`, ...rs.strategies.map((id) => 'strat:' + id)] : [];
      const kn = K.assess(this.kb, feat); // consiglio del MENTORE
      const x = { m, w: { symbol: s.symbol, core: true }, s, a, f, feat, kn, rs, side: 'LONG', total: (a.ok ? a.score : -9) + f.score + kn.adj + rs.score - rs.against };
      this.mentorGate(x);
      if (a.ok && rs.against >= 1 && rs.against > rs.score) x.block = `strategie contrarie (${rs.opposite.map(stratName).join(', ')})`;
      cands.push(x);
    }
    // SHORT: solo SOL/BTC/ETH (mercati Jupiter Perps), mai insieme a un long sullo stesso asset
    if (cfg.shortsOn) {
      const realBlocked = cfg.mode === 'REAL' && !P.REAL_SHORTS_ENABLED;
      const regime = this.solMom60();
      for (const m of Object.keys(P.SHORT_MARKETS)) {
        if (b.positions.some((p) => p.mint === m)) continue;
        if (b.cooldown[m] && b.cooldown[m] > now) continue;
        const c = this.market.candles[m]; if (!c) continue;
        const a = S.analyze(c);
        const st = this.market.stats[m] || {};
        const s = { ...st, symbol: P.SHORT_MARKETS[m] };
        const f = st.buys1h != null ? S.flowScore(st) : { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 };
        this.bump('CAPO');
        const rs = this.research.signalFor(s.symbol, 'SHORT');
        const feat = a.ok ? [...K.featuresOf({ s, a, f, core: true, solMom60: regime, side: 'short' }), `short.leva:${this.leverage()}x`, ...rs.strategies.map((id) => 'short.strat:' + id)] : [];
        const kn = K.assess(this.kb, feat);
        const x = { m, s, a, f, feat, kn, rs, side: 'SHORT', total: (a.ok ? a.short.score : -9) - f.score + kn.adj + rs.score - rs.against };
        this.mentorGate(x);
        const wants = a.ok && (a.short.signal || rs.score >= 1);
        if (a.ok && rs.against >= 1 && rs.against > rs.score) x.block = `strategie contrarie (${rs.opposite.map(stratName).join(', ')})`;
        if (wants && regime != null && regime > 1 && !rs.score && !x.block) x.block = 'Mercato SOL in rialzo';
        if (wants && realBlocked) {
          x.block = 'Short reali non attivi';
          if (now - (this.analysisRejectTs['R' + m] || 0) > 30 * 60000) { this.analysisRejectTs['R' + m] = now; this.log('RISCHIO', `segnale SHORT su $${s.symbol} ignorato in REALE · ${P.REAL_SHORTS_BLOCK_MSG}`, 'warn'); }
        }
        cands.push(x);
      }
    }
    if (!cands.length) { this.agent('CAPO', cfg.perpLongs || cfg.shortsOn ? 'nessun mercato pronto (candele in caricamento o in cooldown)' : 'long con leva e short spenti: nessun nuovo ingresso', 'idle'); return; }
    // segnale: analisi del CAPO, oppure strategie studiate dal MENTORE con punteggio ≥ 1 (solo se attive fuori campione)
    const libOk = (x) => x.rs && x.rs.score >= 1 && x.rs.against < 1;
    const sigOk = (x) => x.a.ok && ((x.side === 'SHORT' ? x.a.short.signal : x.a.signal === 'LONG') || libOk(x));
    const flowOk = (x) => (x.side === 'SHORT' ? x.f.score < 0.2 : x.f.score > -0.2);
    cands.sort((x, y) => y.total - x.total);
    const top = cands[0];
    this.agent('SOCIAL', `$${top.s.symbol}: ${top.f.buys} acquisti / ${top.f.sells} vendite (1h) · volume x${top.f.volAccel.toFixed(2)}`, 'flow', { token: top.s.symbol, score: top.f.score });
    await sleep(400);
    // il MENTORE può solo togliere setup storicamente perdenti: mai aggiungerne o aumentare la dimensione
    for (const x of cands) {
      if (sigOk(x) && flowOk(x) && x.kn.skip && now - (this.analysisRejectTs['K' + x.m] || 0) > 15 * 60000) {
        this.analysisRejectTs['K' + x.m] = now; this.rule('Mentore: pattern perdente'); this.bump('MENTORE');
        this.agent('MENTORE', `sconsiglio $${x.s.symbol}${x.side === 'SHORT' ? ' SHORT' : ''}: ${x.kn.reasons[0]}`, 'advise', { token: x.s.symbol, target: 'CAPO' });
        this.log('MENTORE', `sconsiglio $${x.s.symbol} · rendimento atteso ${x.kn.expected.toFixed(2)}% · ${x.kn.reasons.join(', ')}`);
      }
    }
    const best = cands.find((x) => sigOk(x) && flowOk(x) && !x.kn.skip && !x.block);
    // conteggia scarti dell'analisi (al massimo uno ogni 15 min per token)
    for (const x of cands) {
      if (x === best) continue;
      const key = (x.side === 'SHORT' ? 'S' : '') + x.m;
      if (now - (this.analysisRejectTs[key] || 0) > 15 * 60000) {
        this.analysisRejectTs[key] = now;
        const lbl = !x.a.ok ? 'Dati insufficienti' : x.block ? x.block : x.side === 'SHORT' ? (!sigOk(x) ? x.a.short.reason : 'Flusso in acquisto') : !sigOk(x) ? x.a.reason : 'Flusso negativo';
        this.rule(x.side === 'SHORT' ? 'Short: ' + lbl : lbl);
        this.log('CAPO', `scartato $${x.s.symbol}${x.side === 'SHORT' ? ' SHORT' : ''} - ${lbl}${x.a.ok ? ` (RSI ${x.a.rsi.toFixed(0)}, mom15 ${x.a.m15.toFixed(2)}%)` : ''}`);
      }
    }
    if (!best) {
      const t = top.a.ok ? `nessun segnale: migliore $${top.s.symbol} (RSI ${top.a.rsi.toFixed(0)}, ${top.a.reason || 'flusso negativo'})` : `dati insufficienti per $${top.s.symbol}`;
      this.agent('CAPO', t, 'idle', { token: top.s.symbol });
      return;
    }
    const a = best.a; const sym = best.s.symbol; const isShort = best.side === 'SHORT'; const core = isShort || coreMints.has(best.m);
    const checks = isShort ? a.short.checks : a.checks; const conf = isShort ? a.short.confidence : a.confidence;
    const passed = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
    const fromLib = !(isShort ? a.short.signal : a.signal === 'LONG'); // ingresso deciso dalle strategie studiate
    if (best.rs && best.rs.strategies.length) {
      const names = best.rs.strategies.map(stratName).join(', ');
      this.bump('MENTORE'); this.agent('MENTORE', `strategie studiate a favore di $${sym} ${isShort ? 'SHORT' : 'LONG'}: ${names}`, 'advise', { token: sym, target: 'CAPO' });
      this.log('MENTORE', `$${sym} ${isShort ? 'SHORT' : 'LONG'}: segnale da ${names} (punteggio ${best.rs.score.toFixed(2)}, testate fuori campione)${fromLib ? ' · il CAPO entra sul segnale delle strategie' : ''}`);
    }
    this.agent('CAPO', `scelto $${sym} ${isShort ? 'SHORT ▼' : 'LONG ▲'}: ${passed.length}/6 condizioni (RSI ${a.rsi.toFixed(0)}, mom15 ${a.m15 >= 0 ? '+' : ''}${a.m15.toFixed(2)}%), fiducia ${(conf * 100).toFixed(0)}%`, 'pick', { token: sym, side: best.side });
    if (best.kn.active) this.agent('MENTORE', best.kn.good.length ? `a favore di $${sym}: ${best.kn.good.slice(0, 2).map((g) => g.label).join(', ')}` : `$${sym}: nessun pattern storico forte, decide il CAPO`, 'advise', { token: sym, target: 'CAPO' });
    this.log('CAPO', isShort
      ? `$${sym} SHORT · ribasso: EMA9 ${a.ema9.toPrecision(5)} < EMA21 ${a.ema21.toPrecision(5)} · RSI ${a.rsi.toFixed(1)} · mom15 ${a.m15.toFixed(2)}% · ATR ${a.atrPct.toFixed(2)}% · flusso ${best.f.score.toFixed(2)}`
      : `$${sym} LONG · EMA9 ${a.ema9.toPrecision(5)} > EMA21 ${a.ema21.toPrecision(5)} · RSI ${a.rsi.toFixed(1)} · ATR ${a.atrPct.toFixed(2)}% · flusso ${best.f.score.toFixed(2)}`);
    await sleep(400);

    // RISCHIO: limiti globali
    await this.refreshBalances(true);
    const eq = this.equity();
    const lim = S.checkLimits({ equity: eq, startEquity: b.startEquity, dayStartEquity: b.dayStartEquity, openCount: b.positions.length, cfg });
    if (lim.kill) return this.killSwitch(lim.reason);
    if (!lim.canOpen) { this.bump('RISCHIO'); this.agent('RISCHIO', lim.reason, 'block'); return; }
    if (this.cfg.mode === 'REAL' && this.bal && this.bal.sol < Math.max(0.01, cfg.feeReserveSol * 0.5)) {
      this.bump('RISCHIO'); this.agent('RISCHIO', `SOL per commissioni insufficienti (${this.bal.sol.toFixed(4)})`, 'block'); return;
    }

    // DIMENSIONE
    const capital = Math.min(b.budget + b.realizedPnl, eq);
    const minTrade = this.cfg.baseCurrency === 'SOL' ? 0.01 : 2;
    const sz = S.sizePosition({ capital, cash: this.cash(), cfg, confidence: conf, atr: a.atrPct, core, minTrade });
    this.bump('DIMENSIONE');
    if (!sz.size) { this.agent('DIMENSIONE', sz.reason, 'block'); return; }
    const size = round(sz.size, this.base.decimals);
    // long con leva (perps) solo su SOL/BTC/ETH, solo se attivati, e in REALE solo quando i perps reali saranno verificati
    // ogni nuovo ingresso è con leva (minimo 5x): mai più acquisti spot
    const perpMarket = P.SHORT_MARKETS[best.m];
    if (!perpMarket) { this.agent('RISCHIO', `$${sym}: niente acquisti spot, solo operazioni con leva su SOL/BTC/ETH`, 'block', { token: sym }); return; }
    const perpLong = !isShort;
    const usePerp = true; const sideTxt = isShort ? 'SHORT' : 'LONG';
    const lev = this.leverage();
    this.agent('DIMENSIONE', usePerp
      ? `margine ${this.fmtBase(size)} su $${sym} ${sideTxt} ${lev}x · esposizione ${this.fmtBase(size * lev)} (${((size / capital) * 100).toFixed(1)}% del capitale come margine)`
      : `${this.fmtBase(size)} su $${sym} (${((size / capital) * 100).toFixed(1)}% del capitale${core ? '' : ', meme ×' + cfg.memeSizeMult})`, 'size', { token: sym, size });
    await sleep(400);

    // RISCHIO: piano
    const plan = S.riskPlan(fromLib && best.rs.atrPct ? best.rs.atrPct : a.atrPct, cfg, core);
    // correzioni del MENTORE: stop e target leggermente più larghi/stretti (0,8–1,3 / 1–1,4), sempre entro i limiti
    const tp = this.mentor.params(sym, sideTxt);
    if (tp.slMult !== 1 || tp.tpMult !== 1) {
      const hi = Math.min(cfg.slMaxPct, 6);
      plan.slPct = Math.max(Math.min(cfg.slMinPct, hi), Math.min(hi, plan.slPct * tp.slMult)); plan.tpPct = plan.slPct * cfg.rewardRisk * tp.tpMult; plan.trailPct = plan.slPct * 0.7;
      this.log('MENTORE', `$${sym} ${sideTxt}: applico le correzioni imparate · stop ×${tp.slMult.toFixed(2)} · target ×${tp.tpMult.toFixed(2)}`);
    }
    best.ctx = { ...this.research.marketContext(sym), atrPct: a.atrPct, conf, rs: best.rs ? +best.rs.score.toFixed(2) : 0, strategies: best.rs ? best.rs.strategies : [], fromLib, tpMult: tp.tpMult, tuneVer: tp.ver };
    if (usePerp) {
      const px = this.market.usd(best.m) || a.last;
      const liq = P.liquidationPrice({ entryPrice: px, side: sideTxt, ...P.openShortModel({ marginUsd: 100, lev, priceUsd: px }) });
      plan.slPct = S.shortStopCap(plan.slPct, px, liq); plan.tpPct = plan.slPct * cfg.rewardRisk;
      const sg = isShort ? ['+', '-'] : ['-', '+'];
      this.agent('RISCHIO', `${sideTxt.toLowerCase()} ${lev}x · stop ${sg[0]}${plan.slPct.toFixed(2)}% · target ${sg[1]}${plan.tpPct.toFixed(2)}% · liquidazione ~${sg[0]}${(Math.abs(liq - px) / px * 100).toFixed(1)}% (stop entro il 40%)`, 'plan', { token: sym, side: sideTxt });
    } else this.agent('RISCHIO', `spot 1x · stop -${plan.slPct.toFixed(2)}% · target +${plan.tpPct.toFixed(2)}% · trailing ${plan.trailPct.toFixed(2)}%`, 'plan', { token: sym });
    await sleep(400);

    // ESECUZIONE
    await this.openShort({ ...best, s: { ...best.s, symbol: perpMarket } }, size, plan, sideTxt);
  }

  cash() {
    const b = this.book;
    if (this.cfg.mode === 'SIM') return b.cash;
    return Math.max(0, b.cash);
  }
  fmtBase(x) { return `${(+x).toFixed(this.cfg.baseCurrency === 'SOL' ? 4 : 2)} ${this.cfg.baseCurrency}`; }

  async openPosition(c, size, plan) {
    const b = this.book; const cfg = this.cfg; const sym = c.s.symbol; const cashBefore = b.cash;
    const sizeRaw = BigInt(Math.floor(size * 10 ** this.base.decimals));
    this.agent('ESECUZIONE', `richiedo quote Jupiter ${this.fmtBase(size)} → $${sym}`, 'quote', { token: sym });
    let q;
    try { q = await jup.quote(this.base.mint, c.m, sizeRaw, cfg.slippageBps); }
    catch (e) { this.agent('ESECUZIONE', `quote fallita: ${e.message}`, 'fail', { token: sym }); b.cooldown[c.m] = Date.now() + 5 * 60000; return; }
    const impact = Number(q.priceImpactPct || 0) * 100;
    if (impact > cfg.maxPriceImpactPct) {
      const l = `Impatto > ${cfg.maxPriceImpactPct}%`; this.rule(l); this.bump('RISCHIO');
      this.agent('RISCHIO', `bloccato $${sym}: impatto prezzo ${impact.toFixed(2)}%`, 'block', { token: sym });
      b.cooldown[c.m] = Date.now() + 10 * 60000; return;
    }
    const dec = c.s.decimals || (this.market.safety[c.m] && this.market.safety[c.m].decimals) || (CORE.find((t) => t.mint === c.m) || {}).decimals || q.outputDecimals;
    const decimals = dec != null ? dec : await chain.mintInfo(this.conn, c.m).then((x) => x.decimals);
    let qtyRaw, spent, feeBase, sig = null;
    if (cfg.mode === 'SIM') {
      qtyRaw = BigInt(q.outAmount); spent = size;
      const feeSol = (5000 + cfg.simPriorityLamports) / LAMPORTS_PER_SOL;
      feeBase = this.solToBase(feeSol);
      b.cash -= spent + feeBase; b.solReserve -= feeSol;
    } else {
      this.agent('ESECUZIONE', `firmo e invio lo swap $${sym}…`, 'swap', { token: sym });
      const r = await this.realSwap(q);
      if (!r.ok) { this.agent('ESECUZIONE', `swap fallito: ${r.err}`, 'fail', { token: sym }); b.cooldown[c.m] = Date.now() + 10 * 60000; return; }
      sig = r.sig;
      qtyRaw = r.deltas ? r.deltas.tokenDeltas[c.m] || BigInt(q.outAmount) : BigInt(q.outAmount);
      spent = r.spentBase != null ? r.spentBase : size;
      feeBase = this.solToBase(r.feeSol);
      if (this.cfg.baseCurrency === 'USDC') b.extFees = (b.extFees || 0) + feeBase;
      await this.refreshBalances(true);
    }
    const qty = Number(qtyRaw) / 10 ** decimals;
    const entry = spent / qty;
    const pos = { id: uid(), mint: c.m, symbol: sym, decimals, qtyRaw: qtyRaw.toString(), qty, costBase: spent, entryPrice: entry, highest: entry,
      slPct: plan.slPct, tpPct: plan.tpPct, trailPct: plan.trailPct, openedAt: Date.now(), feesBase: feeBase, sigOpen: sig, impactPct: impact, core: coreMints.has(c.m), feat: c.feat || [], atrPct: plan.atrPct != null ? plan.atrPct : (c.a && c.a.atrPct), initQty: qty, origCost: spent, origFees: feeBase };
    b.positions.push(pos); b.feesBase += feeBase;
    this.bump('ESECUZIONE');
    const t = `comprato $${sym} per ${this.fmtBase(spent)}`;
    this.agent('ESECUZIONE', t, 'buy', { token: sym, size: spent, sig });
    this.log('ESECUZIONE', `${t} · ${qty.toPrecision(6)} token @ ${entry.toPrecision(6)} · impatto ${impact.toFixed(3)}%${sig ? ' · ' + sig : ' · (simulato su quote reale)'}`);
    this.cashMove('open', pos, cashBefore);
    this.emit('ev', { type: 'trade', side: 'BUY', symbol: sym, amount: spent, sig, mode: cfg.mode });
    if (sig) this.realTx('BUY ' + sym, sig);
    this.save();
  }

  // messaggio se in questa modalità non si possono aprire nuove operazioni (null = si può)
  entryBlock() {
    if (this.cfg.mode === 'REAL' && !P.REAL_SHORTS_ENABLED) return P.REAL_ENTRY_BLOCK_MSG;
    return null;
  }
  leverage() { return Math.min(P.MAX_LEV, snapLeverage(this.cfg.leverage)); } // 2x / 5x / 10x, limite rigido 10x

  // ---------- SHORT (Jupiter Perps: collaterale USDC, esecuzione al prezzo dell'oracolo da parte dei keeper)
  // apre una posizione perps (side 'SHORT' o 'LONG' con leva); in REALE bloccata finché i perps reali non sono verificati
  async openShort(c, margin, plan, side = 'SHORT') {
    const b = this.book; const cfg = this.cfg; const sym = c.s.symbol;
    if (cfg.mode === 'REAL' && !P.REAL_SHORTS_ENABLED) { this.bump('RISCHIO'); this.agent('RISCHIO', 'perps reali (short/leva) non ancora attivi: resto solo LONG spot', 'block', { token: sym }); this.log('RISCHIO', P.REAL_SHORTS_BLOCK_MSG, 'warn'); return; }
    const px = this.market.usd(c.m), bu = this.baseUsd();
    if (!px || !bu) { this.agent('ESECUZIONE', `prezzo $${sym} non disponibile: short annullato`, 'fail', { token: sym }); return; }
    const lev = this.leverage(); const now = Date.now();
    this.agent('ESECUZIONE', `apro ${side} ${lev}x su $${sym} (Jupiter Perps)…`, 'quote', { token: sym, side });
    const m = P.openShortModel({ marginUsd: margin * bu, lev, priceUsd: px });
    const feeSol = (5000 + cfg.simPriorityLamports) / LAMPORTS_PER_SOL; const feeBase = this.solToBase(feeSol);
    const cashBefore = b.cash; b.cash -= margin + feeBase; b.solReserve -= feeSol;
    const pos = { id: uid(), side, perp: true, market: P.SHORT_MARKETS[c.m], lev, mint: c.m, symbol: sym, decimals: 6, qtyRaw: '0', qty: m.sizeUsd / px, initQty: m.sizeUsd / px,
      costBase: margin, origCost: margin, feesBase: feeBase, origFees: feeBase, entryPrice: px, highest: px, sizeUsd: m.sizeUsd, initSizeUsd: m.sizeUsd, collateralUsd: m.collateralUsd,
      openFeeUsd: m.openFeeUsd, perpFeesUsd: m.openFeeUsd, borrowUsd: 0, lastAccrual: now, slPct: plan.slPct, tpPct: plan.tpPct, trailPct: plan.trailPct, openedAt: now, sigOpen: null,
      core: true, feat: c.feat || [], atrPct: c.a && c.a.atrPct, ctx: c.ctx || null, tpMult: (c.ctx && c.ctx.tpMult) || 1, mfe: 0, mae: 0 };
    pos.liqPrice = P.liquidationPrice(pos);
    pos.slPct = S.shortStopCap(pos.slPct, px, pos.liqPrice);
    b.positions.push(pos); b.feesBase += feeBase;
    this.bump('ESECUZIONE');
    const t = `${side} ${lev}x aperto su $${sym} · margine ${this.fmtBase(margin)} · esposizione $${m.sizeUsd.toFixed(2)}`;
    this.agent('ESECUZIONE', t, side === 'SHORT' ? 'short' : 'buy', { token: sym, size: margin, side });
    const dn = side === 'SHORT' ? 1 : -1;
    this.log('ESECUZIONE', `${t} @ ${px.toPrecision(6)} · liquidazione ${pos.liqPrice.toPrecision(6)} (${dn > 0 ? '+' : '−'}${((Math.abs(pos.liqPrice - px) / px) * 100).toFixed(1)}%) · stop ${(px * (1 + (dn * pos.slPct) / 100)).toPrecision(6)} · commissione apertura $${m.openFeeUsd.toFixed(4)} (0,06%) · (simulato su prezzo reale)`);
    this.cashMove('open', pos, cashBefore);
    this.emit('ev', { type: 'trade', side: side === 'SHORT' ? 'SHORT' : 'BUY', symbol: sym, amount: margin, lev, mode: cfg.mode });
    this.save();
  }
  // Ricompra (chiude) tutto o una parte dello short. PnL = collaterale + guadagno sul prezzo − prestito − commissione di chiusura.
  async closeShort(p, frac, reason, stage) {
    const b = this.book; const cfg = this.cfg;
    const px = this.market.usd(p.mint), bu = this.baseUsd();
    if (!px || !bu) { p.closing = false; this.log('SORVEGLIANZA', `chiusura short $${p.symbol} rinviata: prezzo non disponibile`, 'warn'); return; }
    p.closing = true;
    const now = Date.now(); const st = P.shortState(p, px, now);
    p.borrowUsd = st.borrowUsd; p.lastAccrual = now;
    let f = Math.min(1, Math.max(0, frac)); let partial = f < 0.999;
    const minTrade = cfg.baseCurrency === 'SOL' ? 0.01 : 2;
    if (partial) {
      const restVal = (st.valueUsd * (1 - f)) / bu, partVal = (st.valueUsd * f) / bu;
      if (restVal < minTrade) { partial = false; f = 1; }
      else if (partVal < minTrade * 0.5) { this.markStage(p, stage); p.closing = false; this.log('SORVEGLIANZA', `$${p.symbol} ${p.side === 'LONG' ? 'LONG' : 'SHORT'}: presa parziale troppo piccola, la salto (stop a pareggio attivo)`); this.save(); return; }
    }
    const sizePart = p.sizeUsd * f, collPart = p.collateralUsd * f, borrowPart = p.borrowUsd * f;
    const dir = p.side === 'LONG' ? 1 : -1; const lbl = p.side === 'LONG' ? `LONG ${p.lev}x` : 'SHORT';
    const gross = sizePart * dir * ((px - p.entryPrice) / p.entryPrice);
    const closeFee = (sizePart * P.FEES.closeBps) / 1e4;
    const outUsd = Math.max(0, collPart + gross - borrowPart - closeFee);
    const feeSol = (5000 + cfg.simPriorityLamports) / LAMPORTS_PER_SOL; const feeBase = this.solToBase(feeSol);
    const valueBase = outUsd / bu;
    const cashBefore = b.cash; b.solReserve -= feeSol; b.cash += valueBase - feeBase;
    const costPart = p.costBase * f, feePart = p.feesBase * f;
    const pnl = valueBase - costPart - feePart - feeBase;
    b.realizedPnl += pnl; b.feesBase += feeBase;
    p.perpFeesUsd = (p.perpFeesUsd || 0) + closeFee + borrowPart;
    const chg = ((px - p.entryPrice) / p.entryPrice) * 100;
    if (partial) {
      p.sizeUsd -= sizePart; p.collateralUsd -= collPart; p.borrowUsd -= borrowPart; p.costBase -= costPart; p.feesBase -= feePart; p.qty *= 1 - f;
      p.realizedPart = (p.realizedPart || 0) + pnl; p.partFees = (p.partFees || 0) + feeBase; p.partOut = (p.partOut || 0) + valueBase;
      (p.partials || (p.partials = [])).push({ t: now, stage, pct: Math.round(f * 100), change: chg, pnl, out: valueBase, sig: null });
      this.markStage(p, stage); p.liqPrice = P.liquidationPrice(p); p.closing = false;
      const t = `presa parziale ${Math.round(f * 100)}% su $${p.symbol} ${lbl} a ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · ${pnl >= 0 ? '+' : ''}${this.fmtBase(pnl)}`;
      this.bump('SORVEGLIANZA');
      this.agent('SORVEGLIANZA', t, 'partial', { token: p.symbol, pnl, side: p.side });
      this.log('SORVEGLIANZA', `${t}${stage === 1 && p.beStop ? ` · stop ${dir > 0 ? 'alzato' : 'abbassato'} a pareggio ${(dir > 0 ? p.beStop : 2 * p.entryPrice - p.beStop).toPrecision(6)}` : ''} · ${dir > 0 ? 'venduto' : 'ricomprato'} al prezzo reale (simulato)`);
      this.cashMove('partial', p, cashBefore, pnl);
      this.emit('ev', { type: 'trade', side: 'PARTIAL', symbol: p.symbol, amount: valueBase, pnl, pct: Math.round(f * 100), mode: cfg.mode, short: true });
      this.save(); return;
    }
    b.positions = b.positions.filter((x) => x !== p);
    const totalPnl = pnl + (p.realizedPart || 0); const origCost = p.origCost || p.costBase;
    if (totalPnl >= 0) b.wins++; else b.losses++;
    b.cooldown[p.mint] = now + cfg.cooldownMin * 60000;
    const nParts = (p.partials || []).length;
    const tr = { id: p.id, side: p.side, perp: true, lev: p.lev, symbol: p.symbol, mint: p.mint, openedAt: p.openedAt, closedAt: now, costBase: origCost, outBase: valueBase + (p.partOut || 0), pnl: totalPnl, pnlPct: (totalPnl / origCost) * 100,
      fees: (p.origFees != null ? p.origFees : p.feesBase) + (p.partFees || 0) + feeBase + p.perpFeesUsd / bu, perpFeesUsd: p.perpFeesUsd, entryPrice: p.entryPrice, exitPrice: px,
      reason: nParts ? `${reason} · ${nParts} ${nParts === 1 ? 'presa parziale' : 'prese parziali'}` : reason, partials: p.partials || [], sigOpen: null, sigClose: null, mode: cfg.mode, estimated: false, feat: p.feat || [], ...this.postFields(p) };
    b.trades.unshift(tr); if (b.trades.length > 500) b.trades.pop();
    this.mentorLearn(tr);
    this.bump('SORVEGLIANZA');
    const t = `${dir > 0 ? 'venduto' : 'ricomprato'} $${p.symbol} (chiuso ${p.side} ${p.lev}x) · ${tr.reason} · ${totalPnl >= 0 ? '+' : ''}${this.fmtBase(totalPnl)} (${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct.toFixed(2)}% sul margine)`;
    this.agent('SORVEGLIANZA', t, totalPnl >= 0 ? 'win' : 'loss', { token: p.symbol, pnl: totalPnl, side: p.side });
    this.log('SORVEGLIANZA', `${t} · commissioni perps $${p.perpFeesUsd.toFixed(4)} (apertura+chiusura 0,06% + prestito) · (simulato su prezzo reale)`);
    this.cashMove('close', p, cashBefore, totalPnl);
    this.emit('ev', { type: 'trade', side: 'SELL', symbol: p.symbol, amount: valueBase, pnl: totalPnl, mode: cfg.mode, short: true });
    this.save();
  }

  solToBase(sol) { if (this.cfg.baseCurrency === 'SOL') return sol; const s = this.market.usd(SOL), u = this.market.usd(USDC) || 1; return s ? (sol * s) / u : 0; }

  // ---------- SORVEGLIANZA
  async monitor() {
    const b = this.book; if (!b.positions.length) { this.agent('SORVEGLIANZA', 'nessuna posizione aperta', 'idle'); return; }
    const now = Date.now(); const lines = [];
    for (const p of [...b.positions]) {
      const px = this.posPrice(p); if (!px) continue;
      if (p.closing) continue;
      if (isPerp(p)) {
        // protezione extra: chiude molto prima della liquidazione (80% della distanza), qualunque cosa dicano le altre regole
        const st = P.shortState(p, px, now); p.liqPrice = st.liqPrice;
        const k = (px - p.entryPrice) / (st.liqPrice - p.entryPrice); // 0 = ingresso, 1 = liquidazione
        if (k >= 0.8) { await this.closeShort(p, 1, `Vicino alla liquidazione (${(((px - p.entryPrice) / p.entryPrice) * 100).toFixed(2)}%)`); continue; }
      }
      { const mv = ((p.side === 'SHORT' ? -1 : 1) * (px - p.entryPrice) / p.entryPrice) * 100; p.mfe = Math.max(p.mfe || 0, mv); p.mae = Math.min(p.mae || 0, mv); } // per il post-mortem
      const r = S.exitPlan(p, px, now, this.cfg, this.exitCtx(p));
      lines.push(`$${p.symbol}${p.side === 'SHORT' ? '▼' : ''}${isPerp(p) ? ' ' + p.lev + 'x' : ''} ${r.change != null ? (r.change >= 0 ? '+' : '') + r.change.toFixed(2) + '%' : ''}`);
      for (const ev of r.events || []) this.onTrail(p, ev);
      if (r.action === 'close') await this.sellPosition(p, 1, r.reason);
      else if (r.action === 'partial') await this.sellPosition(p, r.frac, r.reason, null, r.stage);
    }
    if (lines.length) this.agent('SORVEGLIANZA', `pattuglio ${b.positions.length} posizioni: ${lines.join(' · ')}`, 'patrol');
    const eq = this.equity();
    const lim = S.checkLimits({ equity: eq, startEquity: b.startEquity, dayStartEquity: b.dayStartEquity, openCount: 0, cfg: this.cfg });
    if (lim.kill && !b.killed) await this.killSwitch(lim.reason);
  }

  closePosition(p, reason, toMint) { return this.sellPosition(p, 1, reason, toMint); }

  // Vende tutta la posizione (frac = 1) o una parte (presa parziale). Contabilità:
  // la quota venduta realizza il suo PnL subito (realizedPnl, cassa); costo e commissioni d'ingresso
  // della parte rimasta restano "aperti". Il trade va nello storico (e al MENTORE) solo a chiusura completa,
  // con rendimento complessivo = parziali + ultima vendita.
  async sellPosition(p, frac, reason, toMint, stage) {
    if (isPerp(p)) return this.closeShort(p, frac, reason, stage);
    const b = this.book; const cfg = this.cfg; p.closing = true;
    const out = toMint || this.base.mint;
    try {
      let got, feeBase = 0, sig = null, estimated = false;
      let heldRaw = BigInt(p.qtyRaw);
      let qtyRaw = heldRaw;
      let partial = frac < 0.999;
      if (partial) {
        qtyRaw = (heldRaw * BigInt(Math.round(frac * 10000))) / 10000n;
        // niente "polvere": se il resto o la quota sono troppo piccoli, vende tutto o salta
        const px = this.priceBase(p.mint) || p.entryPrice;
        const minTrade = cfg.baseCurrency === 'SOL' ? 0.01 : 2;
        const restVal = (Number(heldRaw - qtyRaw) / 10 ** p.decimals) * px;
        const partVal = (Number(qtyRaw) / 10 ** p.decimals) * px;
        if (restVal < minTrade) { partial = false; qtyRaw = heldRaw; }
        else if (partVal < minTrade * 0.5 || qtyRaw <= 0n) { this.markStage(p, stage); p.closing = false; this.log('SORVEGLIANZA', `$${p.symbol}: presa parziale troppo piccola, la salto (stop a pareggio attivo)`); this.save(); return; }
      }
      if (cfg.mode === 'REAL') {
        await this.refreshBalances(true);
        const onchain = this.bal && this.bal.tokens[p.mint] ? this.bal.tokens[p.mint].raw : 0n;
        if (!partial && onchain < qtyRaw) qtyRaw = onchain;
        if (partial && onchain < heldRaw) { heldRaw = onchain; qtyRaw = (onchain * BigInt(Math.round(frac * 10000))) / 10000n; }
        if (qtyRaw <= 0n) { b.positions = b.positions.filter((x) => x !== p); this.log('SORVEGLIANZA', `$${p.symbol}: saldo on-chain zero, posizione rimossa`, 'warn'); return; }
      }
      const cashBefore = b.cash;
      let q;
      const slip = Math.min(1000, cfg.slippageBps * (1 + (p.failCount || 0)));
      try { q = await jup.quote(p.mint, out, qtyRaw, slip); } catch (e) {
        if (cfg.mode === 'SIM' && !partial && (p.failCount || 0) >= 2) { estimated = true; } else { p.failCount = (p.failCount || 0) + 1; p.closing = false; this.log('SORVEGLIANZA', `vendita $${p.symbol} rinviata: ${e.message}`, 'warn'); return; }
      }
      const soldUi = Number(qtyRaw) / 10 ** p.decimals;
      if (cfg.mode === 'SIM') {
        got = estimated ? soldUi * (this.priceBase(p.mint) || 0) * 0.99 : Number(q.outAmount) / 10 ** (out === this.base.mint ? this.base.decimals : 6);
        const feeSol = (5000 + cfg.simPriorityLamports) / LAMPORTS_PER_SOL; feeBase = this.solToBase(feeSol); b.solReserve -= feeSol; b.cash -= feeBase;
        if (out === this.base.mint) b.cash += got;
      } else {
        const r = await this.realSwap(q);
        if (!r.ok) { p.failCount = (p.failCount || 0) + 1; p.closing = false; this.agent('ESECUZIONE', `vendita $${p.symbol} fallita: ${r.err} (riprovo)`, 'fail'); return; }
        sig = r.sig; feeBase = this.solToBase(r.feeSol);
        if (this.cfg.baseCurrency === 'USDC') b.extFees = (b.extFees || 0) + feeBase;
        if (out === this.base.mint) got = r.receivedBase != null ? r.receivedBase : Number(q.outAmount) / 10 ** this.base.decimals;
        else got = r.deltas && r.deltas.tokenDeltas[out] != null ? Number(r.deltas.tokenDeltas[out]) / 1e6 : Number(q.outAmount) / 1e6; // USDC (kill switch)
        await this.refreshBalances(true);
      }
      const valueBase = out === this.base.mint ? got : (got * (this.market.usd(out) || 1)) / (this.market.usd(this.base.mint) || 1);
      // quota di costo e commissioni d'ingresso attribuita alla parte venduta
      const ratio = partial ? Math.min(1, Number(qtyRaw) / Number(heldRaw)) : 1;
      const costPart = p.costBase * ratio, feePart = p.feesBase * ratio;
      const pnl = valueBase - costPart - feePart - feeBase;
      b.realizedPnl += pnl; b.feesBase += feeBase;
      if (!p.origCost) p.origCost = p.costBase;
      if (partial) {
        p.costBase -= costPart; p.feesBase -= feePart;
        p.qtyRaw = (heldRaw - qtyRaw).toString(); p.qty = Number(heldRaw - qtyRaw) / 10 ** p.decimals;
        p.realizedPart = (p.realizedPart || 0) + pnl; p.partFees = (p.partFees || 0) + feeBase; p.partOut = (p.partOut || 0) + valueBase;
        const chg = ((this.priceBase(p.mint) || p.entryPrice) / p.entryPrice - 1) * 100;
        (p.partials || (p.partials = [])).push({ t: Date.now(), stage, pct: Math.round(ratio * 100), change: chg, pnl, out: valueBase, sig });
        this.markStage(p, stage);
        p.closing = false; p.failCount = 0;
        const t = `presa parziale ${Math.round(ratio * 100)}% su $${p.symbol} a ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · ${pnl >= 0 ? '+' : ''}${this.fmtBase(pnl)}`;
        this.bump('SORVEGLIANZA');
        this.agent('SORVEGLIANZA', t, 'partial', { token: p.symbol, pnl });
        this.log('SORVEGLIANZA', `${t}${stage === 1 && p.beStop ? ` · stop alzato a pareggio ${p.beStop.toPrecision(6)}` : ''}${sig ? ' · ' + sig : ' · (simulato su quote reale)'}`);
        this.cashMove('partial', p, cashBefore, pnl);
        this.emit('ev', { type: 'trade', side: 'PARTIAL', symbol: p.symbol, amount: valueBase, pnl, pct: Math.round(ratio * 100), sig, mode: cfg.mode });
        if (sig) this.realTx(`SELL ${Math.round(ratio * 100)}% ${p.symbol}`, sig);
        this.save();
        return;
      }
      b.positions = b.positions.filter((x) => x !== p);
      const totalPnl = pnl + (p.realizedPart || 0);
      const origCost = p.origCost || p.costBase;
      if (totalPnl >= 0) b.wins++; else b.losses++;
      b.cooldown[p.mint] = Date.now() + cfg.cooldownMin * 60000;
      const nParts = (p.partials || []).length;
      const tr = { id: p.id, symbol: p.symbol, mint: p.mint, openedAt: p.openedAt, closedAt: Date.now(), costBase: origCost, outBase: valueBase + (p.partOut || 0), pnl: totalPnl, pnlPct: (totalPnl / origCost) * 100,
        fees: (p.origFees != null ? p.origFees : p.feesBase) + (p.partFees || 0) + feeBase, reason: nParts ? `${reason} · ${nParts} ${nParts === 1 ? 'presa parziale' : 'prese parziali'}` : reason, partials: p.partials || [],
        sigOpen: p.sigOpen, sigClose: sig, mode: cfg.mode, estimated, feat: p.feat || [], side: 'LONG', entryPrice: p.entryPrice, exitPrice: this.priceBase(p.mint) || p.entryPrice, ...this.postFields(p) };
      b.trades.unshift(tr); if (b.trades.length > 500) b.trades.pop();
      this.mentorLearn(tr);
      this.bump('SORVEGLIANZA');
      const t = `venduto $${p.symbol} · ${tr.reason} · ${totalPnl >= 0 ? '+' : ''}${this.fmtBase(totalPnl)}${nParts ? ` (${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct.toFixed(2)}% complessivo)` : ''}`;
      this.agent('SORVEGLIANZA', t, totalPnl >= 0 ? 'win' : 'loss', { token: p.symbol, pnl: totalPnl });
      this.log('SORVEGLIANZA', `${t} (commissioni incluse)${sig ? ' · ' + sig : ''}${estimated ? ' · prezzo stimato' : ''}`);
      this.cashMove('close', p, cashBefore, totalPnl);
      this.emit('ev', { type: 'trade', side: 'SELL', symbol: p.symbol, amount: valueBase, pnl: totalPnl, sig, mode: cfg.mode });
      if (sig) this.realTx('SELL ' + p.symbol, sig);
      this.save();
    } catch (e) { p.closing = false; p.failCount = (p.failCount || 0) + 1; this.log('SORVEGLIANZA', `errore vendita $${p.symbol}: ${e.message}`, 'error'); }
  }
  // segna la presa come fatta; dopo la prima lo stop sale a pareggio (+ buffer commissioni)
  markStage(p, stage) {
    if (stage === 1) { p.tp1Done = true; const be = p.entryPrice * (1 + this.cfg.beBufferPct / 100); p.beStop = Math.max(p.beStop || 0, be); }
    if (stage === 2) p.tp2Done = true;
  }

  async killSwitch(reason) {
    const b = this.book; if (b.killed) return;
    b.killed = true; b.killReason = reason; this.cfg.trading = false; this.saveCfg();
    this.bump('RISCHIO');
    this.agent('RISCHIO', `KILL SWITCH: ${reason}. Vendo tutto e mi fermo.`, 'kill');
    this.log('RISCHIO', `KILL SWITCH attivato: ${reason}`, 'error');
    for (const p of [...b.positions]) await this.closePosition(p, 'Kill switch', this.cfg.mode === 'REAL' ? USDC : undefined);
    if (this.cfg.mode === 'REAL' && this.cfg.baseCurrency === 'SOL' && this.cfg.killConvertUsdc) {
      await this.refreshBalances(true);
      const free = this.bal.sol - this.cfg.feeReserveSol;
      if (free > 0.005) {
        try { const q = await jup.quote(SOL, USDC, BigInt(Math.floor(free * LAMPORTS_PER_SOL)), this.cfg.slippageBps); const r = await this.realSwap(q); if (r.ok) this.realTx('KILL SOL→USDC', r.sig); }
        catch (e) { this.log('RISCHIO', `conversione in USDC fallita: ${e.message}`, 'error'); }
      }
    }
    this.save();
  }

  // ---------- esecuzione reale
  async realSwap(q) {
    const kp = this.ks.kp; if (!kp) return { ok: false, err: 'portafoglio bloccato' };
    try {
      const owner = kp.publicKey.toBase58();
      const { tx, lastValidBlockHeight } = await jup.swapTx(q, owner, this.cfg.priorityFeeMaxLamports);
      tx.sign([kp]);
      const r = await chain.sendAndConfirm(this.conn, tx, lastValidBlockHeight);
      if (!r.ok) { if (r.sig) this.realTx('FALLITA', r.sig, r.err); return { ok: false, err: r.err, sig: r.sig }; }
      const d = await chain.txDeltas(this.conn, r.sig, owner);
      const out = { ok: true, sig: r.sig, deltas: d, feeSol: d ? d.fee / LAMPORTS_PER_SOL : 0.0001 };
      if (d) {
        const bm = this.base.mint;
        if (bm === SOL) {
          const net = (d.solDelta + d.fee) / LAMPORTS_PER_SOL; // esclude la commissione di rete
          if (q.inputMint === SOL) out.spentBase = -net; else out.receivedBase = net;
        } else {
          const dd = Number(d.tokenDeltas[bm] || 0n) / 10 ** this.base.decimals;
          if (q.inputMint === bm) out.spentBase = -dd; else out.receivedBase = dd;
        }
      }
      return out;
    } catch (e) { return { ok: false, err: e.message }; }
  }
  realTx(label, sig, err) {
    this.st.realTxs.unshift({ t: Date.now(), label, sig, err: err || null, url: `https://solscan.io/tx/${sig}` });
    if (this.st.realTxs.length > 300) this.st.realTxs.pop();
    this.log('ESECUZIONE', `TX REALE ${label}: https://solscan.io/tx/${sig}${err ? ' (errore: ' + err + ')' : ''}`, err ? 'error' : 'info');
  }

  async refreshBalances(force) {
    if (!force && this.balTs && Date.now() - this.balTs < 15000) return;
    const info = this.ks.info();
    if (info.exists) {
      try {
        this.bal = await chain.getBalances(this.conn, info.publicKey); this.balTs = Date.now();
        if (this.cfg.mode === 'REAL') {
          const b = this.book;
          b.cash = this.cfg.baseCurrency === 'SOL' ? Math.max(0, this.bal.sol - this.cfg.feeReserveSol) : (this.bal.tokens[USDC] ? this.bal.tokens[USDC].ui : 0);
        }
      } catch (e) { this.lastErr = `RPC: ${e.message}`; }
    }
    if (this.st.userWallet && (!this.userBalTs || Date.now() - this.userBalTs > 30000 || force)) {
      try { this.userBal = await chain.getBalances(this.conn, this.st.userWallet); this.userBalTs = Date.now(); } catch {}
    }
  }

  // ---------- azioni utente
  setConfig(patch) {
    const before = this.cfg;
    this.cfg = { ...sanitize(patch, this.cfg), mode: before.mode, trading: before.trading };
    if (this.cfg.baseCurrency !== before.baseCurrency) {
      if (before.trading) throw new Error('Metti in pausa il bot prima di cambiare la valuta base');
      if (Object.values(this.st.books).some((b) => b.positions.length)) { this.cfg.baseCurrency = before.baseCurrency; throw new Error('Chiudi le posizioni prima di cambiare la valuta base'); }
      this.st.books.SIM = newBook(this.cfg.budget, this.cfg);
      if (this.st.books.REAL) this.st.books.REAL = null;
    }
    if (this.cfg.budget !== before.budget && this.cfg.mode === 'SIM' && !this.book.positions.length && !this.book.trades.length) this.st.books.SIM = newBook(this.cfg.budget, this.cfg);
    if (this.st.books.REAL) this.st.books.REAL.budget = this.cfg.budget;
    this.saveCfg(); this.save();
    this.log('SISTEMA', 'Impostazioni aggiornate');
  }
  setTrading(on) {
    if (on && this.book.killed) throw new Error('Kill switch attivo: riarma il bot prima di ripartire');
    if (on && this.cfg.mode === 'REAL' && !this.ks.kp) throw new Error('Sblocca il portafoglio del bot con la password');
    this.cfg.trading = !!on; this.saveCfg();
    this.log('SISTEMA', on ? 'Trading AVVIATO' : 'Trading in PAUSA');
    this.emit('ev', { type: 'trading', on: !!on });
  }
  resetSim() {
    if (this.cfg.mode === 'SIM') this.cfg.trading = false;
    this.st.books.SIM = newBook(this.cfg.budget, this.cfg);
    this.st.counters = newCounters(); this.st.agents = {}; this.seen = {}; this.analysisRejectTs = {};
    this.save(); this.saveCfg(); this.log('SISTEMA', `Nuova sessione di SIMULAZIONE con ${this.fmtBase(this.cfg.budget)}`);
  }
  rearm() {
    const b = this.book; b.killed = false; b.killReason = null; b.startEquity = this.equity(); b.dayStartEquity = b.startEquity;
    this.log('RISCHIO', `Bot riarmato. Nuovo capitale di riferimento ${this.fmtBase(b.startEquity)}`); this.save();
  }
  async setMode(mode, confirmText) {
    if (mode === this.cfg.mode) return;
    if (this.book.positions.length) throw new Error('Chiudi le posizioni aperte prima di cambiare modalità');
    if (mode === 'REAL') {
      if (confirmText !== 'ATTIVA REALE') throw new Error('Scrivi esattamente: ATTIVA REALE');
      if (!this.ks.kp) throw new Error('Crea o sblocca il portafoglio del bot');
      await this.refreshBalances(true);
      this.cfg.mode = 'REAL'; this.cfg.trading = false;
      const cash = this.cfg.baseCurrency === 'SOL' ? Math.max(0, this.bal.sol - this.cfg.feeReserveSol) : (this.bal.tokens[USDC] ? this.bal.tokens[USDC].ui : 0);
      const old = this.st.books.REAL;
      if (!old || !old.positions.length) {
        this.st.books.REAL = newBook(Math.min(cash, this.cfg.budget) || 0, this.cfg);
        Object.assign(this.st.books.REAL, { cash, budget: this.cfg.budget, startEquity: cash, dayStartEquity: cash, trades: old ? old.trades : [], equityHist: old ? old.equityHist : [] });
      }
      this.log('SISTEMA', `Modalità REALE attivata. Saldo bot ${this.fmtBase(cash)}. Il bot userà al massimo ${this.fmtBase(this.cfg.budget)}.`, 'warn');
      await this.reconcile().catch((e) => this.log('SISTEMA', `riconciliazione: ${e.message}`, 'warn'));
    } else { this.cfg.mode = 'SIM'; this.cfg.trading = false; this.log('SISTEMA', 'Modalità SIMULAZIONE'); }
    this.saveCfg(); this.save();
  }
  // Dopo un riavvio (es. hosting con disco temporaneo) adotta i token già presenti nel wallet del bot
  // come posizioni "recuperate", così SORVEGLIANZA li protegge con stop e target.
  async reconcile() {
    if (this.cfg.mode !== 'REAL' || !this.ks.info().exists) return 0;
    await this.refreshBalances(true);
    if (!this.bal) return 0;
    const b = this.book; const skip = new Set([USDC, SOL, this.base.mint]);
    const cand = Object.entries(this.bal.tokens).filter(([m, t]) => !skip.has(m) && t.raw > 0n && !b.positions.some((p) => p.mint === m));
    if (!cand.length) return 0;
    await this.market.refreshPrices([...cand.map(([m]) => m), SOL, USDC]).catch(() => {});
    let n = 0;
    for (const [mint, t] of cand) {
      const px = this.priceBase(mint); if (!px) continue;
      const value = t.ui * px; const usd = this.toUsd(value);
      if (!usd || usd < 1) continue;
      const core = coreMints.has(mint);
      const plan = S.riskPlan(core ? 1.5 : 3, this.cfg, core);
      const sym = (this.market.stats[mint] && this.market.stats[mint].symbol) || (CORE.find((x) => x.mint === mint) || {}).symbol || mint.slice(0, 4);
      b.positions.push({ id: uid(), mint, symbol: sym, decimals: t.decimals, qtyRaw: t.raw.toString(), qty: t.ui, costBase: value, entryPrice: px, highest: px,
        slPct: plan.slPct, tpPct: plan.tpPct, trailPct: plan.trailPct, openedAt: Date.now(), feesBase: 0, sigOpen: null, impactPct: 0, core, recovered: true, initQty: t.ui, origCost: value, origFees: 0 });
      n++;
      this.log('SORVEGLIANZA', `posizione recuperata dal wallet: $${sym} (${this.fmtBase(value)}), protetta con stop −${plan.slPct.toFixed(1)}%`, 'warn');
    }
    this.save();
    return n;
  }

  async closeAll(reason = 'Chiusura manuale') { for (const p of [...this.book.positions]) await this.closePosition(p, reason); }

  // Preleva tutto: vende le posizioni e invia tutto all'indirizzo Phantom registrato.
  async withdrawAll(password) {
    if (this.cfg.mode !== 'REAL') {
      this.cfg.trading = false; await this.closeAll('Prelievo (simulato)');
      this.log('SISTEMA', `Prelievo simulato: saldo finale ${this.fmtBase(this.book.cash)}`); this.saveCfg(); return { simulated: true, cash: this.book.cash };
    }
    this.ks.verify(password);
    const kp = this.ks.kp; if (!kp) throw new Error('Portafoglio bloccato');
    const dest = this.st.withdrawAddress; if (!dest) throw new Error('Nessun indirizzo di prelievo: collega Phantom e fai prima un deposito');
    this.cfg.trading = false; this.saveCfg();
    const steps = [];
    await this.closeAll('Prelievo');
    if (this.book.positions.length) throw new Error('Alcune posizioni non si sono chiuse: riprova tra poco');
    const owner = kp.publicKey.toBase58();
    await this.refreshBalances(true);
    const c = this.conn;
    // 1) USDC → Phantom
    const u = this.bal.tokens[USDC];
    if (u && u.raw > 0n) {
      const ixs = [chain.createAtaIdempotentIx(owner, dest, USDC), chain.transferCheckedIx(chain.ata(owner, USDC), USDC, chain.ata(dest, USDC), owner, u.raw, 6)];
      const { tx, lastValidBlockHeight } = await chain.buildV0(c, owner, ixs); tx.sign([kp]);
      const r = await chain.sendAndConfirm(c, tx, lastValidBlockHeight); this.realTx('PRELIEVO USDC', r.sig, r.ok ? null : r.err);
      if (!r.ok) throw new Error(`Invio USDC fallito: ${r.err}`); steps.push({ step: 'USDC', sig: r.sig });
    }
    // 2) vende eventuali altri token rimasti con valore > 0,5$
    await this.refreshBalances(true);
    for (const [mint, t] of Object.entries(this.bal.tokens)) {
      if (mint === USDC || t.raw === 0n) continue;
      const usd = (this.market.usd(mint) || 0) * t.ui;
      if (usd > 0.5) { try { const q = await jup.quote(mint, SOL, t.raw, 300); const r = await this.realSwap(q); if (r.ok) this.realTx('PRELIEVO vendita residuo', r.sig); } catch (e) { this.log('SISTEMA', `residuo ${mint}: ${e.message}`, 'warn'); } }
    }
    // 3) chiude i conti token vuoti (recupera l'affitto) 
    await this.refreshBalances(true);
    const empties = [];
    for (const t of Object.values(this.bal.tokens)) for (const a of t.accounts) if (a.raw === '0') empties.push(a);
    for (let i = 0; i < empties.length; i += 8) {
      const ixs = empties.slice(i, i + 8).map((a) => chain.closeAccountIx(a.address, owner, owner, new PublicKey(a.program)));
      const { tx, lastValidBlockHeight } = await chain.buildV0(c, owner, ixs); tx.sign([kp]);
      const r = await chain.sendAndConfirm(c, tx, lastValidBlockHeight); this.realTx('Chiusura conti token', r.sig, r.ok ? null : r.err);
    }
    // 4) tutto il SOL → Phantom
    const lamports = await c.getBalance(kp.publicKey);
    const send = lamports - 5000;
    if (send > 0) {
      const { tx, lastValidBlockHeight } = await chain.buildV0(c, owner, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(dest), lamports: send })]);
      tx.sign([kp]);
      const r = await chain.sendAndConfirm(c, tx, lastValidBlockHeight); this.realTx('PRELIEVO SOL', r.sig, r.ok ? null : r.err);
      if (!r.ok) throw new Error(`Invio SOL fallito: ${r.err}`); steps.push({ step: 'SOL', sig: r.sig, sol: send / LAMPORTS_PER_SOL });
    }
    const left = this.st.books.REAL; left.cash = 0; left.startEquity = 0; left.dayStartEquity = 0;
    await this.refreshBalances(true); this.save();
    this.log('SISTEMA', `Prelievo completato verso ${dest}`);
    return { steps, dest };
  }

  // Registra un deposito confermato on-chain da Phantom.
  async recordDeposit(sig, from) {
    const info = this.ks.info(); if (!info.exists) throw new Error('Nessun portafoglio del bot');
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      const st = (await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (st && st.err) throw new Error('Transazione di deposito fallita on-chain');
      if (st && st.confirmationStatus && st.confirmationStatus !== 'processed') ok = true; else await sleep(2000);
    }
    if (!ok) throw new Error('Deposito non ancora confermato: ricontrolla tra poco');
    const d = await chain.txDeltas(this.conn, sig, info.publicKey);
    this.st.deposits.unshift({ t: Date.now(), sig, from, solDelta: d ? d.solDelta / LAMPORTS_PER_SOL : null, usdc: d && d.tokenDeltas[USDC] ? Number(d.tokenDeltas[USDC]) / 1e6 : null });
    if (!this.st.withdrawAddress) this.st.withdrawAddress = from;
    this.realTx('DEPOSITO da Phantom', sig);
    await this.refreshBalances(true);
    const R = this.st.books.REAL;
    if (R) {
      const added = this.cfg.baseCurrency === 'SOL' ? (d ? Math.max(0, d.solDelta / LAMPORTS_PER_SOL - this.cfg.feeReserveSol) : 0) : (d && d.tokenDeltas[USDC] ? Number(d.tokenDeltas[USDC]) / 1e6 : 0);
      R.startEquity += added; R.dayStartEquity += added;
    }
    this.save();
    return { ok: true, sig };
  }

  // dati per le uscite rapide (momentum 5 min, EMA9 1 min, flusso acquisti/vendite)
  exitCtx(p) {
    const c = this.market.candles[p.mint]; const s = this.market.stats[p.mint];
    const ctx = {};
    if (c && c.length >= 10) {
      const cl = c.map((x) => x.c); ctx.m5 = momentum(cl, 5); const e = ema(cl.slice(-60), 9); ctx.ema9 = e[e.length - 1];
      // le candele sono in USD: per i long il prezzo è in valuta base
      if (!isPerp(p) && this.cfg.baseCurrency !== 'USDC') { const bu = this.baseUsd(); ctx.ema9 = bu ? ctx.ema9 / bu : null; }
    }
    if (s) { const tot = (s.buys1h || 0) + (s.sells1h || 0); ctx.flow = { tot, ratio: tot ? ((s.buys1h || 0) - (s.sells1h || 0)) / tot : 0 }; }
    return ctx;
  }
  // stato delle uscite per l'interfaccia: stop effettivo e prossimo obiettivo
  exitView(p) {
    if (p.side === 'SHORT') return this.exitViewShort(p);
    const cfg = this.cfg; const sl = p.entryPrice * (1 - p.slPct / 100);
    const stop = Math.max(sl, p.beStop || 0, p.trailStop || 0);
    const stopKind = stop === p.trailStop ? 'trailing' : stop === p.beStop ? 'pareggio' : 'stop';
    let next = p.entryPrice * (1 + p.tpPct / 100), nextLabel = 'target';
    if (cfg.smartExits) {
      const L = S.exitLevels(p, cfg);
      if (cfg.partialTp && !p.tp1Done) { next = p.entryPrice * (1 + L.tp1 / 100); nextLabel = `TP1 ${cfg.tp1Pct}%`; }
      else if (cfg.partialTp && !p.tp2Done && cfg.tp2Pct > 0) { next = p.entryPrice * (1 + Math.max(L.tp2, L.tp1) / 100); nextLabel = `TP2 ${cfg.tp2Pct}%`; }
      else if (cfg.trailOn) { next = Math.max(p.highest || p.entryPrice, p.entryPrice * (1 + L.trailAct / 100)); nextLabel = p.trailStop ? 'massimo' : 'attiva trailing'; }
    }
    return { stop, stopPct: ((stop - p.entryPrice) / p.entryPrice) * 100, stopKind, next, nextPct: ((next - p.entryPrice) / p.entryPrice) * 100, nextLabel,
      partialsN: (p.partials || []).length, realizedPart: p.realizedPart || 0, soldPct: p.initQty ? Math.round((1 - p.qty / p.initQty) * 100) : 0 };
  }
  exitViewShort(p) {
    const cfg = this.cfg; const e = p.entryPrice; const mir = (x) => 2 * e - x;
    const stop = S.effectiveStop(p);
    const mStop = Math.max(e * (1 - p.slPct / 100), p.beStop || 0, p.trailStop || 0);
    const stopKind = mStop === p.trailStop ? 'trailing' : mStop === p.beStop ? 'pareggio' : 'stop';
    let next = e * (1 - p.tpPct / 100), nextLabel = 'target';
    if (cfg.smartExits) {
      const L = S.exitLevels(p, cfg);
      if (cfg.partialTp && !p.tp1Done) { next = e * (1 - L.tp1 / 100); nextLabel = `TP1 ${cfg.tp1Pct}%`; }
      else if (cfg.partialTp && !p.tp2Done && cfg.tp2Pct > 0) { next = e * (1 - Math.max(L.tp2, L.tp1) / 100); nextLabel = `TP2 ${cfg.tp2Pct}%`; }
      else if (cfg.trailOn) { next = Math.min(mir(p.highest || e), e * (1 - L.trailAct / 100)); nextLabel = p.trailStop ? 'minimo' : 'attiva trailing'; }
    }
    return { stop, stopPct: ((stop - e) / e) * 100, stopKind, next, nextPct: ((next - e) / e) * 100, nextLabel,
      partialsN: (p.partials || []).length, realizedPart: p.realizedPart || 0, soldPct: p.initSizeUsd ? Math.round((1 - p.sizeUsd / p.initSizeUsd) * 100) : 0 };
  }
  // log del trailing: alla prima attivazione e poi quando sale di almeno mezzo punto (max 1 riga al minuto)
  onTrail(p, ev) {
    const now = Date.now();
    const first = !ev.from;
    const step = ev.from ? Math.abs((ev.to - (p.trailLogged || ev.from)) / p.entryPrice) * 100 : 0;
    if (first || (step >= 0.5 && now - (p.trailLoggedAt || 0) > 60000)) {
      p.trailLogged = ev.to; p.trailLoggedAt = now;
      const sh = p.side === 'SHORT';
      const t = `${first ? 'trailing stop attivato' : sh ? 'trailing stop abbassato' : 'trailing stop alzato'} a ${ev.to.toPrecision(6)} su $${p.symbol}${sh ? ' SHORT' : ''} (${sh ? 'blocca ' : ''}${ev.pctFromEntry >= 0 ? '+' : ''}${ev.pctFromEntry.toFixed(2)}% ${sh ? 'di guadagno' : "dall'ingresso"})`;
      this.log('SORVEGLIANZA', t); this.agent('SORVEGLIANZA', t, 'trail', { token: p.symbol });
      this.save();
    }
  }

  // ---------- MENTORE
  solMom60() { const c = this.market.candles[SOL]; return c && c.length > 60 ? momentum(c.map((x) => x.c), 60) : null; }
  postFields(p) { return { slPct: p.slPct, atrPct: p.atrPct, ctx: p.ctx || null, mfe: p.mfe != null ? p.mfe : null, mae: p.mae != null ? p.mae : null, tuneVer: p.ctx ? p.ctx.tuneVer : null }; }
  // filtro del MENTORE su un candidato: pause/selettività imparate, notizie, preferenza long/short per regime
  mentorGate(x) {
    if (!x.a.ok) return;
    const sym = x.s.symbol; const mc = this.research.marketContext(sym); const nw = this.research.newsFor(sym); const d = x.side === 'SHORT' ? -1 : 1;
    x.total += d * 0.5 * nw.sentiment - 0.5 * nw.risk + this.mentor.prefAdj(x.side, mc.regime);
    x.news = nw;
    const conf = x.side === 'SHORT' ? x.a.short.confidence : x.a.confidence;
    const chk = this.mentor.entryCheck({ symbol: sym, side: x.side, regime: mc.regime, atrPct: x.a.atrPct, funding: mc.funding, newsRisk: nw.risk, conf, flowStrict: d > 0 ? x.f.score > 0 : x.f.score < 0, rsScore: x.rs ? x.rs.score : 0 });
    if (!chk.ok) x.block = chk.reason;
  }
  mentorLearn(tr) {
    try { this.mentor.onClose(tr); } catch (e) { this.log('MENTORE', `post-mortem non riuscito: ${e.message}`, 'warn'); }
    if (!K.learn(this.kb, { id: tr.id, feat: tr.feat, pnlPct: tr.pnlPct, mode: tr.mode })) return;
    this.bump('MENTORE');
    const sm = K.summary(this.kb, 1);
    const tag = tr.mode === 'REAL' ? 'reale' : 'simulato';
    const lesson = `imparato da $${tr.symbol}${tr.side === 'SHORT' ? ' SHORT' : ''} (${tag}, ${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct.toFixed(2)}%) · ${sm.trades} trade in memoria`;
    this.kb.lastLesson = { t: Date.now(), text: lesson };
    this.kbWriter.schedule();
    this.log('MENTORE', lesson + (sm.active ? (sm.best[0] ? ` · migliore: ${sm.best[0].label}` : '') + (sm.worst[0] ? ` · peggiore: ${sm.worst[0].label}` : '') : ` · inizio a influenzare dopo ${sm.trades + sm.need} trade`));
    this.agent('MENTORE', `condivido la lezione con tutti i bot (${sm.trades} trade)`, 'teach', { targets: AGENTS.filter((a) => a.id !== 'MENTORE').map((a) => a.id) });
  }
  mentorReview() {
    // verifica finale dei post-mortem (60 min dopo l'uscita) e correzioni automatiche
    try {
      const mintOf = (sym) => Object.keys(P.SHORT_MARKETS).find((m) => P.SHORT_MARKETS[m] === sym) || (this.st.books[this.cfg.mode].trades.find((t) => t.symbol === sym) || {}).mint;
      const lessons = this.mentor.followUp((sym) => this.market.candles[mintOf(sym)] || []);
      for (const l of lessons) {
        this.bump('MENTORE');
        this.log('MENTORE', `lezione: ${l.text}${l.corrections.length ? '' : ' · nessuna correzione necessaria'}`);
        this.agent('MENTORE', `lezione da $${l.symbol}: ${l.text.split(': ').slice(1).join(': ').split(' · ')[0]}`, 'teach', { targets: AGENTS.filter((a) => a.id !== 'MENTORE').map((a) => a.id) });
      }
    } catch (e) { this.log('MENTORE', `verifica post-mortem non riuscita: ${e.message}`, 'warn'); }
    const sm = K.summary(this.kb, 2);
    if (!sm.trades) {
      if (Date.now() - this.lastMentorIdle > 30 * 60000) { this.lastMentorIdle = Date.now(); this.log('MENTORE', 'nessun trade chiuso da cui imparare: osservo il mercato e aspetto i primi risultati'); }
      this.agent('MENTORE', 'osservo: ancora nessun trade da studiare', 'idle'); return;
    }
    const m = this.solMom60();
    const ctx = m == null ? '' : ` · mercato SOL ${m > 1 ? 'in rialzo' : m < -1 ? 'in ribasso' : 'laterale'} (${m >= 0 ? '+' : ''}${m.toFixed(2)}% in 1h)`;
    const text = sm.active
      ? `ripasso ${sm.trades} trade: ${sm.best.length ? 'funziona ' + sm.best.map((x) => x.label).join(', ') : 'nessun pattern vincente chiaro'}${sm.worst.length ? ' · evitare ' + sm.worst.map((x) => x.label).join(', ') : ''}${ctx}`
      : `studio ${sm.trades} trade (servono ${sm.need} in più prima di dare consigli)${ctx}`;
    this.log('MENTORE', text);
    this.agent('MENTORE', 'aggiorno le conoscenze di tutti i bot', 'teach', { targets: AGENTS.filter((a) => a.id !== 'MENTORE').map((a) => a.id) });
  }

  // ---------- istantanea per l'interfaccia
  snapshot() {
    const b = this.book; const cfg = this.cfg; const eq = this.equity();
    const baseUsd = this.market.usd(this.base.mint) || (cfg.baseCurrency === 'USDC' ? 1 : null);
    const eur = this.market.eurPerUsd;
    const toEur = (x) => (baseUsd ? x * baseUsd * eur : null);
    const positions = b.positions.map((p) => {
      if (isPerp(p)) {
        const px = this.market.usd(p.mint); const val = this.shortValueBase(p); const dn = p.side === 'LONG' ? -1 : 1;
        const st = px ? P.shortState(p, px, Date.now()) : null;
        const pnl = val - p.costBase - p.feesBase;
        return { id: p.id, side: p.side, perp: true, lev: p.lev, symbol: p.symbol, mint: p.mint, costBase: p.costBase, value: val, pnl, pnlPct: (pnl / p.costBase) * 100,
          entryPrice: p.entryPrice, price: px, priceUnit: 'USD', sl: p.entryPrice * (1 + (dn * p.slPct) / 100), tp: p.entryPrice * (1 - (dn * p.tpPct) / 100), slPct: p.slPct, tpPct: p.tpPct, openedAt: p.openedAt, sigOpen: null,
          liqPrice: st ? st.liqPrice : p.liqPrice, sizeUsd: p.sizeUsd, collateralUsd: p.collateralUsd, borrowUsd: st ? st.borrowUsd : p.borrowUsd, perpFeesUsd: (p.perpFeesUsd || 0) + (st ? st.borrowUsd - (p.borrowUsd || 0) : 0),
          ...this.exitView(p) };
      }
      const px = this.priceBase(p.mint); const val = px ? p.qty * px : p.costBase;
      return { id: p.id, side: 'LONG', lev: 1, symbol: p.symbol, mint: p.mint, costBase: p.costBase, value: val, pnl: val - p.costBase - p.feesBase, pnlPct: ((val - p.costBase - p.feesBase) / p.costBase) * 100,
        entryPrice: p.entryPrice, price: px, sl: p.entryPrice * (1 - p.slPct / 100), tp: p.entryPrice * (1 + p.tpPct / 100), slPct: p.slPct, tpPct: p.tpPct, openedAt: p.openedAt, sigOpen: p.sigOpen,
        ...this.exitView(p) };
    });
    const hist = b.equityHist; const step = Math.max(1, Math.ceil(hist.length / 240));
    const ws = [...this.watch.entries()].map(([m, w]) => { const s = this.market.stats[m] || {}; return { mint: m, symbol: w.symbol, core: w.core, priceUsd: this.market.usd(m), change1h: s.change1h, liq: s.liquidityUsd, candles: (this.market.candles[m] || []).length }; });
    const ks = this.ks.info();
    const closed = b.wins + b.losses;
    // riepilogo guadagni/perdite per il pannello in alto
    const unrealizedPnl = positions.reduce((a, p) => a + (p.pnl || 0), 0);
    const today = dayKey(); const todayTr = b.trades.filter((x) => x.closedAt && new Date(x.closedAt).toISOString().slice(0, 10) === today);
    let grossWin = 0, grossLoss = 0, best = null, worst = null;
    for (const x of b.trades) { if (x.pnl >= 0) grossWin += x.pnl; else grossLoss += x.pnl; if (!best || x.pnl > best.pnl) best = x; if (!worst || x.pnl < worst.pnl) worst = x; }
    const pnlBox = {
      total: eq - b.startEquity, realized: b.realizedPnl, unrealized: unrealizedPnl, day: b.dayKey === today ? eq - b.dayStartEquity : unrealizedPnl,
      dayWins: todayTr.filter((x) => x.pnl >= 0).length, dayLosses: todayTr.filter((x) => x.pnl < 0).length, grossWin, grossLoss,
      best: best ? { symbol: best.symbol, pnl: best.pnl } : null, worst: worst ? { symbol: worst.symbol, pnl: worst.pnl } : null,
      baseUsd, solUsd: this.market.usd(SOL),
    };
    return {
      t: Date.now(), mode: cfg.mode, trading: cfg.trading, killed: b.killed, killReason: b.killReason, busy: this.busy,
      cfg: { ...cfg }, base: cfg.baseCurrency, entryBlock: this.entryBlock(), shorts: { realEnabled: P.REAL_SHORTS_ENABLED, realMsg: P.REAL_SHORTS_BLOCK_MSG, markets: Object.values(P.SHORT_MARKETS), maxLev: P.MAX_LEV, leverages: LEVERAGES, liqDist: Object.fromEntries(LEVERAGES.map((l) => [l, P.liqDistancePct(l)])), fees: P.FEES },
      equity: eq, equityEur: toEur(eq), startEquity: b.startEquity, pnl: eq - b.startEquity, pnlEur: toEur(eq - b.startEquity),
      roi: b.startEquity > 0 ? eq / b.startEquity : 1, realizedPnl: b.realizedPnl, fees: b.feesBase, cash: b.cash, solReserve: b.solReserve,
      capital: (({ positions: _ps, ...c }) => c)(this.capital(b)),
      winRate: closed ? (b.wins / closed) * 100 : null, wins: b.wins, losses: b.losses, pnlBox, knowledge: K.summary(this.kb, 3), research: this.research.summary(), mentor: this.mentor.summary(),
      positions, trades: b.trades.slice(0, 60), equityHist: hist.filter((_, i) => i % step === 0 || i === hist.length - 1),
      counters: this.st.counters, agents: AGENTS.map((a) => ({ ...a, count: this.st.counters.agents[a.id] || 0, last: this.st.agents[a.id] || null })),
      log: this.st.log.slice(-80), watch: ws,
      solUsd: this.market.usd(SOL), eurPerUsd: eur, baseUsd,
      wallet: { ...ks, balances: this.bal ? { sol: this.bal.sol, usdc: this.bal.tokens[USDC] ? this.bal.tokens[USDC].ui : 0, tokens: Object.keys(this.bal.tokens).length } : null },
      user: { address: this.st.userWallet, withdrawAddress: this.st.withdrawAddress, balances: this.userBal ? { sol: this.userBal.sol, usdc: this.userBal.tokens[USDC] ? this.userBal.tokens[USDC].ui : 0 } : null },
      realTxs: this.st.realTxs.slice(0, 30), deposits: this.st.deposits.slice(0, 10),
      live: Date.now() - this.lastPriceOk < 45000, lastErr: this.lastErr,
    };
  }
}
module.exports = { Engine, AGENTS, newBook };
