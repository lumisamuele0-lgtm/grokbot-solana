'use strict';
// LABORATORIO DI AUTO-MIGLIORAMENTO (campione / sfidanti). Nessun sistema impara «in modo esponenziale» per sempre: qui c'è
// un ciclo rigoroso di miglioramento continuo, misurato su dati MAI visti.
// Per ogni bot, una volta al giorno (o quando arrivano ≥ 120 nuovi esempi):
//  1) VALUTAZIONE WALK-FORWARD: gli esempi in ordine di tempo; si allena sul primo 70% e si misura sul 30% più recente
//     (fuori campione): precisione, aspettativa per operazione (% al netto di commissioni e slippage), profit factor, PnL simulato.
//  2) SFIDANTI: 3 varianti del campione (ricerca evolutiva su neuroni nascosti, passo di apprendimento, regolarizzazione e
//     caratteristiche usate). Il campione viene riallenato con le sue impostazioni sugli STESSI dati: confronto alla pari.
//  3) PROMOZIONE solo se uno sfidante batte il campione fuori campione di un margine (aspettativa positiva e +0,02 punti per operazione,
//     precisione non peggiore di 1 punto, almeno 12 operazioni simulate); altrimenti viene scartato. Storico delle versioni
//     con i pesi delle ultime 3 per il ripristino (rollback) manuale o automatico.
// Leggero: un solo bot per passo, passi brevi (≤ ~300 ms) a bassa frequenza, niente thread o librerie pesanti.
const { MLP, trainSet, hashStr, rng, N_IN, FEATURES } = require('./brain');

const RULES = { EVERY_MS: 24 * 3600e3, NEW_MIN: 120, MIN_SAMPLES: 60, SPLIT: 0.7, TAKE_P: 0.55, MARGIN_EXP: 0.02, ACC_TOL: 0.01, MIN_TAKEN: 12, MIN_TEST: 30, CHALLENGERS: 3, KEEP_W: 3, HIST: 30, RUNS: 120, CURVE: 400 };
const MASKS = [[], [16, 17], [14, 15], [8, 9], [10, 11], [12, 13]]; // gruppi di caratteristiche che si possono escludere
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// valuta un insieme di impostazioni con walk-forward (allena sul passato, misura sul futuro)
function walkForward(samples, hp, seed = 1) {
  const s = [...samples].sort((p, q) => p.t - q.t); const cut = Math.floor(s.length * RULES.SPLIT);
  const train = s.slice(0, cut), test = s.slice(cut); if (train.length < 20 || test.length < 10) return null;
  const net = new MLP(seed, N_IN, hp.nH, hp.mask || []);
  const tr = trainSet(net, train, { lr: hp.lr, l2: hp.l2, epochs: hp.epochs, seed });
  tr.net.trainPos = train.reduce((a, z) => a + z.y, 0) / train.length;
  return { net: tr.net, ...metrics(tr.net, test), trainN: train.length };
}
function metrics(net, test) {
  let ok = 0, taken = 0, sum = 0, win = 0, loss = 0, base = 0, baseN = 0; const posR = test.reduce((a, z) => a + z.y, 0) / (test.length || 1);
  const pTrain = net.trainPos != null ? net.trainPos : posR; const takeP = Math.max(RULES.TAKE_P - 0.05, Math.min(0.7, pTrain + 0.05)); // «prende» i casi chiaramente sopra la media
  for (const z of test) {
    const p = net.predict(z.x); if ((p >= 0.5 ? 1 : 0) === z.y) ok++;
    const r = z.r != null ? z.r : z.y ? 0.3 : -0.3; base += r; baseN++;
    if (p >= takeP) { taken++; sum += r; if (r > 0) win += r; else loss -= r; }
  }
  return { acc: +(ok / test.length).toFixed(3), maj: +Math.max(posR, 1 - posR).toFixed(3), n: test.length, taken, exp: taken ? +(sum / taken).toFixed(3) : 0, pf: loss > 0 ? +(win / loss).toFixed(2) : win > 0 ? 9.99 : 0, pnl: +sum.toFixed(2), base: baseN ? +(base / baseN).toFixed(3) : 0 };
}
function mutate(hp, r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = { ...hp, mask: [...(hp.mask || [])] }; const k = Math.floor(r() * 4);
  if (k === 0) out.nH = pick([6, 8, 10, 14].filter((x) => x !== hp.nH));
  else if (k === 1) out.lr = +clamp(hp.lr * pick([0.5, 0.7, 1.5, 2]), 0.003, 0.1).toFixed(4);
  else if (k === 2) out.l2 = +clamp(hp.l2 * pick([0.1, 0.3, 3, 10]), 1e-6, 1e-2).toPrecision(2);
  else out.mask = pick(MASKS.filter((m) => m.join() !== (hp.mask || []).join()));
  return out;
}

class Lab {
  constructor(brains, saved = null, { log = () => {}, now = () => Date.now() } = {}) {
    this.b = brains; this.log = log; this.now = now;
    const sv = saved && saved.v === 1 ? saved : {};
    this.st = { v: 1, bots: {}, runs: Array.isArray(sv.runs) ? sv.runs.slice(0, RULES.RUNS) : [], curve: Array.isArray(sv.curve) ? sv.curve.slice(-RULES.CURVE) : [], totals: { runs: 0, promotions: 0, rejections: 0, rollbacks: 0, ...(sv.totals || {}) } };
    for (const id of brains.ids) { const x = (sv.bots && sv.bots[id]) || {}; this.st.bots[id] = { lastRun: x.lastRun || 0, versions: Array.isArray(x.versions) ? x.versions.slice(0, RULES.HIST) : [], weights: x.weights && typeof x.weights === 'object' ? x.weights : {} }; }
    this.cursor = 0;
  }
  toJSON() { return this.st; }
  due(id, now = this.now()) { const b = this.b.bot(id); const x = this.st.bots[id]; if (!b || !x || b.buf.length < RULES.MIN_SAMPLES) return false; return now - x.lastRun >= RULES.EVERY_MS || (b.stats.newSince || 0) >= RULES.NEW_MIN; }
  // un passo: al massimo UN bot per volta (round robin)
  step(now = this.now(), force = false) {
    const ids = this.b.ids;
    for (let k = 0; k < ids.length; k++) { const id = ids[(this.cursor + k) % ids.length]; if (force || this.due(id, now)) { this.cursor = (this.cursor + k + 1) % ids.length; return this.run(id, now); } }
    return null;
  }
  run(id, now = this.now()) {
    const b = this.b.bot(id); const L = this.st.bots[id]; if (!b || b.buf.length < 30) return null;
    const t0 = Date.now(); const r = rng(hashStr(id) + (L.versions.length + 1) * 7919);
    const champ = walkForward(b.buf, b.hp, hashStr(id)); if (!champ) return null;
    const cands = []; for (let i = 0; i < RULES.CHALLENGERS; i++) { const hp = mutate(b.hp, r); const m = walkForward(b.buf, hp, hashStr(id) + i + 1); if (m) cands.push({ hp, m }); }
    cands.sort((p, q) => q.m.exp - p.m.exp || q.m.acc - p.m.acc);
    const best = cands[0] || null;
    const wins = best && best.m.n >= RULES.MIN_TEST && best.m.taken >= RULES.MIN_TAKEN && best.m.exp > 0 && best.m.exp > champ.exp + RULES.MARGIN_EXP && best.m.acc >= champ.acc - RULES.ACC_TOL; // e aspettativa POSITIVA fuori campione
    const view = (m) => ({ acc: m.acc, maj: m.maj, exp: m.exp, pf: m.pf, taken: m.taken, pnl: m.pnl, base: m.base, n: m.n });
    const run = { t: now, bot: id, ver: b.ver, champ: view(champ), best: best ? { ...view(best.m), hp: hpView(best.hp) } : null, promoted: !!wins, ms: 0 };
    if (wins) {
      L.weights[b.ver] = { net: b.net.toJSON(), hp: b.hp }; // salva il campione uscente per il ripristino
      const full = trainSet(new MLP(hashStr(id) + b.ver, N_IN, best.hp.nH, best.hp.mask || []), b.buf, { lr: best.hp.lr, l2: best.hp.l2, epochs: best.hp.epochs, seed: hashStr(id) });
      b.hp = best.hp; b.net = full.net.clone(); b.ckpt = full.net.clone(); b.ver++;
      b.stats.valAcc = full.val.acc != null ? +full.val.acc.toFixed(3) : b.stats.valAcc; b.stats.lastTrain = now; b.stats.trainings++;
      this.st.totals.promotions++;
      this.log('MENTORE', `🧪 ${id}: sfidante promosso a versione ${b.ver} (fuori campione: aspettativa ${fmt(best.m.exp)} contro ${fmt(champ.exp)}, precisione ${pc(best.m.acc)} contro ${pc(champ.acc)})`);
      const ks = Object.keys(L.weights).map(Number).sort((p, q) => q - p); for (const k of ks.slice(RULES.KEEP_W)) delete L.weights[k];
    } else this.st.totals.rejections++;
    L.versions.unshift({ ver: b.ver, t: now, status: wins ? 'promossa' : 'campione confermato', oos: wins ? view(best.m) : view(champ), challenger: best ? view(best.m) : null, hp: hpView(b.hp), samples: b.buf.length });
    L.versions.length = Math.min(L.versions.length, RULES.HIST);
    L.lastRun = now; b.stats.newSince = 0; this.st.totals.runs++;
    run.ms = Date.now() - t0; this.st.runs.unshift(run); this.st.runs.length = Math.min(this.st.runs.length, RULES.RUNS);
    this.point(now);
    return run;
  }
  // ripristino della versione precedente (manuale o dopo un peggioramento)
  rollback(id, now = this.now()) {
    const b = this.b.bot(id); const L = this.st.bots[id]; if (!b || !L) throw new Error('Bot sconosciuto');
    const ks = Object.keys(L.weights).map(Number).filter((k) => k < b.ver).sort((p, q) => q - p); if (!ks.length) throw new Error('Nessuna versione precedente salvata');
    const w = L.weights[ks[0]]; const net = MLP.from(w.net); if (!net) throw new Error('Pesi salvati non validi');
    b.net = net.clone(); b.ckpt = net.clone(); b.hp = { ...b.hp, ...w.hp }; const from = b.ver; b.ver = ks[0]; delete L.weights[ks[0]];
    L.versions.unshift({ ver: b.ver, t: now, status: `ripristinata (da v${from})`, oos: null, hp: hpView(b.hp), samples: b.buf.length }); L.versions.length = Math.min(L.versions.length, RULES.HIST);
    this.st.totals.rollbacks++; this.log('MENTORE', `↩ ${id}: ripristinata la versione ${b.ver} del cervello`); return { id, ver: b.ver };
  }
  // punto della curva di apprendimento (media dei campioni fuori campione di tutti i bot con dati)
  point(now = this.now()) {
    const last = Object.entries(this.st.bots).map(([id, L]) => L.versions.find((v) => v.oos)).filter(Boolean);
    if (!last.length) return;
    const avg = (k) => +(last.reduce((a, v) => a + v.oos[k], 0) / last.length).toFixed(3);
    const samples = this.b.ids.reduce((a, id) => a + this.b.bot(id).buf.length, 0);
    const p = { t: now, acc: avg('acc'), exp: avg('exp'), pf: avg('pf'), base: avg('base'), bots: last.length, samples, promotions: this.st.totals.promotions };
    const prev = this.st.curve[this.st.curve.length - 1]; if (prev && now - prev.t < 10 * 60e3) this.st.curve[this.st.curve.length - 1] = p; else this.st.curve.push(p);
    if (this.st.curve.length > RULES.CURVE) this.st.curve.splice(0, this.st.curve.length - RULES.CURVE);
  }
  progress(tradesByVer = {}) {
    const bots = Object.fromEntries(this.b.ids.map((id) => { const L = this.st.bots[id]; const b = this.b.bot(id);
      return [id, { ver: b.ver, lastRun: L.lastRun || null, canRollback: Object.keys(L.weights).some((k) => +k < b.ver), versions: L.versions.slice(0, 8).map((v) => ({ ...v, live: tradesByVer[`${id}:${v.ver}`] || null })), nextIn: L.lastRun ? Math.max(0, L.lastRun + RULES.EVERY_MS - this.now()) : 0, newSince: b.stats.newSince || 0 }]; }));
    return { rules: { split: RULES.SPLIT, margin: RULES.MARGIN_EXP, minTaken: RULES.MIN_TAKEN, every: RULES.EVERY_MS, newMin: RULES.NEW_MIN }, totals: this.st.totals, curve: this.st.curve.slice(-120), runs: this.st.runs.slice(0, 15), bots };
  }
}
const hpView = (hp) => ({ nH: hp.nH, lr: hp.lr, l2: hp.l2, mask: (hp.mask || []).map((i) => FEATURES[i]) });
const fmt = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`; const pc = (x) => `${Math.round(x * 100)}%`;
module.exports = { Lab, walkForward, metrics, mutate, RULES, MASKS };
