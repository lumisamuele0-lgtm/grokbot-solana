'use strict';
// CERVELLO NEURALE dei bot (12 analisti + Alpha e Omega). Ogni bot ha una piccola rete neurale (MLP 18 → 10 → 1, JS puro,
// nessuna dipendenza) che stima la probabilità che il SUO segnale/decisione vada bene, dato il contesto (indicatori, segnale
// grezzo, volatilità, notizie, BTC, ora del giorno, memoria e ricerca web).
// Impara: 1) online a ogni esito (segnali verificati dopo 30 minuti, trade chiusi con peso triplo); 2) con ripasso periodico
// su tutta la storia salvata (e sui dati storici delle candele) con validazione 80/20 ed early stopping; 3) ROLLBACK: se dopo
// l'allenamento la precisione di validazione peggiora, si tengono i pesi precedenti.
// SICUREZZA: l'uscita della rete modifica SOLO la fiducia (analisti ±20%) o il consenso (trader ±5 punti) e solo se la rete ha
// dimostrato in validazione di fare meglio del caso. Non crea segnali dal nulla e non tocca stop, limiti di rischio, anti-truffa,
// blocchi REALE, leva o dimensione massima. I pesi sono salvati cifrati (archivio AES-256-GCM in /data/brain.json).
const N_IN = 18, N_H = 10;
const FEATURES = ['direzione', 'fiducia', 'RSI', 'mom. 5m', 'mom. 15m', 'mom. 60m', 'volatilità', 'flusso', 'notizie', 'rischio notizie', 'BTC 60m', 'paura/avidità', 'leva', 'memecoin', 'ora (sin)', 'ora (cos)', 'memoria', 'web'];
const LIM = { BUF: 600, REPLAY_MAX: 300, MIN_TRAIN: 30, MIN_READY: 40, EPOCHS: 40, PATIENCE: 5, LR: 0.03, L2: 1e-4, ONLINE_LR: 0.01, ROLLBACK_TOL: 0.02, ANALYST_MAX: 0.2, TRADER_MAX: 0.05, EDGE_FULL: 0.1 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : 0));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// generatore pseudo-casuale con seme (pesi iniziali e mescolamento riproducibili)
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function hashStr(t) { let h = 2166136261; for (const c of String(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

const DEF_HP = { nH: N_H, lr: LIM.LR, l2: LIM.L2, epochs: LIM.EPOCHS, mask: [] };
class MLP {
  constructor(seed = 1, nIn = N_IN, nH = N_H, mask = []) {
    this.nIn = nIn; this.nH = nH; this.mask = mask.slice(); const r = rng(seed); const s1 = Math.sqrt(1 / nIn), s2 = Math.sqrt(1 / nH);
    this.W1 = Array.from({ length: nH * nIn }, () => (r() * 2 - 1) * s1); this.b1 = new Array(nH).fill(0);
    this.W2 = Array.from({ length: nH }, () => (r() * 2 - 1) * s2); this.b2 = 0;
  }
  clone() { const m = Object.create(MLP.prototype); Object.assign(m, { nIn: this.nIn, nH: this.nH, mask: (this.mask || []).slice(), W1: this.W1.slice(), b1: this.b1.slice(), W2: this.W2.slice(), b2: this.b2 }); return m; }
  toJSON() { return { nIn: this.nIn, nH: this.nH, mask: this.mask || [], W1: this.W1.map(r4), b1: this.b1.map(r4), W2: this.W2.map(r4), b2: r4(this.b2) }; }
  static from(j) {
    if (!j || j.nIn !== N_IN || !(j.nH >= 2 && j.nH <= 32) || !Array.isArray(j.W1) || j.W1.length !== N_IN * j.nH || !Array.isArray(j.W2) || j.W2.length !== j.nH || !Array.isArray(j.b1) || j.b1.length !== j.nH) return null;
    const ok = (a) => a.every((x) => Number.isFinite(x)); if (!ok(j.W1) || !ok(j.W2) || !ok(j.b1) || !Number.isFinite(j.b2)) return null;
    const m = Object.create(MLP.prototype); Object.assign(m, { nIn: j.nIn, nH: j.nH, mask: Array.isArray(j.mask) ? j.mask.filter((i) => Number.isInteger(i) && i >= 0 && i < N_IN) : [], W1: j.W1.slice(), b1: j.b1.slice(), W2: j.W2.slice(), b2: j.b2 }); return m;
  }
  forward(x0) {
    let x = x0; if (this.mask && this.mask.length) { x = x0.slice(); for (const i of this.mask) x[i] = 0; } // caratteristiche escluse (ricerca evolutiva)
    const h = new Array(this.nH); let z = this.b2;
    for (let j = 0; j < this.nH; j++) { let a = this.b1[j]; const o = j * this.nIn; for (let i = 0; i < this.nIn; i++) a += this.W1[o + i] * (x[i] || 0); h[j] = Math.tanh(a); z += this.W2[j] * h[j]; }
    return { h, p: 1 / (1 + Math.exp(-clamp(z, -30, 30))) };
  }
  predict(x) { return this.forward(x).p; }
  // un passo di discesa del gradiente (entropia incrociata, L2), w = peso del campione
  step(x0, y, lr = LIM.LR, w = 1, l2 = LIM.L2) {
    let x = x0; if (this.mask && this.mask.length) { x = x0.slice(); for (const i of this.mask) x[i] = 0; }
    const { h, p } = this.forward(x); const g = (p - y) * w;
    for (let j = 0; j < this.nH; j++) {
      const gh = g * this.W2[j] * (1 - h[j] * h[j]); this.W2[j] -= lr * (g * h[j] + l2 * this.W2[j]);
      const o = j * this.nIn; for (let i = 0; i < this.nIn; i++) this.W1[o + i] -= lr * (gh * (x[i] || 0) + l2 * this.W1[o + i]);
      this.b1[j] -= lr * gh;
    }
    this.b2 -= lr * g; return p;
  }
  evaluate(set) {
    if (!set.length) return { acc: null, loss: null, n: 0 }; let ok = 0, loss = 0, wt = 0;
    for (const s of set) { const p = this.predict(s.x); const w = s.w || 1; ok += ((p >= 0.5 ? 1 : 0) === s.y ? 1 : 0) * w; loss -= w * (s.y ? Math.log(p + 1e-9) : Math.log(1 - p + 1e-9)); wt += w; }
    return { acc: ok / wt, loss: loss / wt, n: set.length };
  }
}

// allenamento con validazione 80/20 (divisione stabile per id) ed early stopping sulla perdita di validazione
function trainSet(net, samples, { epochs = LIM.EPOCHS, patience = LIM.PATIENCE, lr = LIM.LR, l2 = LIM.L2, seed = 7 } = {}) {
  const tr = [], va = []; for (const s of samples) ((hashStr(s.id) % 5) === 0 ? va : tr).push(s);
  if (!va.length && tr.length > 4) va.push(tr.pop());
  const r = rng(seed); let best = net.clone(); let bestLoss = net.evaluate(va).loss; let bad = 0, ep = 0;
  for (ep = 0; ep < epochs; ep++) {
    for (let i = tr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [tr[i], tr[j]] = [tr[j], tr[i]]; }
    for (const s of tr) net.step(s.x, s.y, lr, s.w || 1, l2);
    const l = net.evaluate(va).loss;
    if (l < bestLoss - 1e-4) { bestLoss = l; best = net.clone(); bad = 0; } else if (++bad >= patience) break;
  }
  return { net: best, val: best.evaluate(va), train: best.evaluate(tr), epochs: ep + 1, valSet: va };
}

// vettore di caratteristiche (18 valori, circa −1…1) per un voto o una decisione
function features({ dir = 0, conf = 0, a = {}, f = {}, news = null, macro = null, perp = false, meme = false, now = Date.now(), mem = 0, web = 0 } = {}) {
  const hr = (new Date(now).getUTCHours() + 1 + new Date(now).getUTCMinutes() / 60) / 24 * Math.PI * 2; // ora di Roma (circa)
  return [clamp(dir, -1, 1), clamp(conf, 0, 1), a.rsi != null ? clamp(a.rsi / 50 - 1, -1, 1) : 0, clamp((a.m5 || 0) / 1.5, -1, 1), clamp((a.m15 || 0) / 3, -1, 1), clamp((a.m60 || 0) / 5, -1, 1),
    clamp((a.atrPct || 0) / 2 - 0.5, -1, 1), clamp(f.score || 0, -1, 1), news ? clamp(news.sentiment || 0, -1, 1) : 0, news ? clamp(news.risk || 0, 0, 1) : 0,
    macro && macro.btc60 != null ? clamp(macro.btc60 / 2, -1, 1) : 0, macro && macro.fng != null ? clamp(macro.fng / 50 - 1, -1, 1) : 0, perp ? 1 : 0, meme ? 1 : 0, Math.sin(hr), Math.cos(hr), clamp(mem, -1, 1), clamp(web, -1, 1)].map(r4);
}

class BrainBank {
  constructor(ids, saved = null, { log = () => {} } = {}) {
    this.log = log; this.ids = ids; this.st = { v: 1, bots: {} };
    const sv = saved && saved.v === 1 && saved.bots ? saved.bots : {};
    for (const id of ids) this.st.bots[id] = this.load(id, sv[id]);
  }
  load(id, j) {
    const net = (j && MLP.from(j.net)) || new MLP(hashStr(id));
    const ckpt = (j && MLP.from(j.ckpt)) || net.clone();
    const buf = j && Array.isArray(j.buf) ? j.buf.filter((s) => s && Array.isArray(s.x) && s.x.length === N_IN && (s.y === 0 || s.y === 1)).slice(-LIM.BUF) : [];
    const hp = { ...DEF_HP, ...(j && j.hp ? j.hp : {}) };
    const stats = { n: 0, trades: 0, online: 0, trainings: 0, rollbacks: 0, valAcc: null, valLoss: null, trainAcc: null, lastTrain: null, lastRollback: null, ...(j && j.stats ? j.stats : {}) };
    return { net, ckpt, buf, stats, hp, ver: (j && j.ver) || 1 };
  }
  bot(id) { return this.st.bots[id] || null; }
  toJSON() { const out = {}; for (const [id, b] of Object.entries(this.st.bots)) out[id] = { net: b.net.toJSON(), ckpt: b.ckpt.toJSON(), buf: b.buf, stats: b.stats, hp: b.hp, ver: b.ver }; return { v: 1, bots: out }; }
  // quanto la rete può influire: 0 finché non ha dati sufficienti e una precisione di validazione sopra il 50%; pieno a +10 punti
  // il riferimento è la classe più frequente (una rete che dice sempre «fallisce» non ha merito): serve battere quel livello
  edge(id) { const b = this.bot(id); if (!b || b.buf.length < LIM.MIN_READY || b.stats.valAcc == null) return 0; return clamp((b.stats.valAcc - Math.max(0.5, b.stats.valMaj || 0.5)) / LIM.EDGE_FULL, 0, 1); }
  base(id) { const b = this.bot(id); return b && b.stats.posRate != null ? b.stats.posRate : 0.5; }
  predict(id, x) { const b = this.bot(id); return b ? b.net.predict(x) : 0.5; }
  // fattore sulla fiducia di un analista: 0,8…1,2 (mai crea o inverte un segnale)
  // centrato sulla frequenza media di successo: in media la fiducia non cambia, sale per i casi migliori della media e scende per i peggiori
  confFactor(id, x) { const k = this.edge(id); if (!k) return { f: 1, p: null, k: 0 }; const p = this.predict(id, x); return { f: 1 + LIM.ANALYST_MAX * k * clamp(2 * (p - this.base(id)), -1, 1), p, k }; }
  // aggiustamento del consenso per un trader: ±0,05
  scoreAdj(id, x) { const k = this.edge(id); if (!k) return { d: 0, p: null, k: 0 }; const p = this.predict(id, x); return { d: LIM.TRADER_MAX * k * clamp(2 * (p - this.base(id)), -1, 1), p, k }; }
  // nuovo esito: salvato nella memoria di allenamento + un passo online leggero
  // r = resa % nella direzione del segnale al netto delle commissioni (serve alla valutazione walk-forward: aspettativa, profit factor)
  learn(id, x, y, { w = 1, src = 'segnale', key = null, r = null, t = Date.now(), online = src !== 'replay' } = {}) {
    const b = this.bot(id); if (!b || !Array.isArray(x) || x.length !== N_IN || x.some((v) => !Number.isFinite(v))) return false;
    if (key && b.buf.some((z) => z.id === key)) return false; // già imparato
    const s = { id: key || `${id}:${t}:${b.stats.n}`, x: x.map(r4), y: y ? 1 : 0, w: clamp(w, 0.1, 5), src, t, r: r == null ? null : +clamp(r, -50, 50).toFixed(3) };
    b.buf.push(s);
    if (src === 'replay') { const rp = b.buf.filter((z) => z.src === 'replay'); if (rp.length > LIM.REPLAY_MAX) { const drop = new Set(rp.sort((p, q) => p.t - q.t).slice(0, rp.length - LIM.REPLAY_MAX)); b.buf = b.buf.filter((z) => !drop.has(z)); } }
    if (b.buf.length > LIM.BUF) b.buf.splice(0, b.buf.length - LIM.BUF);
    b.stats.n++; if (src === 'trade') b.stats.trades++; if (src === 'replay') b.stats.replay = (b.stats.replay || 0) + 1;
    if (online) { b.net.step(s.x, s.y, LIM.ONLINE_LR, s.w, b.hp.l2); b.stats.online++; }
    b.stats.newSince = (b.stats.newSince || 0) + 1;
    return true;
  }
  // ripasso completo con validazione; ROLLBACK se la nuova rete (o quella aggiornata online) è peggiore del checkpoint
  train(id, now = Date.now()) {
    const b = this.bot(id); if (!b || b.buf.length < LIM.MIN_TRAIN) return null;
    const res = trainSet(b.ckpt.clone(), b.buf, { seed: hashStr(id) + b.stats.trainings, lr: b.hp.lr, l2: b.hp.l2, epochs: b.hp.epochs });
    const old = b.ckpt.evaluate(res.valSet), live = b.net.evaluate(res.valSet);
    const first = b.stats.valAcc == null;
    const cands = [{ k: 'precedente', net: b.ckpt, m: old }, { k: 'nuova', net: res.net, m: res.val }, { k: 'online', net: b.net, m: live }].sort((p, q) => q.m.acc - p.m.acc || p.m.loss - q.m.loss);
    // a parità resta la versione precedente (si cambia solo se c'è un miglioramento misurato)
    const pick = first ? cands.find((c) => c.k !== 'precedente') : cands[0];
    const rolled = !first && pick.k === 'precedente' && (live.acc < old.acc - LIM.ROLLBACK_TOL || res.val.acc < old.acc - LIM.ROLLBACK_TOL);
    b.net = pick.net.clone(); b.ckpt = pick.net.clone();
    b.stats.trainings++; b.stats.lastTrain = now; b.stats.valAcc = +pick.m.acc.toFixed(3); b.stats.valLoss = +pick.m.loss.toFixed(3); b.stats.trainAcc = res.train.acc != null ? +res.train.acc.toFixed(3) : null; b.stats.epochs = res.epochs; b.stats.valN = res.valSet.length;
    const pos = (set) => (set.length ? set.reduce((a, z) => a + z.y, 0) / set.length : 0.5); const vp = pos(res.valSet);
    b.stats.valMaj = +Math.max(vp, 1 - vp).toFixed(3); b.stats.posRate = +pos(b.buf).toFixed(3);
    if (rolled) { b.stats.rollbacks++; b.stats.lastRollback = now; this.log('MENTORE', `🧠 ${id}: allenamento peggiorativo (validazione ${(res.val.acc * 100).toFixed(0)}% < ${(old.acc * 100).toFixed(0)}%): ripristino i pesi precedenti`); }
    return { id, picked: pick.k, rolled, valAcc: b.stats.valAcc, n: b.buf.length };
  }
  // le caratteristiche che hanno pesato di più per questa decisione (sensibilità: variazione della probabilità azzerando ognuna)
  explain(id, x, k = 3) {
    const b = this.bot(id); if (!b) return []; const p0 = b.net.predict(x);
    return x.map((v, i) => { if (!v) return null; const y = x.slice(); y[i] = 0; return { f: FEATURES[i], d: p0 - b.net.predict(y) }; }).filter(Boolean).sort((p, q) => Math.abs(q.d) - Math.abs(p.d)).slice(0, k).map((z) => ({ f: z.f, d: +z.d.toFixed(3) }));
  }
  status(id) { const b = this.bot(id); if (!b) return null; const s = b.stats; const ex = b.buf.filter((z) => z.src === 'trade').length;
    return { ver: b.ver, hp: { nH: b.hp.nH, lr: b.hp.lr, mask: b.hp.mask.map((i) => FEATURES[i]) }, replay: b.buf.filter((z) => z.src === 'replay').length, samples: b.buf.length, learned: s.n, trades: ex, trainings: s.trainings, valAcc: s.valAcc, trainAcc: s.trainAcc, lastTrain: s.lastTrain, rollbacks: s.rollbacks, lastRollback: s.lastRollback, valMaj: s.valMaj || null, posRate: s.posRate != null ? s.posRate : null, edge: +this.edge(id).toFixed(2), ready: this.edge(id) > 0, minReady: LIM.MIN_READY }; }
}
module.exports = { MLP, BrainBank, trainSet, features, FEATURES, LIM, N_IN, N_H, DEF_HP, hashStr, rng };
