'use strict';
// MENTORE: base di conoscenza condivisa, imparata dai trade chiusi (simulati e reali).
// Per ogni "caratteristica" di un setup (tipo token, età, volume, liquidità, ora, volatilità, segnali…)
// tiene vittorie, sconfitte e rendimento medio, con smussamento bayesiano (shrinkage) verso la media
// globale, così poche operazioni non bastano a cambiare il comportamento dei bot.
// Il Mentore può SOLO rendere i bot più selettivi o riordinare i candidati: non tocca mai la dimensione
// (7% del capitale), i filtri minimi, lo stop-loss o il kill switch dell'utente.

const PRIOR = 8; // forza del prior: equivale a 8 trade "medi" immaginari per ogni caratteristica
const MIN_TRADES = 10; // sotto questa soglia il Mentore osserva ma non influenza
const MIN_FEAT_N = 5; // una caratteristica conta solo dopo 5 trade che la contengono
const MODE_W = { SIM: 1, REAL: 1.5 }; // i trade reali pesano un po' di più (esecuzione vera)
const VERSION = 1;

const LABELS = {
  tipo: 'Tipo', eta: 'Età pool', vol: 'Volume 24h', liq: 'Liquidità', ora: 'Fascia oraria', atr: 'Volatilità', rsi: 'RSI',
  flusso: 'Flusso acquisti', lato: 'Lato', pressione: 'Pressione vendite', mom: 'Momentum 15m', trend5: 'Trend 5m', cond: 'Condizioni', mercato: 'Mercato SOL', pump: 'Variazione 1h',
};

function bucket(v, edges, names) { if (v == null || !Number.isFinite(v)) return 'n/d'; for (let i = 0; i < edges.length; i++) if (v < edges[i]) return names[i]; return names[names.length - 1]; }

// Caratteristiche di un candidato al momento dell'ingresso (dati gratuiti già disponibili).
function romeHour(t = Date.now()) { try { return Number(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', hourCycle: 'h23' }).format(t)); } catch { return new Date(t).getHours(); } }
function featuresOf({ s = {}, a = {}, f = {}, core = false, hour = romeHour(), solMom60 = null, side = 'long' }) {
  const h = hour; // ora italiana
  if (side === 'short') {
    // short: stesse famiglie, valori letti "al contrario" (RSI 28–50, momentum e flusso negativi = favorevoli)
    const sh = a.short || {};
    const out = [
      'lato:short', 'tipo:' + (core ? 'principale' : 'meme'),
      'vol:' + bucket(s.volume24h, [50e3, 500e3, 5e6], ['<50k', '50k-500k', '500k-5M', '>5M']),
      'ora:' + bucket(h, [7, 13, 19], ['notte', 'mattina', 'pomeriggio', 'sera']),
      'atr:' + bucket(a.atrPct, [0.5, 1.5, 3], ['bassa', 'media', 'alta', 'estrema']),
      'rsi:' + bucket(a.rsi, [35, 42, 46], ['28-35', '35-42', '42-46', '46-50']),
      'pressione:' + bucket(f.score != null ? -f.score : null, [0, 0.4], ['assente', 'neutra', 'forte']),
      'mom:' + bucket(a.m15 != null ? -a.m15 : null, [0.5, 2], ['debole', 'medio', 'forte']),
      'mercato:' + bucket(solMom60, [-1, 1], ['ribasso', 'laterale', 'rialzo']),
    ];
    if (sh.checks) out.push('cond:' + Object.values(sh.checks).filter(Boolean).length + '/' + Object.keys(sh.checks).length);
    return out.filter((k) => !k.endsWith(':n/d')).map((k) => (k.startsWith('lato:') ? k : 'short.' + k)); // statistiche separate dai long
  }
  const out = [
    'lato:long',
    'tipo:' + (core ? 'principale' : 'meme'),
    'eta:' + (core ? 'storico' : bucket(s.ageHours, [1, 6, 24, 24 * 7], ['<1h', '1-6h', '6-24h', '1-7g', '>7g'])),
    'vol:' + bucket(s.volume24h, [50e3, 500e3, 5e6], ['<50k', '50k-500k', '500k-5M', '>5M']),
    'liq:' + bucket(s.liquidityUsd, [100e3, 1e6, 10e6], ['<100k', '100k-1M', '1M-10M', '>10M']),
    'ora:' + bucket(h, [7, 13, 19], ['notte', 'mattina', 'pomeriggio', 'sera']),
    'atr:' + bucket(a.atrPct, [0.5, 1.5, 3], ['bassa', 'media', 'alta', 'estrema']),
    'rsi:' + bucket(a.rsi, [55, 62, 68], ['50-55', '55-62', '62-68', '68-72']),
    'flusso:' + bucket(f.score, [0, 0.4], ['negativo', 'neutro', 'forte']),
    'mom:' + bucket(a.m15, [0.5, 2], ['debole', 'medio', 'forte']),
    'pump:' + bucket(s.change1h, [0, 5, 15], ['in calo', '0-5%', '5-15%', '>15%']),
    'mercato:' + bucket(solMom60, [-1, 1], ['ribasso', 'laterale', 'rialzo']),
  ];
  if (a.trend5 != null) out.push('trend5:' + (a.trend5 ? 'rialzista' : 'no'));
  if (a.checks) out.push('cond:' + Object.values(a.checks).filter(Boolean).length + '/' + Object.keys(a.checks).length);
  return out.filter((k) => !k.endsWith(':n/d'));
}
const label = (k) => { const [g0, v] = k.split(':'); const sh = g0.startsWith('short.'); const g = sh ? g0.slice(6) : g0; return `${sh ? 'Short · ' : ''}${LABELS[g] || g} ${v}`; };

function empty() { return { v: VERSION, n: 0, wins: 0, sumR: 0, w: 0, sim: 0, real: 0, feats: {}, seen: [], updatedAt: null, lastLesson: null }; }

// Registra un trade chiuso. r = rendimento % netto del trade.
function learn(kb, { id, feat, pnlPct, mode = 'SIM' }) {
  if (!kb || !Number.isFinite(pnlPct)) return false;
  if (id && kb.seen.includes(id)) return false;
  const w = MODE_W[mode] || 1; const win = pnlPct >= 0 ? 1 : 0; const r = Math.max(-50, Math.min(50, pnlPct));
  kb.n += 1; kb.w += w; kb.wins += w * win; kb.sumR += w * r; if (mode === 'REAL') kb.real++; else kb.sim++;
  for (const k of feat || []) {
    const s = kb.feats[k] || (kb.feats[k] = { n: 0, w: 0, wins: 0, sumR: 0 });
    s.n += 1; s.w += w; s.wins += w * win; s.sumR += w * r;
  }
  if (id) { kb.seen.push(id); if (kb.seen.length > 2000) kb.seen.splice(0, kb.seen.length - 2000); }
  kb.updatedAt = Date.now();
  return true;
}

function globalStats(kb) {
  const N = kb.w || 0;
  const p0 = (kb.wins + 0.5 * PRIOR) / (N + PRIOR); // tasso vittorie globale (prior 50%)
  const mu0 = kb.sumR / (N + PRIOR); // rendimento medio globale, smussato verso 0
  return { p0, mu0 };
}
// Statistiche smussate di una caratteristica
function featStats(kb, k) {
  const s = kb.feats[k]; if (!s) return null;
  const { p0, mu0 } = globalStats(kb);
  const winRate = (s.wins + PRIOR * p0) / (s.w + PRIOR);
  const exp = (s.sumR + PRIOR * mu0) / (s.w + PRIOR);
  return { key: k, label: label(k), n: s.n, winRate, exp, edge: exp - mu0, rawWin: s.w ? s.wins / s.w : null };
}

// Valutazione di un setup: aggiustamento del punteggio e, se storicamente perdente, scarto.
function assess(kb, feat) {
  const res = { active: false, adj: 0, skip: false, expected: null, reasons: [], good: [], bad: [] };
  if (!kb || kb.n < MIN_TRADES) return res;
  res.active = true;
  const { mu0 } = globalStats(kb);
  let sumEdge = 0, cnt = 0;
  for (const k of feat || []) {
    const st = featStats(kb, k); if (!st || st.n < MIN_FEAT_N) continue;
    sumEdge += st.edge; cnt++;
    if (st.edge > 0.15) res.good.push(st); else if (st.edge < -0.15) res.bad.push(st);
  }
  res.good.sort((x, y) => y.edge - x.edge); res.bad.sort((x, y) => x.edge - y.edge);
  const edge = cnt ? sumEdge / Math.sqrt(cnt) : 0; // somma attenuata (le caratteristiche non sono indipendenti)
  res.expected = mu0 + (cnt ? sumEdge / cnt : 0);
  res.adj = Math.max(-1.5, Math.min(1, edge / 2)); // in unità del punteggio del CAPO
  // scarto: rendimento atteso negativo E almeno un pattern chiaramente perdente con abbastanza dati
  const strongBad = res.bad.find((b) => b.n >= 8 && b.winRate < 0.4 && b.exp < 0);
  if (res.expected < -0.3 && strongBad) { res.skip = true; res.reasons.push(`${strongBad.label}: ${Math.round(strongBad.winRate * 100)}% vincenti su ${strongBad.n}`); }
  return res;
}

// Peso dei singoli segnali dell'analisi (es. "RSI 50–72") rispetto alla media.
function signalWeights(kb) {
  const out = {};
  for (const k of Object.keys(kb.feats)) { const st = featStats(kb, k); if (st && st.n >= MIN_FEAT_N) out[k] = st; }
  return out;
}

function summary(kb, limit = 3) {
  const list = Object.keys(kb.feats).map((k) => featStats(kb, k)).filter((s) => s && s.n >= MIN_FEAT_N);
  const best = list.filter((s) => s.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, limit);
  const worst = list.filter((s) => s.edge < 0).sort((a, b) => a.edge - b.edge).slice(0, limit);
  const { p0, mu0 } = globalStats(kb);
  const fmt = (s) => ({ label: s.label, n: s.n, winRate: s.winRate, exp: s.exp });
  return { trades: kb.n, sim: kb.sim, real: kb.real, active: kb.n >= MIN_TRADES, need: Math.max(0, MIN_TRADES - kb.n), winRate: kb.n ? p0 : null, exp: kb.n ? mu0 : null,
    best: best.map(fmt), worst: worst.map(fmt), patterns: list.length, updatedAt: kb.updatedAt, lastLesson: kb.lastLesson };
}

function load(raw) {
  const kb = empty();
  if (raw && typeof raw === 'object' && raw.v === VERSION) Object.assign(kb, raw);
  if (!Array.isArray(kb.seen)) kb.seen = [];
  if (!kb.feats || typeof kb.feats !== 'object') kb.feats = {};
  return kb;
}

module.exports = { romeHour, featuresOf, learn, assess, summary, signalWeights, featStats, globalStats, load, empty, label, PRIOR, MIN_TRADES, MIN_FEAT_N };
