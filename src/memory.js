'use strict';
// MEMORIA DI FORMAZIONE di ogni bot: le lezioni più importanti per il SUO lavoro (dai trade chiusi, dai post-mortem del Mentore
// e dalle scoperte della ricerca web). Ogni lezione ha un'importanza che decade nel tempo (emivita 7 giorni), cresce quando
// viene confermata o richiamata; i doppioni vengono fusi; al massimo 40 lezioni per bot (si scartano le meno importanti).
// Richiamo per somiglianza con TF-IDF + coseno (leggero, nessun modello esterno). Il Mentore cura la memoria ogni 10 minuti.
const MAX_PER_BOT = 40, HALF_LIFE_MS = 7 * 864e5, DUP_SIM = 0.72, MAX_TEXT = 200;
const STOP = new Set('il lo la i gli le un una di da in con su per tra fra e o a al del della dei delle che non più meno è the of and to in on for a an is are with'.split(' '));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function tokens(text) { return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}$\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 60); }
const clean = (t) => String(t || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); // solo testo: niente markup

class Memory {
  constructor(saved = null, { now = () => Date.now() } = {}) {
    this.now = now; this.st = { v: 1, bots: {}, curated: 0 };
    if (saved && saved.v === 1 && saved.bots) for (const [id, arr] of Object.entries(saved.bots)) if (Array.isArray(arr)) this.st.bots[id] = arr.filter((l) => l && typeof l.text === 'string').slice(0, MAX_PER_BOT).map((l) => ({ ...l, text: clean(l.text), tok: tokens(l.text) }));
    if (saved && saved.curated) this.st.curated = saved.curated;
  }
  list(id) { return this.st.bots[id] || (this.st.bots[id] = []); }
  eff(l, now = this.now()) { return l.imp * Math.pow(0.5, (now - l.t) / HALF_LIFE_MS) + Math.min(0.3, 0.03 * (l.uses || 0)); }
  // aggiunge (o fonde con una lezione quasi uguale). sign: +1 lezione «favorevole», −1 «da evitare», 0 informativa
  add(id, { text, imp = 0.5, sign = 0, src = 'trade', tags = [] }, now = this.now()) {
    const t = clean(text); if (!t) return null; const tok = [...new Set([...tokens(t), ...tags.map((x) => String(x).toLowerCase())])];
    const L = this.list(id);
    for (const l of L) if (sim(tok, l.tok) >= DUP_SIM && l.sign === sign) { l.imp = clamp(Math.max(l.imp, imp) + 0.1, 0, 1); l.t = now; l.n = (l.n || 1) + 1; return l; }
    const l = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, tok, imp: clamp(imp, 0, 1), sign: Math.sign(sign), src: String(src).slice(0, 12), t: now, uses: 0, n: 1 };
    L.push(l); this.prune(id, now); return l;
  }
  prune(id, now = this.now()) { const L = this.list(id); if (L.length <= MAX_PER_BOT) return 0; L.sort((p, q) => this.eff(q, now) - this.eff(p, now)); const n = L.length - MAX_PER_BOT; L.length = MAX_PER_BOT; return n; }
  // richiamo per somiglianza (TF-IDF coseno sulle lezioni del bot) pesato con l'importanza
  recall(id, query, k = 3, now = this.now(), mark = false) {
    const L = this.list(id); if (!L.length) return [];
    const q = Array.isArray(query) ? query : tokens(query); if (!q.length) return [];
    const df = {}; for (const l of L) for (const w of new Set(l.tok)) df[w] = (df[w] || 0) + 1;
    const idf = (w) => Math.log(1 + L.length / (df[w] || 0.5));
    const vec = (tk) => { const v = {}; for (const w of tk) v[w] = (v[w] || 0) + idf(w); return v; };
    const qv = vec(q); const qn = Math.sqrt(Object.values(qv).reduce((a, x) => a + x * x, 0)) || 1;
    const out = [];
    for (const l of L) { const lv = vec(l.tok); let dot = 0; for (const [w, x] of Object.entries(qv)) if (lv[w]) dot += x * lv[w]; if (!dot) continue; const ln = Math.sqrt(Object.values(lv).reduce((a, x) => a + x * x, 0)) || 1; const s = dot / (qn * ln); if (s >= 0.12) out.push({ l, s, score: s * (0.5 + this.eff(l, now)) }); }
    out.sort((p, q2) => q2.score - p.score); const top = out.slice(0, k);
    if (mark) for (const x of top) x.l.uses = (x.l.uses || 0) + 1;
    return top.map((x) => ({ text: x.l.text, sign: x.l.sign, src: x.l.src, sim: +x.s.toFixed(2), imp: +this.eff(x.l, now).toFixed(2) }));
  }
  // valore per la rete neurale: media dei segni delle lezioni simili pesata per somiglianza (−1 … +1)
  signal(recalled) { let a = 0, w = 0; for (const r of recalled) { a += r.sign * r.sim; w += r.sim; } return w ? clamp(a / w, -1, 1) : 0; }
  top(id, k = 5, now = this.now()) { return [...this.list(id)].sort((p, q) => this.eff(q, now) - this.eff(p, now)).slice(0, k).map((l) => ({ text: l.text, sign: l.sign, src: l.src, imp: +this.eff(l, now).toFixed(2), t: l.t, n: l.n || 1 })); }
  // cura del Mentore: decadimento, scarta le lezioni dimenticate (< 0,05), fonde doppioni, rispetta il tetto
  curate(now = this.now()) {
    let removed = 0, merged = 0;
    for (const id of Object.keys(this.st.bots)) {
      const L = this.list(id); const keep = [];
      for (const l of L.sort((p, q) => this.eff(q, now) - this.eff(p, now))) {
        if (this.eff(l, now) < 0.05) { removed++; continue; }
        const d = keep.find((k) => k.sign === l.sign && sim(k.tok, l.tok) >= DUP_SIM); if (d) { d.imp = clamp(d.imp + 0.05, 0, 1); d.n = (d.n || 1) + (l.n || 1); merged++; continue; }
        keep.push(l);
      }
      this.st.bots[id] = keep.slice(0, MAX_PER_BOT); removed += Math.max(0, keep.length - MAX_PER_BOT);
    }
    this.st.curated = now; return { removed, merged };
  }
  size(id) { return this.list(id).length; }
  toJSON() { const bots = {}; for (const [id, L] of Object.entries(this.st.bots)) bots[id] = L.map(({ tok, ...l }) => l); return { v: 1, bots, curated: this.st.curated }; }
}
function sim(a, b) { if (!a.length || !b.length) return 0; const B = new Set(b); let i = 0; for (const w of new Set(a)) if (B.has(w)) i++; return i / (new Set([...a, ...b]).size); }
module.exports = { Memory, tokens, MAX_PER_BOT, HALF_LIFE_MS, sim };
