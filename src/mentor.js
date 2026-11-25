'use strict';
// MENTORE · diario e correzioni automatiche.
// 1) Post-mortem di ogni trade chiuso (simulato e reale): classifica l'errore principale usando il contesto
//    salvato all'entrata (regime, funding, long/short, notizie, volatilità) e il movimento del prezzo nei 60 minuti
//    dopo l'uscita (per capire se lo stop era troppo stretto o l'uscita troppo presto).
// 2) Correzioni piccole e limitate per asset e direzione: moltiplicatore dello stop (0,8–1,3), dei target (1–1,4),
//    selettività degli ingressi (0–3), pause temporanee dei setup perdenti, soglia del rischio notizie.
//    Ogni correzione è graduale e, se dopo 6 trade le cose vanno peggio di prima, viene annullata (rollback).
// MAI toccati: leva (minimo 5x), margine per operazione (7%), stop prima della liquidazione, kill switch, chiavi, PIN.
const path = require('path');
const { readJson, debounceWriter } = require('./store');

const VERSION = 1;
const FOLLOW_MS = 60 * 60e3; // osservazione dopo l'uscita
const LIMITS = { slMult: [0.8, 1.3], tpMult: [1, 1.4], level: [0, 3], newsRiskMax: [0.3, 0.6] };
const STEP = { sl: 0.05, tp: 0.05, level: 0.5 };
const EVAL_N = 6; // trade dopo una correzione prima di giudicarla
const ERR = {
  ok: 'Trade riuscito',
  notizie_rischiose: 'Entrata con notizie ad alto rischio',
  contro_trend: 'Entrata contro il trend di fondo',
  stop_stretto: 'Stop troppo stretto (poi il prezzo è andato nella direzione giusta)',
  funding_avverso: 'Funding/posizionamento avverso (folla dalla stessa parte)',
  commissioni: 'Movimento troppo piccolo: le commissioni hanno mangiato il guadagno',
  senza_slancio: 'Entrata senza slancio (il prezzo non è mai andato a favore)',
  volatilita_alta: 'Volatilità troppo alta per lo stop',
  stop_largo: 'Stop troppo largo per un ingresso sbagliato',
  perdita_normale: 'Perdita nel piano (nessun errore evidente)',
  uscita_prematura: 'Uscita troppo presto (il prezzo ha continuato a favore)',
};
const clamp = (x, [a, b]) => Math.max(a, Math.min(b, x));
const dirOf = (side) => (side === 'SHORT' ? -1 : 1);
const assetOf = (sym) => ({ cbBTC: 'BTC', WBTC: 'BTC', WETH: 'ETH' })[sym] || sym;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const defaults = () => ({ slMult: 1, tpMult: 1, level: 0, newsRiskMax: 0.6, blocks: [], ver: 0, eval: null, n: 0 });

// movimento dopo l'uscita: massimo a favore misurato dall'ENTRATA e dall'USCITA (in % del prezzo)
function afterMove(tr, candles) {
  const d = dirOf(tr.side); const k = (candles || []).filter((c) => c.t > tr.closedAt && c.t <= tr.closedAt + FOLLOW_MS);
  if (k.length < 10) return null;
  const best = d > 0 ? Math.max(...k.map((c) => c.h)) : Math.min(...k.map((c) => c.l));
  const worst = d > 0 ? Math.min(...k.map((c) => c.l)) : Math.max(...k.map((c) => c.h));
  return { favFromEntry: (d * (best - tr.entryPrice) / tr.entryPrice) * 100, favFromExit: (d * (best - tr.exitPrice) / tr.exitPrice) * 100, advFromExit: (d * (worst - tr.exitPrice) / tr.exitPrice) * 100, bars: k.length };
}

// classifica: { primary, tags[], text }
function classify(tr, after = null) {
  const d = dirOf(tr.side); const c = tr.ctx || {}; const R = tr.slPct || 1.5; const tags = [];
  const move = (d * (tr.exitPrice - tr.entryPrice) / tr.entryPrice) * 100; // % del prezzo a favore
  const reason = String(tr.reason || '');
  const isStop = /^Stop-loss|liquidazione/i.test(reason);
  const isExitEarly = /^(Trailing stop|Tempo massimo|Ferma da|Inversione rapida|Rimbalzo rapido|Ondata|Take-profit|Stop a pareggio)/.test(reason);
  if (tr.pnlPct >= 0) {
    if (after && isExitEarly && after.favFromExit >= R) tags.push('uscita_prematura');
    return { primary: tags[0] || 'ok', tags, move };
  }
  if (c.newsRisk != null && c.newsRisk >= 0.4) tags.push('notizie_rischiose');
  if ((d > 0 && c.regime === 'ribasso') || (d < 0 && c.regime === 'rialzo')) tags.push('contro_trend');
  if (isStop && after && after.favFromEntry >= R) tags.push('stop_stretto');
  if ((d > 0 && c.funding != null && c.funding >= 0.0001) || (d < 0 && c.funding != null && c.funding <= -0.00005) || (c.lsrZ != null && d * c.lsrZ >= 1.5)) tags.push('funding_avverso');
  if (move > 0) tags.push('commissioni');
  if ((tr.mfe != null ? tr.mfe : 0) < 0.25 * R && !tags.includes('commissioni')) tags.push('senza_slancio');
  if (tr.atrPct != null && tr.atrPct >= 1.5) tags.push('volatilita_alta');
  if (isStop && R >= 2.5 && (tr.mfe != null ? tr.mfe : 0) < 0.15 * R) tags.push('stop_largo');
  return { primary: tags[0] || 'perdita_normale', tags, move };
}

class Mentor {
  constructor({ dataDir = null, log = () => {} } = {}) {
    this.log = log;
    const saved = dataDir ? readJson(path.join(dataDir, 'mentor.json'), null) : null;
    this.st = saved && saved.v === VERSION ? saved : { v: VERSION, journal: [], pending: [], tune: {}, corrections: [], lessons: [], trained: 0 };
    this.writer = dataDir ? debounceWriter(path.join(dataDir, 'mentor.json'), () => this.st, 1500) : { schedule() {}, flush() {} };
  }
  flush() { this.writer.flush(); }
  key(symbol, side) { return `${assetOf(symbol)}|${side === 'SHORT' ? 'SHORT' : 'LONG'}`; }
  tune(symbol, side) { const k = this.key(symbol, side); return this.st.tune[k] || (this.st.tune[k] = defaults()); }
  // parametri da applicare a un nuovo ingresso (sempre entro i limiti)
  params(symbol, side) { const t = this.tune(symbol, side); return { slMult: clamp(t.slMult, LIMITS.slMult), tpMult: clamp(t.tpMult, LIMITS.tpMult), level: clamp(t.level, LIMITS.level), ver: t.ver }; }

  // il MENTORE può solo rendere più selettivi: mai aumentare dimensione o leva
  entryCheck({ symbol, side, regime = null, atrPct = null, funding = null, newsRisk = 0, conf = 1, flowStrict = true, rsScore = 0, now = Date.now() }) {
    const t = this.tune(symbol, side); const d = dirOf(side);
    t.blocks = t.blocks.filter((b) => b.until > now);
    for (const b of t.blocks) {
      if (b.kind === 'pausa') return { ok: false, reason: `pausa del Mentore dopo perdite di fila (fino alle ${hhmm(b.until)})` };
      if (b.kind === 'regime' && regime && regime === b.regime) return { ok: false, reason: `il Mentore evita ${side} in mercato ${regime} (fino alle ${hhmm(b.until)})` };
      if (b.kind === 'funding' && funding != null && ((d > 0 && funding >= 0.0001) || (d < 0 && funding <= -0.00005))) return { ok: false, reason: 'funding avverso: il Mentore aspetta' };
      if (b.kind === 'atr' && atrPct != null && atrPct >= b.min) return { ok: false, reason: 'volatilità troppo alta per ora (Mentore)' };
    }
    if (newsRisk >= clamp(t.newsRiskMax, LIMITS.newsRiskMax)) return { ok: false, reason: `notizie ad alto rischio (${Math.round(newsRisk * 100)}%)` };
    const L = Math.floor(clamp(t.level, LIMITS.level));
    const ok = L === 0 ? true : L === 1 ? (conf >= 5 / 6 && flowStrict) || rsScore >= 1 : L === 2 ? (conf >= 1 && flowStrict) || rsScore >= 1.2 : conf >= 1 && flowStrict && rsScore >= 0.5;
    if (!ok) return { ok: false, reason: `il Mentore chiede un segnale più forte (selettività ${L}/3)` };
    return { ok: true };
  }
  // preferenza long/short per regime dai trade del diario (piccolo aggiustamento del punteggio, ±0,3)
  prefAdj(side, regime) {
    if (!regime) return 0;
    const j = this.st.journal.filter((x) => x.status === 'final' && x.ctx && x.ctx.regime === regime);
    const a = j.filter((x) => x.side === side).map((x) => x.pnlPct), b = j.filter((x) => x.side !== side).map((x) => x.pnlPct);
    if (a.length < 3 || b.length < 3) return 0;
    return Math.max(-0.3, Math.min(0.3, ((mean(a) - mean(b)) / 10) * 0.3));
  }

  // trade chiuso: annotazione immediata, verifica finale dopo 60 minuti
  onClose(tr) {
    if (this.st.journal.some((x) => x.id === tr.id)) return null;
    const pre = classify(tr, null);
    const e = { id: tr.id, symbol: tr.symbol, side: tr.side === 'SHORT' ? 'SHORT' : 'LONG', lev: tr.lev || 1, mode: tr.mode, openedAt: tr.openedAt, closedAt: tr.closedAt, entryPrice: tr.entryPrice, exitPrice: tr.exitPrice,
      pnlPct: tr.pnlPct, reason: tr.reason, slPct: tr.slPct, atrPct: tr.atrPct, mfe: tr.mfe, mae: tr.mae, ctx: tr.ctx || {}, ver: tr.tuneVer, primary: pre.primary, tags: pre.tags, status: 'pending' };
    this.st.journal.unshift(e); if (this.st.journal.length > 300) this.st.journal.pop();
    this.st.pending.push(e.id); this.st.trained++;
    this.writer.schedule();
    const txt = `post-mortem $${e.symbol} ${e.side} ${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(2)}%: ${ERR[pre.primary]}${pre.tags.length > 1 ? ' · anche ' + pre.tags.slice(1).map((x) => ERR[x].split(' (')[0].toLowerCase()).join(', ') : ''} · verifica finale tra 60 min`;
    this.log('MENTORE', txt);
    return e;
  }
  // verifica i post-mortem scaduti con le candele successive; applica le correzioni. Ritorna le lezioni.
  followUp(candlesOf, now = Date.now()) {
    const out = [];
    for (const id of [...this.st.pending]) {
      const e = this.st.journal.find((x) => x.id === id); if (!e) { this.st.pending = this.st.pending.filter((x) => x !== id); continue; }
      if (now - e.closedAt < FOLLOW_MS) continue;
      const after = afterMove(e, candlesOf(e.symbol));
      if (!after && now - e.closedAt < 3 * FOLLOW_MS) continue; // aspetto ancora qualche candela
      const cl = classify(e, after); e.primary = cl.primary; e.tags = cl.tags; e.after = after; e.status = 'final';
      this.st.pending = this.st.pending.filter((x) => x !== id);
      const corr = this.correct(e, now);
      const lesson = { t: now, id: e.id, symbol: e.symbol, side: e.side, pnlPct: e.pnlPct, primary: cl.primary, text: `${e.symbol} ${e.side} ${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(2)}%: ${ERR[cl.primary]}${after ? ` · dopo l'uscita ${after.favFromExit >= 0 ? '+' : ''}${after.favFromExit.toFixed(2)}% a favore` : ''}`, corrections: corr };
      this.st.lessons.unshift(lesson); if (this.st.lessons.length > 60) this.st.lessons.pop();
      out.push(lesson);
    }
    if (out.length) this.writer.schedule();
    return out;
  }
  // correzione graduale e limitata + valutazione/rollback
  correct(e, now = Date.now()) {
    const k = this.key(e.symbol, e.side); const t = this.st.tune[k] || (this.st.tune[k] = defaults()); const done = [];
    const keyTrades = this.st.journal.filter((x) => x.status === 'final' && this.key(x.symbol, x.side) === k);
    // 1) giudica la correzione precedente
    if (t.eval) {
      t.eval.n++; t.eval.sum += e.pnlPct;
      if (t.eval.n >= EVAL_N) {
        const m = t.eval.sum / t.eval.n;
        if (m < t.eval.baseline - 0.5 && m < 0) {
          Object.assign(t, t.eval.before); t.ver++; done.push(this.note(k, 'rollback', `annullo le correzioni su ${k.replace('|', ' ')}: dopo ${t.eval.n} trade resa media ${m.toFixed(2)}% contro ${t.eval.baseline.toFixed(2)}% di prima`, now));
        } else done.push(this.note(k, 'confermata', `correzioni su ${k.replace('|', ' ')} confermate: resa media ${m.toFixed(2)}% (prima ${t.eval.baseline.toFixed(2)}%)`, now));
        t.eval = null;
      }
    }
    const before = { slMult: t.slMult, tpMult: t.tpMult, level: t.level, newsRiskMax: t.newsRiskMax };
    const recent = keyTrades.slice(0, 6); const cnt = (tag) => recent.filter((x) => (x.tags || []).includes(tag) || x.primary === tag).length;
    const tags = new Set([e.primary, ...(e.tags || [])]);
    const ch = [];
    if (tags.has('stop_stretto')) { const v = clamp(t.slMult + STEP.sl, LIMITS.slMult); if (v !== t.slMult) { t.slMult = v; ch.push(`stop più largo ×${v.toFixed(2)}`); } }
    else if (tags.has('stop_largo')) { const v = clamp(t.slMult - STEP.sl, LIMITS.slMult); if (v !== t.slMult) { t.slMult = v; ch.push(`stop più stretto ×${v.toFixed(2)}`); } }
    if (tags.has('uscita_prematura')) { const v = clamp(t.tpMult + STEP.tp, LIMITS.tpMult); if (v !== t.tpMult) { t.tpMult = v; ch.push(`target più lontani ×${v.toFixed(2)}`); } }
    if (tags.has('commissioni') || tags.has('senza_slancio')) { const v = clamp(t.level + STEP.level, LIMITS.level); if (v !== t.level) { t.level = v; ch.push(`ingressi più selettivi (${v.toFixed(1)}/3)`); } }
    if (tags.has('notizie_rischiose')) { const v = clamp(t.newsRiskMax - 0.1, LIMITS.newsRiskMax); if (v !== t.newsRiskMax) { t.newsRiskMax = v; ch.push(`soglia rischio notizie ${Math.round(v * 100)}%`); } }
    const block = (kind, extra, hours, label) => { if (t.blocks.some((b) => b.kind === kind && b.until > now && (!extra.regime || b.regime === extra.regime))) return; t.blocks.push({ kind, ...extra, until: now + hours * 3600e3 }); ch.push(label); };
    if (tags.has('contro_trend') && cnt('contro_trend') >= 2 && e.ctx.regime) block('regime', { regime: e.ctx.regime }, 6, `niente ${e.side} in mercato ${e.ctx.regime} per 6 ore`);
    if (tags.has('funding_avverso') && cnt('funding_avverso') >= 2) block('funding', {}, 6, 'pausa con funding avverso per 6 ore');
    if (tags.has('volatilita_alta') && cnt('volatilita_alta') >= 2) block('atr', { min: 1.5 }, 6, 'pausa con volatilità alta per 6 ore');
    if (recent.length >= 3 && recent.slice(0, 3).every((x) => x.pnlPct < 0)) block('pausa', {}, 2, `pausa di 2 ore dopo 3 perdite di fila su ${k.replace('|', ' ')}`);
    if (e.primary === 'ok' && !tags.has('uscita_prematura')) { // trade riuscito: si torna piano verso i valori normali
      const lv = Math.max(0, t.level - 0.25); if (lv !== t.level) { t.level = lv; ch.push(`selettività ridotta (${lv.toFixed(1)}/3)`); }
      t.slMult += (1 - t.slMult) * 0.05; t.tpMult += (1 - t.tpMult) * 0.05;
    }
    const changed = before.slMult !== t.slMult || before.tpMult !== t.tpMult || before.level !== t.level || before.newsRiskMax !== t.newsRiskMax;
    if (changed) { t.ver++; if (!t.eval) { const prev = keyTrades.slice(1, 9).map((x) => x.pnlPct); t.eval = { before, baseline: prev.length ? mean(prev) : 0, n: 0, sum: 0, since: now }; } }
    t.n++;
    if (ch.length) done.push(this.note(k, 'correzione', `${k.replace('|', ' ')}: ${ch.join(' · ')}`, now));
    return done;
  }
  note(key, kind, text, t) { const c = { t, key, kind, text }; this.st.corrections.unshift(c); if (this.st.corrections.length > 60) this.st.corrections.pop(); this.log('MENTORE', (kind === 'rollback' ? '↩ ' : kind === 'confermata' ? '✔ ' : '🔧 ') + text); return c; }

  summary() {
    const fin = this.st.journal.filter((x) => x.status === 'final');
    const counts = {}; for (const x of fin) if (x.primary !== 'ok') counts[x.primary] = (counts[x.primary] || 0) + 1;
    const now = Date.now();
    const tune = Object.entries(this.st.tune).map(([k, t]) => ({ key: k, slMult: t.slMult, tpMult: t.tpMult, level: t.level, newsRiskMax: t.newsRiskMax, ver: t.ver, evaluating: t.eval ? t.eval.n : null,
      blocks: t.blocks.filter((b) => b.until > now).map((b) => ({ kind: b.kind, regime: b.regime || null, until: b.until })) })).filter((t) => t.ver || t.blocks.length);
    return { trained: this.st.trained, reviewed: fin.length, pending: this.st.pending.length,
      errors: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, label: ERR[k], n })),
      lessons: this.st.lessons.slice(0, 8), corrections: this.st.corrections.slice(0, 8), tune,
      journal: this.st.journal.slice(0, 6).map((x) => ({ id: x.id, symbol: x.symbol, side: x.side, pnlPct: x.pnlPct, primary: x.primary, label: ERR[x.primary], status: x.status, closedAt: x.closedAt })) };
  }
  publicSummary() { const s = this.summary(); return { trained: s.trained, reviewed: s.reviewed, pending: s.pending, errors: s.errors.map((e) => ({ k: e.k, n: e.n })), corrections: this.st.corrections.length, activeTune: s.tune.length }; }
}
function hhmm(t) { try { return new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }); } catch { return ''; } }
module.exports = { Mentor, classify, afterMove, ERR, LIMITS, EVAL_N };
