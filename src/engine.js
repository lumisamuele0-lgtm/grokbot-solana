'use strict';
// Motore del bot: 8 agenti in pipeline, esecuzione SIMULAZIONE (paper su quote reali Jupiter) o REALE.
const path = require('path');
const EventEmitter = require('events');
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { readJson, debounceWriter } = require('./store');
const { DEFAULTS, sanitize, migrateConfig } = require('./config');
const { CORE, BASES, SOL, USDC } = require('./tokens');
const S = require('./strategy');
const jup = require('./jupiter');
const chain = require('./chain');
const { Market } = require('./market');
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
];
const dayKey = () => new Date().toISOString().slice(0, 10);
const coreMints = new Set(CORE.map((t) => t.mint));

function newBook(budget, cfg) {
  return { cash: budget, solReserve: cfg.feeReserveSol, positions: [], trades: [], startEquity: budget, budget, realizedPnl: 0, feesBase: 0,
    dayKey: dayKey(), dayStartEquity: budget, killed: false, killReason: null, equityHist: [], cooldown: {}, startedAt: Date.now(), wins: 0, losses: 0 };
}
function newCounters() {
  return { analyzed: 0, rejected: 0, approved: 0, rules: {}, agents: Object.fromEntries(AGENTS.map((a) => [a.id, 0])) };
}

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
    if (this.cfgMigrated) this.cfgWriter.flush(); // salva subito i nuovi parametri sul volume
    if (this.cfgMigrated) this.log('SISTEMA', `Parametri aggiornati: rischio ${this.cfg.maxTradePct}% per operazione, volume 24h min ${this.cfg.minVolume24hUsd} $, età min ${this.cfg.minPairAgeMin} min`);
    this.market = new Market((lvl, t) => this.log('SISTEMA', t, lvl));
    this.watch = new Map(); // mint -> {symbol, approvedAt}
    this.seen = {}; // mint -> ultimo controllo filtri
    this.busy = false; this.timers = []; this.bal = null; this.userBal = null; this.lastPriceOk = 0; this.lastErr = null;
    this.analysisRejectTs = {};
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
    let v = book.cash - (book.extFees || 0);
    for (const p of book.positions) { const px = this.priceBase(p.mint); v += px ? p.qty * px : p.costBase; }
    return v;
  }

  // ---------- avvio
  start() {
    this.log('SISTEMA', `Avvio motore · modalità ${this.cfg.mode === 'SIM' ? 'SIMULAZIONE' : 'REALE'} · base ${this.cfg.baseCurrency}`);
    const every = (ms, fn) => { const run = async () => { try { await fn(); } catch (e) { this.lastErr = e.message; this.log('SISTEMA', `Errore: ${e.message}`, 'error'); } }; run(); this.timers.push(setInterval(run, ms)); };
    every(15000, () => this.priceTick());
    setTimeout(() => every(60000, () => this.scan()), 1500);
    this.loopTimer = setTimeout(() => this.cycleLoop(), 8000);
    every(30000, () => this.recordEquity());
    every(20000, () => this.refreshBalances());
    every(3600000, () => this.market.refreshEur());
    if (process.env.BOT_WALLET_PASSWORD && this.ks.exists()) {
      try { this.ks.unlock(process.env.BOT_WALLET_PASSWORD); this.log('SISTEMA', 'Portafoglio del bot sbloccato da variabile d\'ambiente'); } catch (e) { this.log('SISTEMA', `Sblocco automatico fallito: ${e.message}`, 'error'); }
    }
    if (process.env.BOT_AUTOSTART === '1') { this.cfg.trading = true; this.log('SISTEMA', 'Avvio automatico del trading (BOT_AUTOSTART=1)'); }
  }
  stop() { this.timers.forEach(clearInterval); clearTimeout(this.loopTimer); this.cfgWriter.flush(); this.stWriter.flush(); }
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
    let mints = [...cfg.tokens];
    let discovered = 0;
    if (cfg.scanMemes) { const d = await this.market.discover(); discovered = d.length; mints = mints.concat(d); }
    mints = [...new Set(mints)].filter((m) => m !== this.base.mint && m !== USDC);
    this.agent('SCANSIONE', `scansione: ${mints.length} token (${discovered} meme da DexScreener)`, 'scan');
    await this.market.refreshStats(mints, coreMints);
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
      if (!this.watch.has(m)) this.watch.set(m, { symbol: s.symbol, approvedAt: now, core });
    }
    // limita la watchlist: core + meme più liquidi
    if (this.watch.size > cfg.maxWatch) {
      const arr = [...this.watch.entries()].sort((a, b) => (b[1].core - a[1].core) || ((this.market.stats[b[0]] || {}).volume24h - (this.market.stats[a[0]] || {}).volume24h));
      for (const [m] of arr.slice(cfg.maxWatch)) if (!this.holding(m)) this.watch.delete(m);
    }
    this.agent('SCANSIONE', `${newOnes} nuovi controllati · ${ok} ok · ${rej} scartati · in osservazione ${this.watch.size}`, 'scan');
    this.save();
    // candele reali per la watchlist (rispettando i limiti gratuiti)
    for (const m of this.watch.keys()) {
      if (this.market.needsBackfill(m)) {
        try { await this.market.backfill(m); } catch (e) { this.log('SCANSIONE', `candele ${this.watch.get(m).symbol}: ${e.message}`, 'warn'); }
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
    this.emit('ev', { type: 'pipe', step: 'start' });
    // SOCIAL + CAPO
    const cands = [];
    for (const [m, w] of this.watch) {
      if (b.positions.some((p) => p.mint === m)) continue;
      if (b.cooldown[m] && b.cooldown[m] > now) continue;
      const s = this.market.stats[m]; const c = this.market.candles[m];
      if (!s || !c) continue;
      const a = S.analyze(c);
      const f = S.flowScore(s);
      this.bump('SOCIAL'); this.bump('CAPO');
      cands.push({ m, w, s, a, f, total: (a.ok ? a.score : -9) + f.score });
    }
    if (!cands.length) { this.agent('CAPO', 'nessun token pronto (candele in caricamento o in cooldown)', 'idle'); return; }
    cands.sort((x, y) => y.total - x.total);
    const top = cands[0];
    this.agent('SOCIAL', `$${top.s.symbol}: ${top.f.buys} acquisti / ${top.f.sells} vendite (1h) · volume x${top.f.volAccel.toFixed(2)}`, 'flow', { token: top.s.symbol, score: top.f.score });
    await sleep(400);
    const best = cands.find((x) => x.a.ok && x.a.signal === 'LONG' && x.f.score > -0.2);
    // conteggia scarti dell'analisi (al massimo uno ogni 15 min per token)
    for (const x of cands) {
      if (x === best) continue;
      if (now - (this.analysisRejectTs[x.m] || 0) > 15 * 60000) {
        this.analysisRejectTs[x.m] = now;
        const lbl = !x.a.ok ? 'Dati insufficienti' : x.a.signal !== 'LONG' ? x.a.reason : 'Flusso negativo';
        this.rule(lbl);
        this.log('CAPO', `scartato $${x.s.symbol} - ${lbl}${x.a.ok ? ` (RSI ${x.a.rsi.toFixed(0)}, mom15 ${x.a.m15.toFixed(2)}%)` : ''}`);
      }
    }
    if (!best) {
      const t = top.a.ok ? `nessun segnale: migliore $${top.s.symbol} (RSI ${top.a.rsi.toFixed(0)}, ${top.a.reason || 'flusso negativo'})` : `dati insufficienti per $${top.s.symbol}`;
      this.agent('CAPO', t, 'idle', { token: top.s.symbol });
      return;
    }
    const a = best.a; const sym = best.s.symbol; const core = coreMints.has(best.m);
    const passed = Object.entries(a.checks).filter(([, v]) => v).map(([k]) => k);
    this.agent('CAPO', `scelto $${sym}: ${passed.length}/6 condizioni (RSI ${a.rsi.toFixed(0)}, mom15 +${a.m15.toFixed(2)}%), fiducia ${(a.confidence * 100).toFixed(0)}%`, 'pick', { token: sym });
    this.log('CAPO', `$${sym} LONG · EMA9 ${a.ema9.toPrecision(5)} > EMA21 ${a.ema21.toPrecision(5)} · RSI ${a.rsi.toFixed(1)} · ATR ${a.atrPct.toFixed(2)}% · flusso ${best.f.score.toFixed(2)}`);
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
    const sz = S.sizePosition({ capital, cash: this.cash(), cfg, confidence: a.confidence * (0.85 + 0.15 * Math.max(0, best.f.score)), atr: a.atrPct, core, minTrade });
    this.bump('DIMENSIONE');
    if (!sz.size) { this.agent('DIMENSIONE', sz.reason, 'block'); return; }
    const size = round(sz.size, this.base.decimals);
    this.agent('DIMENSIONE', `${this.fmtBase(size)} su $${sym} (${((size / capital) * 100).toFixed(1)}% del capitale${core ? '' : ', meme ×' + cfg.memeSizeMult})`, 'size', { token: sym, size });
    await sleep(400);

    // RISCHIO: piano
    const plan = S.riskPlan(a.atrPct, cfg, core);
    this.agent('RISCHIO', `spot 1x · stop -${plan.slPct.toFixed(2)}% · target +${plan.tpPct.toFixed(2)}% · trailing ${plan.trailPct.toFixed(2)}%`, 'plan', { token: sym });
    await sleep(400);

    // ESECUZIONE
    await this.openPosition(best, size, plan);
  }

  cash() {
    const b = this.book;
    if (this.cfg.mode === 'SIM') return b.cash;
    return Math.max(0, b.cash);
  }
  fmtBase(x) { return `${(+x).toFixed(this.cfg.baseCurrency === 'SOL' ? 4 : 2)} ${this.cfg.baseCurrency}`; }

  async openPosition(c, size, plan) {
    const b = this.book; const cfg = this.cfg; const sym = c.s.symbol;
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
      slPct: plan.slPct, tpPct: plan.tpPct, trailPct: plan.trailPct, openedAt: Date.now(), feesBase: feeBase, sigOpen: sig, impactPct: impact, core: coreMints.has(c.m) };
    b.positions.push(pos); b.feesBase += feeBase;
    this.bump('ESECUZIONE');
    const t = `comprato $${sym} per ${this.fmtBase(spent)}`;
    this.agent('ESECUZIONE', t, 'buy', { token: sym, size: spent, sig });
    this.log('ESECUZIONE', `${t} · ${qty.toPrecision(6)} token @ ${entry.toPrecision(6)} · impatto ${impact.toFixed(3)}%${sig ? ' · ' + sig : ' · (simulato su quote reale)'}`);
    this.emit('ev', { type: 'trade', side: 'BUY', symbol: sym, amount: spent, sig, mode: cfg.mode });
    if (sig) this.realTx('BUY ' + sym, sig);
    this.save();
  }

  solToBase(sol) { if (this.cfg.baseCurrency === 'SOL') return sol; const s = this.market.usd(SOL), u = this.market.usd(USDC) || 1; return s ? (sol * s) / u : 0; }

  // ---------- SORVEGLIANZA
  async monitor() {
    const b = this.book; if (!b.positions.length) { this.agent('SORVEGLIANZA', 'nessuna posizione aperta', 'idle'); return; }
    const now = Date.now(); const lines = [];
    for (const p of [...b.positions]) {
      const px = this.priceBase(p.mint); if (!px) continue;
      const r = S.exitCheck(p, px, now, this.cfg);
      lines.push(`$${p.symbol} ${r.change != null ? (r.change >= 0 ? '+' : '') + r.change.toFixed(2) + '%' : ''}`);
      if (r.exit && !p.closing) await this.closePosition(p, r.reason);
    }
    if (lines.length) this.agent('SORVEGLIANZA', `pattuglio ${b.positions.length} posizioni: ${lines.join(' · ')}`, 'patrol');
    const eq = this.equity();
    const lim = S.checkLimits({ equity: eq, startEquity: b.startEquity, dayStartEquity: b.dayStartEquity, openCount: 0, cfg: this.cfg });
    if (lim.kill && !b.killed) await this.killSwitch(lim.reason);
  }

  async closePosition(p, reason, toMint) {
    const b = this.book; const cfg = this.cfg; p.closing = true;
    const out = toMint || this.base.mint;
    try {
      let got, feeBase = 0, sig = null, estimated = false;
      let qtyRaw = BigInt(p.qtyRaw);
      if (cfg.mode === 'REAL') {
        await this.refreshBalances(true);
        const onchain = this.bal && this.bal.tokens[p.mint] ? this.bal.tokens[p.mint].raw : 0n;
        if (onchain < qtyRaw) qtyRaw = onchain;
        if (qtyRaw <= 0n) { b.positions = b.positions.filter((x) => x !== p); this.log('SORVEGLIANZA', `$${p.symbol}: saldo on-chain zero, posizione rimossa`, 'warn'); return; }
      }
      let q;
      const slip = Math.min(1000, cfg.slippageBps * (1 + (p.failCount || 0)));
      try { q = await jup.quote(p.mint, out, qtyRaw, slip); } catch (e) {
        if (cfg.mode === 'SIM' && (p.failCount || 0) >= 2) { estimated = true; } else { p.failCount = (p.failCount || 0) + 1; p.closing = false; this.log('SORVEGLIANZA', `vendita $${p.symbol} rinviata: ${e.message}`, 'warn'); return; }
      }
      if (cfg.mode === 'SIM') {
        got = estimated ? p.qty * (this.priceBase(p.mint) || 0) * 0.99 : Number(q.outAmount) / 10 ** (out === this.base.mint ? this.base.decimals : 6);
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
      const pnl = valueBase - p.costBase - p.feesBase - feeBase;
      b.positions = b.positions.filter((x) => x !== p);
      b.realizedPnl += pnl; b.feesBase += feeBase; if (pnl >= 0) b.wins++; else b.losses++;
      b.cooldown[p.mint] = Date.now() + cfg.cooldownMin * 60000;
      const tr = { id: p.id, symbol: p.symbol, mint: p.mint, openedAt: p.openedAt, closedAt: Date.now(), costBase: p.costBase, outBase: valueBase, pnl, pnlPct: (pnl / p.costBase) * 100, fees: p.feesBase + feeBase, reason, sigOpen: p.sigOpen, sigClose: sig, mode: cfg.mode, estimated };
      b.trades.unshift(tr); if (b.trades.length > 500) b.trades.pop();
      this.bump('SORVEGLIANZA');
      const t = `venduto $${p.symbol} · ${reason} · ${pnl >= 0 ? '+' : ''}${this.fmtBase(pnl)}`;
      this.agent('SORVEGLIANZA', t, pnl >= 0 ? 'win' : 'loss', { token: p.symbol, pnl });
      this.log('SORVEGLIANZA', `${t} (commissioni incluse)${sig ? ' · ' + sig : ''}${estimated ? ' · prezzo stimato' : ''}`);
      this.emit('ev', { type: 'trade', side: 'SELL', symbol: p.symbol, amount: valueBase, pnl, sig, mode: cfg.mode });
      if (sig) this.realTx('SELL ' + p.symbol, sig);
      this.save();
    } catch (e) { p.closing = false; p.failCount = (p.failCount || 0) + 1; this.log('SORVEGLIANZA', `errore chiusura $${p.symbol}: ${e.message}`, 'error'); }
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
        slPct: plan.slPct, tpPct: plan.tpPct, trailPct: plan.trailPct, openedAt: Date.now(), feesBase: 0, sigOpen: null, impactPct: 0, core, recovered: true });
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

  // ---------- istantanea per l'interfaccia
  snapshot() {
    const b = this.book; const cfg = this.cfg; const eq = this.equity();
    const baseUsd = this.market.usd(this.base.mint) || (cfg.baseCurrency === 'USDC' ? 1 : null);
    const eur = this.market.eurPerUsd;
    const toEur = (x) => (baseUsd ? x * baseUsd * eur : null);
    const positions = b.positions.map((p) => {
      const px = this.priceBase(p.mint); const val = px ? p.qty * px : p.costBase;
      return { id: p.id, symbol: p.symbol, mint: p.mint, costBase: p.costBase, value: val, pnl: val - p.costBase - p.feesBase, pnlPct: ((val - p.costBase - p.feesBase) / p.costBase) * 100,
        entryPrice: p.entryPrice, price: px, sl: p.entryPrice * (1 - p.slPct / 100), tp: p.entryPrice * (1 + p.tpPct / 100), slPct: p.slPct, tpPct: p.tpPct, openedAt: p.openedAt, sigOpen: p.sigOpen };
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
      cfg: { ...cfg }, base: cfg.baseCurrency,
      equity: eq, equityEur: toEur(eq), startEquity: b.startEquity, pnl: eq - b.startEquity, pnlEur: toEur(eq - b.startEquity),
      roi: b.startEquity > 0 ? eq / b.startEquity : 1, realizedPnl: b.realizedPnl, fees: b.feesBase, cash: b.cash, solReserve: b.solReserve,
      winRate: closed ? (b.wins / closed) * 100 : null, wins: b.wins, losses: b.losses, pnlBox,
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
