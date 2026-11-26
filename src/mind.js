'use strict';
// MENTE dei bot: collega cervello neurale (brain.js), memoria di formazione (memory.js), ricerca web autorizzata
// (webresearch.js) e laboratorio campione/sfidanti (lab.js) alla sala operativa. Produce il «pensiero» di ogni bot.
// Tutto ciò che fa resta DENTRO i limiti: modifica la fiducia degli analisti (±20%) e il consenso dei trader (±5 punti),
// mai stop, limiti di rischio, anti-truffa, blocchi REALE, leva o dimensione massima.
const path = require('path');
const { readJson, debounceWriter } = require('./store');
const { BrainBank, features, LIM: BL } = require('./brain');
const { Memory, tokens } = require('./memory');
const { WebResearch } = require('./webresearch');
const { Lab } = require('./lab');
const { ERR } = require('./mentor');
const S = require('./strategy');
const P = require('./perps');

const HORIZON_MS = 30 * 60e3, SAMPLE_GAP_MS = 5 * 60e3, JOURNAL_MAX = 700, TICK_BUDGET_MS = 300;
const FEE = { perp: 0.1, spot: 0.35 }; // commissioni + slippage andata e ritorno, in % del prezzo (stima prudente)
const REPLAY = { EVERY_MS: 6 * 3600e3, STEP: 4, CHUNK: 100, FWD: 30 };
const BN = { SOL: 'SOLUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : 0));
const pc = (x) => `${Math.round(x * 100)}%`;

class Mind {
  constructor(engine, ids, { dataDir = null } = {}) {
    this.e = engine; this.ids = ids; const log = (a, t, l) => engine.log(a, t, l);
    const bs = dataDir ? readJson(path.join(dataDir, 'brain.json'), null) : null;
    const ms = dataDir ? readJson(path.join(dataDir, 'memory.json'), null) : null;
    this.brains = new BrainBank(ids, bs && bs.brains, { log });
    this.lab = new Lab(this.brains, bs && bs.lab, { log });
    this.memory = new Memory(ms && ms.memory);
    this.web = new WebResearch({ log });
    if (ms && ms.web && typeof ms.web === 'object') for (const [id, f] of Object.entries(ms.web)) if (Array.isArray(f) && ids.includes(id)) this.web.findings[id] = f.slice(0, 10);
    this.st = { journal: Array.isArray(ms && ms.journal) ? ms.journal.slice(-JOURNAL_MAX) : [], last: {}, thoughts: (ms && ms.thoughts) || {}, posX: (ms && ms.posX) || {}, webOff: (ms && ms.webOff) || {}, replay: (ms && ms.replay) || {}, webAt: (ms && ms.webAt) || {} };
    this.bw = dataDir ? debounceWriter(path.join(dataDir, 'brain.json'), () => ({ v: 1, brains: this.brains.toJSON(), lab: this.lab.toJSON() }), 20000) : { schedule() {}, flush() {} };
    this.mw = dataDir ? debounceWriter(path.join(dataDir, 'memory.json'), () => ({ v: 1, memory: this.memory.toJSON(), web: this.web.findings, journal: this.st.journal, thoughts: this.st.thoughts, posX: this.st.posX, webOff: this.st.webOff, replay: this.st.replay, webAt: this.st.webAt }), 15000) : { schedule() {}, flush() {} };
    this.cache = {}; this.rq = null; this.webCursor = 0; this.perf = { ticks: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastJob: null };
  }
  save() { this.bw.schedule(); this.mw.schedule(); }
  flush() { try { this.bw.flush(); this.mw.flush(); } catch { /* disco non disponibile */ } }
  on() { return this.e.cfg.brainOn !== false; }
  webOn(id) { return this.e.cfg.webResearch !== false && !this.st.webOff[id]; }
  setWeb(id, on) { if (!this.ids.includes(id)) throw new Error('Bot sconosciuto'); if (on) delete this.st.webOff[id]; else this.st.webOff[id] = true; this.save(); return { id, on: !!on }; }
  beginTurn() { this.cache = {}; }

  // ---------- caratteristiche
  query(ctx, dir, extra = '') { const reg = ctx.perp && ctx.mc ? ctx.mc.regime || '' : ''; return tokens(`${ctx.symbol} ${dir > 0 ? 'long' : dir < 0 ? 'short' : ''} ${ctx.perp ? 'leva perps' : 'spot'} ${ctx.coin && ctx.coin.meme ? 'memecoin' : ''} ${reg} ${extra}`); }
  recall(id, q) { const k = id + '|' + q.join(' '); if (!this.cache[k]) this.cache[k] = this.memory.recall(id, q, 3); return this.cache[k]; }
  webFor(id, symbol) { return this.webOn(id) ? this.web.sentiment(id, symbol) : { s: 0, n: 0, top: null }; }
  featOf(id, ctx, dir, conf, why = '', now = Date.now()) {
    const rec = this.recall(id, this.query(ctx, dir, why)); const w = this.webFor(id, ctx.symbol);
    return { x: features({ dir, conf, a: ctx.a, f: ctx.f, news: ctx.news, macro: ctx.macro, perp: ctx.perp, meme: !!(ctx.coin && ctx.coin.meme), now, mem: this.memory.signal(rec), web: w.s }), rec, w };
  }
  // voto di un analista: il cervello aggiusta la fiducia (0,8–1,2×), mai crea o inverte il segnale
  vote(A, ctx, v, now = Date.now()) {
    if (!v.dir) return v;
    const { x, rec, w } = this.featOf(A.id, ctx, v.dir, v.conf, v.why, now);
    const cf = this.on() ? this.brains.confFactor(A.id, x) : { f: 1, p: null, k: 0 };
    const out = { ...v, raw: v.conf, conf: clamp(v.conf * cf.f, 0, 1), x, brainP: cf.p };
    const th = this.st.thoughts[A.id];
    if (!th || now - th.t > 60e3 || th.symbol === ctx.symbol || out.conf > (th.conf || 0)) this.st.thoughts[A.id] = this.thinkAnalyst(A, ctx, out, cf, rec, w, now);
    return out;
  }
  thinkAnalyst(A, ctx, v, cf, rec, w, now) {
    const side = v.dir > 0 ? 'LONG' : 'SHORT'; const parts = [`${ctx.symbol}: ${v.why} → ${side} con fiducia ${pc(v.raw)}`];
    if (cf.p != null) { const ex = this.brains.explain(A.id, v.x, 2); parts.push(`il mio cervello stima ${pc(cf.p)} di riuscita (media ${pc(this.brains.base(A.id))}) → fiducia ${pc(v.conf)}${ex.length ? ` (contano: ${ex.map((z) => z.f).join(', ')})` : ''}`); }
    else parts.push(`${this.learning(A.id)}: fiducia invariata`);
    if (rec[0]) parts.push(`ricordo: «${rec[0].text}»`);
    if (w.top) parts.push(`dal web (${w.top.source}): «${w.top.title}»`);
    return { t: now, symbol: ctx.symbol, side, conf: v.conf, text: parts.join(' · ') };
  }
  learning(id) {
    const b = this.brains.bot(id); const st = this.brains.status(id); if (!this.on()) return 'cervello spento in Impostazioni';
    if (b.buf.length < BL.MIN_READY) return `cervello in formazione (${b.buf.length}/${BL.MIN_READY} esempi)`;
    if (!st.lastTrain) return `cervello: ${b.buf.length} esempi, primo allenamento a breve`;
    return `cervello allenato (${pc(st.valAcc)} su dati nuovi) ma non ancora migliore della risposta più frequente (${pc(st.valMaj || 0.5)})`;
  }
  // trader: aggiustamento del consenso ±5 punti
  trader(X, c, now = Date.now()) {
    const ctx = { symbol: c.coin.perp ? c.coin.market || c.coin.symbol : c.coin.symbol, coin: c.coin, perp: !!c.coin.perp, a: c.a, f: c.f, news: c.news || null, macro: c.macro || null, mc: c.mc || null };
    const dir = c.side === 'SHORT' ? -1 : 1;
    const { x, rec, w } = this.featOf(X.id, ctx, dir, clamp(c.cs.score, 0, 1), '', now);
    const ad = this.on() ? this.brains.scoreAdj(X.id, x) : { d: 0, p: null, k: 0 };
    c.brain = { x, p: ad.p, d: ad.d, rec, w };
    if (ad.d) c.cs = { ...c.cs, raw: c.cs.score, score: c.cs.score + ad.d };
    return c;
  }
  thinkTrader(X, c, decision, now = Date.now()) {
    if (!c) return; const an = (ids) => ids.map((id) => (this.e.desk.analyst(id) || { name: id }).name);
    const raw = c.cs.raw != null ? c.cs.raw : c.cs.score; const parts = [`${c.coin.symbol} ${c.side}: a favore ${an(c.cs.yes).join(', ') || 'nessuno'}${c.cs.no.length ? `; contro ${an(c.cs.no).join(', ')}` : ''}`, `consenso ${pc(raw)} (soglia ${pc(c.thr)})`];
    if (c.brain && c.brain.p != null) parts.push(`cervello: probabilità di successo ${pc(c.brain.p)} (media ${pc(this.brains.base(X.id))}) → ${c.brain.d >= 0 ? '+' : ''}${(c.brain.d * 100).toFixed(1)} punti`);
    else parts.push(`${this.learning(X.id)}: consenso invariato`);
    if (c.brain && c.brain.rec[0]) parts.push(`ricordo: «${c.brain.rec[0].text}»`);
    if (c.brain && c.brain.w.top) parts.push(`dal web (${c.brain.w.top.source}): «${c.brain.w.top.title}»`);
    parts.push(`decisione: ${decision}`);
    this.st.thoughts[X.id] = { t: now, symbol: c.coin.symbol, side: c.side, text: parts.join(' · ') };
  }

  // ---------- diario dei segnali: ogni voto viene verificato dopo 30 minuti (etichetta per l'allenamento)
  journal(bot, mint, symbol, dir, x, perp, now = Date.now(), why = '') {
    if (!x || !dir) return; const k = `${bot}:${mint}:${dir}`; if (now - (this.st.last[k] || 0) < SAMPLE_GAP_MS) return;
    const px = this.e.market.usd(mint); if (!px) return; this.st.last[k] = now;
    this.st.journal.push({ bot, mint, symbol, dir, px, t: now, x, perp: !!perp, why: String(why).slice(0, 60) });
    if (this.st.journal.length > JOURNAL_MAX) this.st.journal.splice(0, this.st.journal.length - JOURNAL_MAX);
  }
  resolve(now = Date.now()) {
    let n = 0; const keep = [];
    for (const j of this.st.journal) {
      if (now - j.t < HORIZON_MS) { keep.push(j); continue; }
      const px = this.e.market.usd(j.mint); if (!px) { if (now - j.t < 3 * HORIZON_MS) keep.push(j); continue; }
      const move = (j.dir * (px - j.px) / j.px) * 100; const r = move - (j.perp ? FEE.perp : FEE.spot);
      if (this.brains.learn(j.bot, j.x, r > 0, { src: 'segnale', r, key: `j:${j.bot}:${j.mint}:${j.t}`, t: j.t })) n++;
      if (Math.abs(move) >= 1.5) this.memory.add(j.bot, { text: `${j.symbol} ${j.dir > 0 ? 'LONG' : 'SHORT'} ${j.why}: ${move >= 0 ? '+' : ''}${move.toFixed(1)}% in 30 min (${r > 0 ? 'giusto' : 'sbagliato'})`, imp: 0.3, sign: r > 0 ? 1 : -1, src: 'segnale', tags: [j.symbol] }, now);
    }
    this.st.journal = keep; if (n) this.save(); return n;
  }

  // ---------- trade: apertura (salvo le caratteristiche) e chiusura (lezione + allenamento con peso triplo)
  onOpen(p, best) {
    const votes = {}; for (const v of best.votes || []) if (v.dir && v.x) votes[v.id] = { x: v.x, dir: v.dir };
    this.st.posX[p.id] = { votes, trader: best.brain ? best.brain.x : null, bot: best.X ? best.X.id : null, ver: best.X ? this.brains.bot(best.X.id).ver : null };
    p.brainVer = this.st.posX[p.id].ver; this.save();
  }
  onClose(tr, now = Date.now()) {
    const px = this.st.posX[tr.id]; delete this.st.posX[tr.id]; if (!tr) return;
    const win = (tr.pnl || 0) >= 0; const want = tr.side === 'SHORT' ? -1 : 1; const pct = tr.pnlPct || 0;
    const mj = this.e.mentor && this.e.mentor.st.journal.find((x) => x.id === tr.id); const err = mj ? ERR[mj.primary] : null; const reg = tr.ctx && tr.ctx.regime ? `mercato ${tr.ctx.regime}` : '';
    if (px) {
      for (const [id, v] of Object.entries(px.votes)) {
        const right = (v.dir === want) === win; this.brains.learn(id, v.x, right, { src: 'trade', w: 3, r: v.dir === want ? pct : -pct, key: `t:${tr.id}:${id}` });
        const A = this.e.desk.analyst(id);
        this.memory.add(id, { text: `${tr.symbol} ${v.dir > 0 ? 'LONG' : 'SHORT'} ${reg}: il mio voto era ${right ? 'giusto' : 'sbagliato'} (trade ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)${A ? '' : ''}`, imp: 0.4 + Math.min(0.4, Math.abs(pct) / 10), sign: right ? 1 : -1, src: 'trade', tags: [tr.symbol] }, now);
      }
      if (px.trader && px.bot) this.brains.learn(px.bot, px.trader, win, { src: 'trade', w: 3, r: pct, key: `t:${tr.id}:${px.bot}` });
    }
    const bot = tr.bot || (px && px.bot);
    if (bot && this.ids.includes(bot)) this.memory.add(bot, { text: `${tr.symbol} ${tr.side || 'LONG'}${tr.lev > 1 ? ' ' + tr.lev + 'x' : ''} ${reg}: ${win ? 'guadagno' : 'perdita'} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%${err && !win ? ' · ' + err : ''} · ${tr.reason || ''}`, imp: 0.5 + Math.min(0.4, Math.abs(pct) / 8), sign: win ? 1 : -1, src: 'mentore', tags: [tr.symbol, tr.side || 'LONG'] }, now);
    this.save();
  }

  // ---------- ricerca web: un bot ogni 90 s (ognuno circa ogni 20 minuti)
  async webTick(now = Date.now()) {
    if (this.e.cfg.webResearch === false) return null;
    for (let k = 0; k < this.ids.length; k++) {
      const id = this.ids[(this.webCursor + k) % this.ids.length]; if (!this.webOn(id)) continue;
      this.webCursor = (this.webCursor + k + 1) % this.ids.length;
      const coins = (this.e.desk.st.coins || []).map((c) => c.symbol);
      const res = await this.web.research(id, { coins }); this.st.webAt[id] = now;
      for (const f of res.findings || []) if ((Math.abs(f.sentiment) >= 0.5 || f.risk >= 0.5) && (f.assets.length || f.coins.length || f.market || f.source !== 'Google News')) // solo scoperte pertinenti alle cripto this.memory.add(id, { text: `web ${f.source}: ${f.title}`, imp: 0.25 + 0.3 * Math.max(Math.abs(f.sentiment), f.risk), sign: f.risk >= 0.5 ? -1 : Math.sign(f.sentiment), src: 'web', tags: [...f.assets, ...f.coins] }, now);
      this.save(); return { id, n: (res.findings || []).length, errors: res.errors || [] };
    }
    return null;
  }

  // ---------- ripasso sui dati storici (candele 1 minuto gratuite di Binance): analisti e Alpha imparano da migliaia di casi
  async replayFetch(asset, now = Date.now()) {
    const raw = await this.web.get(`https://data-api.binance.vision/api/v3/klines?symbol=${BN[asset]}&interval=1m&limit=1000`, { json: true });
    const c = (Array.isArray(raw) ? raw : []).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).filter((k) => k.c > 0);
    this.rq = { asset, c, i: 200, n: 0 }; this.st.replay[asset] = { t: now, candles: c.length, samples: 0 }; return c.length;
  }
  replayChunk() {
    const q = this.rq; if (!q) return 0; const D = this.e.desk; const end = Math.min(q.c.length - REPLAY.FWD - 1, q.i + REPLAY.CHUNK * REPLAY.STEP); let n = 0;
    const mint = Object.keys(P.SHORT_MARKETS).find((m) => P.SHORT_MARKETS[m] === q.asset) || q.asset;
    for (; q.i < end; q.i += REPLAY.STEP) {
      const c1 = q.c.slice(q.i - 200, q.i + 1); const t = c1[c1.length - 1].t; const px0 = c1[c1.length - 1].c; const fut = q.c.slice(q.i + 1, q.i + 1 + 60);
      const ctx = { coin: { mint, symbol: q.asset, perp: true, market: q.asset }, perp: true, symbol: q.asset, mint, c1, a: S.analyze(c1), rev: S.reversion(c1), st: {}, f: { score: 0, ratio: 0, volAccel: 1, buys: 0, sells: 0 }, ch1: null, ch5: null, ch6: null, liq: null, mc: {}, news: null, macro: null, rs: null };
      if (!ctx.a.ok) continue;
      const votes = D.analyze(ctx, { raw: true }); const move = ((q.c[q.i + REPLAY.FWD].c - px0) / px0) * 100;
      for (const v of votes) { if (!v.dir) continue; const x = features({ dir: v.dir, conf: v.conf, a: ctx.a, f: ctx.f, perp: true, now: t }); const r = v.dir * move - FEE.perp; if (this.brains.learn(v.id, x, r > 0, { src: 'replay', w: 0.5, r, key: `r:${q.asset}:${t}:${v.id}`, t })) n++; }
      // Alpha: operazione «di carta» con stop 1,5% e target 2,7% nei 60 minuti successivi (commissioni incluse)
      const X = D.exec('alpha');
      for (const side of ['LONG', 'SHORT']) {
        const cs = D.consensus(votes, side, X); if (cs.score < X.thr * 0.6 || cs.yes.length < 1) continue;
        const d = side === 'SHORT' ? -1 : 1; let r = null;
        for (const k of fut) { const lo = (d * ((d > 0 ? k.l : k.h) - px0) / px0) * 100, hi = (d * ((d > 0 ? k.h : k.l) - px0) / px0) * 100; if (lo <= -1.5) { r = -1.5; break; } if (hi >= 2.7) { r = 2.7; break; } }
        if (r == null) r = (d * ((fut.length ? fut[fut.length - 1].c : px0) - px0) / px0) * 100;
        r -= FEE.perp; const x = features({ dir: d, conf: clamp(cs.score, 0, 1), a: ctx.a, f: ctx.f, perp: true, now: t });
        if (this.brains.learn('alpha', x, r > 0, { src: 'replay', w: 0.5, r, key: `r:${q.asset}:${t}:alpha:${side}`, t })) n++;
      }
    }
    q.n += n; this.st.replay[q.asset].samples = q.n;
    if (q.i >= q.c.length - REPLAY.FWD - 1) this.rq = null;
    return n;
  }

  // ---------- un passo leggero ogni 30 s: al massimo un lavoro (verifica segnali, ripasso storico, allenamento, laboratorio)
  async tick(now = Date.now()) {
    const t0 = Date.now(); const c0 = process.cpuUsage(); let job = 'verifica';
    try {
      this.resolve(now);
      if (this.rq) { job = `ripasso ${this.rq.asset}`; this.replayChunk(); }
      else {
        const stale = Object.keys(BN).find((a) => !this.st.replay[a] || now - this.st.replay[a].t > REPLAY.EVERY_MS);
        if (stale && process.env.NO_REPLAY !== '1') { job = `scarico storico ${stale}`; try { await this.replayFetch(stale, now); } catch (e) { this.st.replay[stale] = { t: now, err: e.message, candles: 0, samples: 0 }; } }
        else {
          const id = this.ids.find((x) => { const b = this.brains.bot(x); return b.buf.length >= BL.MIN_TRAIN && ((b.stats.newSince || 0) >= 25 || !b.stats.lastTrain) && now - (b.stats.lastTrain || 0) > 5 * 60e3; });
          if (id) { job = `allenamento ${id}`; this.brains.train(id, now); this.brains.bot(id).stats.newSince = 0; }
          else { const r = this.lab.step(now); if (r) job = `laboratorio ${r.bot}`; else if (now - (this.memory.st.curated || 0) > 10 * 60e3) { job = 'cura della memoria'; this.memory.curate(now); } }
        }
      }
      this.save();
    } finally { const cu = process.cpuUsage(c0); const ms = Math.round((cu.user + cu.system) / 1000); Object.assign(this.perf, { ticks: this.perf.ticks + 1, lastMs: ms, wallMs: Date.now() - t0, maxMs: Math.max(this.perf.maxMs, ms), totalMs: this.perf.totalMs + ms, lastJob: job }); } // ms di CPU (l'attesa di rete non conta)
    return job;
  }

  // ---------- vista per l'interfaccia
  botView(id) {
    return { brain: this.brains.status(id), thought: this.st.thoughts[id] || null, memory: this.memory.top(id, 4), memN: this.memory.size(id), web: this.web.latest(id, 3), webOn: this.webOn(id), webOff: !!this.st.webOff[id], webAt: this.st.webAt[id] || null };
  }
  view(trades = []) {
    const byVer = {}; for (const t of trades) if (t.bot && t.brainVer != null) { const k = `${t.bot}:${t.brainVer}`; const o = byVer[k] || (byVer[k] = { n: 0, pnl: 0, wins: 0 }); o.n++; o.pnl += t.pnl || 0; if ((t.pnl || 0) >= 0) o.wins++; }
    const st = this.ids.map((id) => this.brains.status(id)); const ready = st.filter((s) => s.ready);
    const mu = process.memoryUsage();
    return { on: this.on(), webResearch: this.e.cfg.webResearch !== false, bots: Object.fromEntries(this.ids.map((id) => [id, this.botView(id)])),
      summary: { samples: st.reduce((a, s) => a + s.samples, 0), ready: ready.length, total: this.ids.length, avgAcc: ready.length ? +(ready.reduce((a, s) => a + s.valAcc, 0) / ready.length).toFixed(3) : null, lastTrain: Math.max(0, ...st.map((s) => s.lastTrain || 0)) || null, journal: this.st.journal.length, replay: this.st.replay, lessons: this.ids.reduce((a, id) => a + this.memory.size(id), 0), web: { ...this.web.stats } },
      progress: this.lab.progress(byVer), perf: { ...this.perf, avgMs: this.perf.ticks ? Math.round(this.perf.totalMs / this.perf.ticks) : 0, rssMb: Math.round(mu.rss / 1048576), heapMb: Math.round(mu.heapUsed / 1048576) } };
  }
}
module.exports = { Mind, HORIZON_MS, FEE, REPLAY, TICK_BUDGET_MS };
