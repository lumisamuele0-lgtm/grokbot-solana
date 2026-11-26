'use strict';
// RAZZO · «Cacciatore di Razzi»: il trader delle memecoin, SOLO token di Solana scambiabili su Jupiter (il motore di swap che usa
// Phantom). Cerca memecoin giovani dove volume, holder e acquisti crescono più in fretta del prezzo; filtri anti-rug rigidi;
// puntate configurabili con stop rigido; uscite a scaglioni (parte a +100%, parte a +300%, il resto con trailing largo).
// ONESTÀ: la grande maggioranza delle memecoin va a zero. Il punteggio misura una probabilità, non una promessa.
// Fonti gratuite, senza chiave: Jupiter Tokens v2 (trending/organic/traded/recent, audit, holder), DexScreener (boost, profili,
// social, transazioni 5 min), GeckoTerminal (pool di tendenza), RugCheck (rischi, LP bloccata), RPC (autorità mint/freeze).
// Phantom non offre un'API pubblica per il trending (403): lo approssimiamo con Jupiter + DexScreener + GeckoTerminal.
// APPRENDIMENTO: ogni candidato visto viene seguito per 24 ore (massimo guadagno / massimo calo) anche se non comprato;
// la rete neurale di Razzo impara cosa anticipa un razzo (+100% prima di −50%) e corregge il punteggio di ±8 punti al massimo,
// solo dopo aver battuto in validazione la classe più frequente.
const path = require('path');
const { fetchJson, rateQueue } = require('./util');
const { JUP_BASE, jupQueue: jq } = require('./jupiter');
const { readJson, debounceWriter } = require('./store');
const { BrainBank, LIM: BLIM } = require('./brain');

const dq = rateQueue(1100); const gq = rateQueue(7000);
const RK = { SCAN_MS: 90e3, GECKO_MS: 300e3, TRACK_MS: 180e3, TRACK_H: 24, TRACK_MAX: 400, DONE_MAX: 1500, RADAR: 30, SPARK: 40,
  RUG_PER_SCAN: 8, DEX_MAX: 90, FAST_MS: 4000, EMERG_MS: 60e3, QUOTE_TTL: 180e3, HIT: 100, DUMP: -50, BRAIN_PTS: 8, ID: 'razzo' };
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL = 'So11111111111111111111111111111111111111112';
const EXCL_TAGS = ['stable', 'stocks', 'rwa', 'lst', 'major', 'equities', 'xstocks', 'original-lst'];
const JUP_LISTS = ['toptrending/5m', 'toptrending/1h', 'toporganicscore/5m', 'toptraded/5m', 'recent'];
const FEATS = ['età', 'accel. volume 5m', 'accel. volume 1h', 'pressione acquisti 5m', 'pressione acquisti 1h', 'acquirenti netti', 'crescita holder 1h', 'crescita holder 5m', 'organic score',
  'liquidità/mcap', 'liquidità', 'prezzo 1h', 'prezzo 6h', 'social', 'trending/boost', 'top10 holder', 'dev seriale', 'pump.fun graduato'];
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a));
const r2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (Number.isFinite(+x) ? +x : null);

// ---------- normalizzazione dei dati
function normJup(t, now = Date.now()) {
  if (!t || !t.id) return null; const a = t.audit || {}; const st = (k) => t[k] || {};
  const born = Date.parse((t.firstPool && t.firstPool.createdAt) || t.createdAt || '') || null;
  return { mint: t.id, symbol: String(t.symbol || '?').replace(/^\$+/, '').trim().slice(0, 14), name: String(t.name || '').slice(0, 40), decimals: t.decimals, program: t.tokenProgram,
    launchpad: t.launchpad || null, graduated: !!t.graduatedPool, pool: t.graduatedPool || (t.firstPool && t.firstPool.id) || null, ageH: born ? (now - born) / 3.6e6 : null,
    price: num(t.usdPrice), mcap: num(t.mcap) || num(t.fdv), liq: num(t.liquidity) || 0, holders: num(t.holderCount) || 0, organic: num(t.organicScore) || 0, verified: !!t.isVerified, tags: t.tags || [],
    s5: st('stats5m'), s1: st('stats1h'), s6: st('stats6h'), s24: st('stats24h'),
    audit: { mintOff: a.mintAuthorityDisabled === true, freezeOff: a.freezeAuthorityDisabled === true, top10: num(a.topHoldersPercentage), devPct: num(a.devBalancePercentage), devMints: num(a.devMints) || 0, devMigr: num(a.devMigrations) || 0, sus: !!a.isSus },
    social: { web: !!t.website, x: !!t.twitter, tg: !!t.telegram }, src: new Set(), rank: {}, boost: 0 };
}
function mergeDex(c, p) {
  if (!c || !p) return c; const tx = p.txns || {}, v = p.volume || {}, pc = p.priceChange || {}, info = p.info || {};
  c.dex = p.dexId || null; c.pairAddress = p.pairAddress || c.pairAddress; c.dexUrl = p.url || null;
  c.d = { b5: (tx.m5 && tx.m5.buys) || 0, s5: (tx.m5 && tx.m5.sells) || 0, b1: (tx.h1 && tx.h1.buys) || 0, s1: (tx.h1 && tx.h1.sells) || 0, v5: v.m5 || 0, v1: v.h1 || 0, v6: v.h6 || 0, v24: v.h24 || 0, p5: num(pc.m5), p1: num(pc.h1), p6: num(pc.h6), p24: num(pc.h24) };
  const so = info.socials || []; if ((info.websites || []).length) c.social.web = true; if (so.some((s) => s.type === 'twitter')) c.social.x = true; if (so.some((s) => s.type === 'telegram')) c.social.tg = true;
  if (p.boosts && p.boosts.active) c.boost = Math.max(c.boost, p.boosts.active);
  if (!c.liq && p.liquidity) c.liq = p.liquidity.usd || 0;
  return c;
}
const vol = (s) => (s.buyVolume || 0) + (s.sellVolume || 0);
const bp = (s) => { const t = vol(s); return t > 0 ? (s.buyVolume || 0) / t : 0.5; };
// numeri derivati (punteggio, caratteristiche della rete, spiegazioni)
function metrics(c) {
  const v5 = vol(c.s5), v1 = vol(c.s1), v6 = vol(c.s6);
  const p1 = c.s1.priceChange != null ? c.s1.priceChange : c.d ? c.d.p1 : null; const p6 = c.s6.priceChange != null ? c.s6.priceChange : c.d ? c.d.p6 : null;
  const p5 = c.s5.priceChange != null ? c.s5.priceChange : c.d ? c.d.p5 : null;
  return { accel5: v1 > 0 ? (v5 * 12) / v1 : 0, accel1: v6 > 0 ? (v1 * 6) / v6 : 0, bp5: bp(c.s5), bp1: bp(c.s1), net1: (c.s1.numTraders || 0) > 0 ? (c.s1.numNetBuyers || 0) / c.s1.numTraders : 0,
    h1: c.s1.holderChange || 0, h5: c.s5.holderChange || 0, liqMcap: c.mcap > 0 ? c.liq / c.mcap : 0, p5, p1, p6, v5, v1,
    social: (c.social.web ? 1 : 0) + (c.social.x ? 1 : 0) + (c.social.tg ? 1 : 0), trend: Object.keys(c.rank).length, serial: c.audit.devMints > 2000 && c.audit.devMigr / Math.max(1, c.audit.devMints) < 0.01 };
}
// 18 caratteristiche (−1…1) per la rete di Razzo
function features(c) {
  const m = metrics(c); const age = c.ageH == null ? 0 : clamp(Math.log10(Math.max(0.1, c.ageH)) / 2, -1, 1);
  return [age, clamp((m.accel5 - 1) / 3, -1, 1), clamp((m.accel1 - 1) / 3, -1, 1), clamp(m.bp5 * 2 - 1, -1, 1), clamp(m.bp1 * 2 - 1, -1, 1), clamp(m.net1 * 3, -1, 1), clamp(m.h1 / 20, -1, 1), clamp(m.h5 / 5, -1, 1),
    clamp(c.organic / 50 - 1, -1, 1), clamp(m.liqMcap / 0.15 - 1, -1, 1), clamp(Math.log10(Math.max(1, c.liq)) / 3 - 1.5, -1, 1), clamp((m.p1 || 0) / 100, -1, 1), clamp((m.p6 || 0) / 300, -1, 1),
    m.social / 3, clamp(m.trend / 3 + (c.boost ? 0.3 : 0), 0, 1), clamp((c.audit.top10 || 0) / 50, 0, 1), m.serial ? 1 : 0, c.graduated ? 1 : 0].map((x) => Math.round(x * 1e3) / 1e3);
}

// ---------- punteggio 0–100
function scoreCand(c, cfg = {}) {
  const m = metrics(c); const parts = []; const add = (k, pts, max, txt) => { pts = clamp(pts, 0, max); parts.push({ k, pts: Math.round(pts * 10) / 10, max, txt }); return pts; };
  let s = 0;
  const a = c.ageH; const ageOk = a != null && a >= (cfg.rocketMinAgeH || 0.5) && a <= (cfg.rocketMaxAgeH || 72);
  s += add('età', !ageOk ? 0 : a >= 1 && a <= 24 ? 10 : 6, 10, a == null ? 'età sconosciuta' : a < 1 ? `nata da ${Math.round(a * 60)} min` : a < 48 ? `nata da ${a.toFixed(1)} h` : `nata da ${(a / 24).toFixed(1)} giorni`);
  s += add('volume', clamp((m.accel5 - 1) / 2, 0, 1) * 10 + clamp((m.accel1 - 1) / 2, 0, 1) * 8, 18, `volume 5 min ×${m.accel5.toFixed(1)} la media dell'ora, 1 h ×${m.accel1.toFixed(1)} la media di 6 h`);
  s += add('acquisti', clamp((m.bp5 - 0.5) / 0.2, 0, 1) * 5 + clamp((m.bp1 - 0.5) / 0.2, 0, 1) * 4 + clamp(m.net1 / 0.3, 0, 1) * 5, 14, `acquisti ${Math.round(m.bp5 * 100)}% del volume (5 min), acquirenti netti ${Math.round(m.net1 * 100)}%`);
  s += add('holder', clamp(m.h1 / 15, 0, 1) * 10 + clamp(m.h5 / 3, 0, 1) * 4, 14, `holder ${m.h1 >= 0 ? '+' : ''}${m.h1.toFixed(1)}% in 1 h (${c.holders})`);
  s += add('organico', clamp(c.organic / 100, 0, 1) * 7 + clamp((c.s1.numOrganicBuyers || 0) / 30, 0, 1) * 3, 10, `organic score ${Math.round(c.organic)} · ${c.s1.numOrganicBuyers || 0} acquirenti organici`);
  s += add('liquidità', clamp(m.liqMcap / 0.15, 0, 1) * 5 + clamp(Math.log10(Math.max(1, c.liq / 20000)) / 1.2, 0, 1) * 3, 8, `liquidità $${Math.round(c.liq / 1000)}k · ${Math.round(m.liqMcap * 100)}% della capitalizzazione`);
  const p1 = m.p1 || 0, p6 = m.p6 || 0;
  const fresh = p1 < -20 ? 2 : p1 <= 100 ? 10 : 10 * (1 - clamp((p1 - 100) / 300, 0, 1));
  s += add('non tirata', fresh * (p6 > 1000 ? 0.3 : p6 > 500 ? 0.6 : 1) * ((m.p5 || 0) < -15 ? 0.5 : 1), 10, `prezzo ${p1 >= 0 ? '+' : ''}${p1.toFixed(0)}% in 1 h, ${p6 >= 0 ? '+' : ''}${p6.toFixed(0)}% in 6 h`);
  s += add('social', (c.social.web ? 3 : 0) + (c.social.x ? 3 : 0) + (c.social.tg ? 2 : 0), 8, ['sito', 'X', 'Telegram'].filter((_, i) => [c.social.web, c.social.x, c.social.tg][i]).join(' · ') || 'nessun social');
  const best = Math.min(...Object.values(c.rank).concat([999]));
  s += add('tendenza', (best <= 10 ? 4 : best <= 40 ? 3 : best < 999 ? 2 : 0) + (c.boost ? 2 : 0) + (c.src.has('gecko') ? 2 : 0) + (c.rankUp ? 1 : 0), 8, `${m.trend ? `in ${m.trend} classifiche Jupiter (miglior posto ${best})` : 'fuori dalle classifiche'}${c.boost ? ' · boost DexScreener' : ''}${c.src.has('gecko') ? ' · trending GeckoTerminal' : ''}`);
  if (m.serial) { s -= 5; parts.push({ k: 'dev seriale', pts: -5, max: 0, txt: `il creatore ha lanciato ${c.audit.devMints} token` }); }
  const score = Math.round(clamp(s, 0, 100));
  const badges = parts.filter((p) => p.max && p.pts >= p.max * 0.7).map((p) => p.k);
  return { score, parts, badges, m };
}

// ---------- cancelli anti-rug (rigidi)
// rapidi: solo dati già scaricati; i controlli costosi (RugCheck, RPC, quote andata/ritorno) arrivano dopo, solo per i migliori
function quickGates(c, cfg, prev = null) {
  const f = []; const m = metrics(c);
  if (c.tags.some((t) => EXCL_TAGS.includes(t)) || c.mint === SOL || c.mint === USDC || (c.mcap || 0) > 3e8) f.push({ code: 'non-meme', label: 'non è una memecoin' });
  if (c.ageH == null || c.ageH < (cfg.rocketMinAgeH || 0.5)) f.push({ code: 'troppo-giovane', label: `troppo giovane (< ${Math.round((cfg.rocketMinAgeH || 0.5) * 60)} min)` });
  else if (c.ageH > (cfg.rocketMaxAgeH || 72)) f.push({ code: 'vecchia', label: `fuori finestra (> ${cfg.rocketMaxAgeH || 72} h)` });
  if (c.liq < (cfg.rocketMinLiqUsd || 25000)) f.push({ code: 'liquidità', label: `liquidità $${Math.round(c.liq / 1000)}k < $${Math.round((cfg.rocketMinLiqUsd || 25000) / 1000)}k` });
  if (!c.audit.mintOff) f.push({ code: 'mint', label: 'autorità di mint attiva' });
  if (!c.audit.freezeOff) f.push({ code: 'freeze', label: 'autorità di freeze attiva' });
  if (c.audit.top10 == null || c.audit.top10 > (cfg.rocketMaxTop10Pct || 30)) f.push({ code: 'holder', label: `top 10 holder ${c.audit.top10 == null ? 'sconosciuti' : Math.round(c.audit.top10) + '%'} > ${cfg.rocketMaxTop10Pct || 30}%` });
  if (c.audit.sus) f.push({ code: 'sospetto', label: 'segnalato sospetto da Jupiter' });
  if (c.audit.devPct != null && c.audit.devPct > 10) f.push({ code: 'dev', label: `il dev tiene ancora il ${c.audit.devPct.toFixed(0)}%` });
  if (prev && prev.devPct != null && prev.devPct > 1 && c.audit.devPct != null && c.audit.devPct < prev.devPct * 0.5) f.push({ code: 'dev-vende', label: `il dev sta vendendo (${prev.devPct.toFixed(1)}% → ${c.audit.devPct.toFixed(1)}%)` });
  if ((m.p1 || 0) > 300 || (m.p5 || 0) > 60) f.push({ code: 'verticale', label: `già salita in verticale (${(m.p1 || 0).toFixed(0)}% in 1 h)` });
  if (!c.price) f.push({ code: 'prezzo', label: 'nessun prezzo su Jupiter' });
  return f;
}
// sicurezza on-chain + RugCheck: LP bruciata/bloccata ≥ 90% (o pool pump.fun graduato, LP bruciata per costruzione)
function safetyGates(c, sf) {
  const f = []; if (!sf) return [{ code: 'verifica', label: 'verifica di sicurezza non riuscita' }];
  if (sf.mintAuthority) f.push({ code: 'mint', label: 'autorità di mint attiva (on-chain)' });
  if (sf.freezeAuthority) f.push({ code: 'freeze', label: 'autorità di freeze attiva (on-chain)' });
  if (sf.token2022Ext) f.push({ code: 'token2022', label: 'estensioni Token-2022 rischiose (tasse, delega, blocchi)' });
  if ((sf.danger || []).length) f.push({ code: 'rugcheck', label: `RugCheck: ${sf.danger.slice(0, 2).join(', ')}` });
  if (sf.rugScore == null && sf.rugError) f.push({ code: 'rugcheck', label: 'RugCheck non raggiungibile' });
  const lp = sf.lpLockedPct; const gradPump = c.graduated && (c.launchpad === 'pump.fun' || c.dex === 'pumpswap');
  if (!(lp >= 90) && !gradPump) f.push({ code: 'lp', label: `LP bloccata/bruciata ${lp == null ? 'sconosciuta' : Math.round(lp) + '%'} < 90%` });
  return f;
}
// andata e ritorno su Jupiter con la stessa dimensione: quanto si perde comprando e rivendendo subito (tasse + impatto + commissioni)
function roundTripLoss(sizeRaw, backRaw) { const a = Number(sizeRaw), b = Number(backRaw); return a > 0 && b >= 0 ? r2(Math.max(0, (1 - b / a) * 100)) : 100; }

// ---------- rischio: secchiello memecoin e dimensione
function rocketPositions(book) { return (book.positions || []).filter((p) => p.bot === RK.ID); }
function bucketRoom(book, equity, cfg) {
  const used = rocketPositions(book).reduce((a, p) => a + (p.costBase || 0), 0); const cap = equity * (cfg.rocketBucketPct / 100);
  return { cap, used, room: Math.max(0, cap - used), open: rocketPositions(book).length };
}
function sizeFor(score, equity, cfg, room, cash) {
  const pct = Math.min(20, cfg.rocketTradePct); const k = clamp(0.6 + ((score - cfg.rocketMinScore) / Math.max(1, 100 - cfg.rocketMinScore)) * 0.4, 0.6, 1); // 60–100% della puntata
  return Math.max(0, Math.min(equity * (pct / 100) * k, room, cash));
}

// ---------- uscite: stop rigido, scaglioni, trailing, tempo; uscite d'emergenza
function ladderExit(p, px, now, cfg) {
  const R = p.rocket || {}; const e = p.entryPrice; if (!px || !e) return { action: 'hold' };
  const ch = (px / e - 1) * 100; p.highest = Math.max(p.highest || e, px); const peak = (p.highest / e - 1) * 100;
  const sl = R.sl != null ? R.sl : cfg.rocketSlPct; const tp1 = R.tp1 || cfg.rocketTp1Pct, tp2 = R.tp2 || cfg.rocketTp2Pct; const trail = R.trail || cfg.rocketTrailPct;
  if (ch <= -sl) return { action: 'close', reason: `Stop rigido −${sl}% (${ch.toFixed(1)}%)`, change: ch, hard: true };
  if (!p.r1Done && ch >= tp1) return { action: 'partial', frac: (R.s1 || cfg.rocketTp1Sell) / 100, stage: 'R1', reason: `Scaglione 1: +${tp1}% (vendo il ${R.s1 || cfg.rocketTp1Sell}%)`, change: ch };
  if (p.r1Done && !p.r2Done && ch >= tp2) { const s1 = R.s1 || cfg.rocketTp1Sell, s2 = R.s2 || cfg.rocketTp2Sell; return { action: 'partial', frac: Math.min(1, s2 / Math.max(1, 100 - s1)), stage: 'R2', reason: `Scaglione 2: +${tp2}% (vendo un altro ${s2}%)`, change: ch }; }
  if (p.r1Done) { // dopo il primo scaglione: trailing dal massimo, mai sotto il pareggio
    const ts = Math.max(p.highest * (1 - trail / 100), e * 1.02); p.trailStop = ts;
    if (px <= ts) return { action: 'close', reason: `Trailing −${trail}% dal massimo (+${peak.toFixed(0)}%)`, change: ch };
  }
  const ageH = (now - p.openedAt) / 3.6e6; const tsH = R.timeH || cfg.rocketTimeStopH;
  if (!p.r1Done && ageH >= tsH && peak < 20) return { action: 'close', reason: `Nessuno slancio dopo ${tsH} h (massimo +${peak.toFixed(0)}%)`, change: ch };
  return { action: 'hold', change: ch };
}
// segnali di rug sulle posizioni aperte: liquidità crollata, dev che vende, nessuna via di vendita
function isRouteFail(err) {
  const m = String((err && err.message) || err || '');
  if (/429|Too many|timeout|abort|HTTP 5\d\d|fetch failed|ECONN|ENOTFOUND/i.test(m)) return false;
  return /Nessuna rotta|ROUTE|HTTP 4\d\d|No route/i.test(m);
}
function emergency(p, info = {}) {
  const R = p.rocket || {};
  // ogni fonte si confronta solo con sé stessa (Jupiter somma tutti i pool, DexScreener spesso solo il principale)
  const drop = (a, b) => `Emergenza: liquidità crollata (${Math.round(b / 1000)}k → ${Math.round(a / 1000)}k $)`;
  if (info.liq != null && R.liq0 > 0 && info.liq < R.liq0 * 0.5) return drop(info.liq, R.liq0);
  if (info.liqDex != null && R.liqDex0 > 0 && info.liqDex < R.liqDex0 * 0.5) return drop(info.liqDex, R.liqDex0);
  if (info.devPct != null && R.dev0 != null && R.dev0 > 1 && info.devPct < R.dev0 * 0.5) return `Emergenza: il dev sta vendendo (${R.dev0.toFixed(1)}% → ${info.devPct.toFixed(1)}%)`;
  if ((R.routeFails || 0) >= 2) return 'Emergenza: la via di vendita su Jupiter non risponde';
  if (info.danger && info.danger.length) return `Emergenza: RugCheck ${info.danger[0]}`;
  return null;
}

// ---------- statistiche per fascia di punteggio
const BUCKETS = [[0, 40], [40, 60], [60, 70], [70, 80], [80, 101]];
function bucketStats(done) {
  return BUCKETS.map(([lo, hi]) => {
    const xs = done.filter((d) => d.score >= lo && d.score < hi); const n = xs.length; const pc = (f) => (n ? Math.round((xs.filter(f).length / n) * 100) : null);
    return { lo, hi: hi > 100 ? 100 : hi, n, x2: pc((d) => d.max >= 100), x15: pc((d) => d.max >= 50), dump: pc((d) => d.min <= -50), avgMax: n ? Math.round(xs.reduce((a, d) => a + d.max, 0) / n) : null, safe: n ? Math.round((xs.filter((d) => d.ok).length / n) * 100) : null };
  });
}

class Rocket {
  constructor(engine, { dataDir = null } = {}) {
    this.e = engine; this.dataDir = dataDir;
    const sv = (dataDir && readJson(path.join(dataDir, 'rocket.json'), null)) || {};
    this.st = { v: 1, track: Array.isArray(sv.track) ? sv.track.slice(-RK.TRACK_MAX) : [], done: Array.isArray(sv.done) ? sv.done.slice(-RK.DONE_MAX) : [], seen: sv.seen || {}, totals: { scans: 0, seen: 0, rejected: {}, bought: 0, ...(sv.totals || {}) }, best: sv.best || null, thought: sv.thought || null };
    this.brain = new BrainBank([RK.ID], sv.brain || null, { log: (a, t) => this.e.log(a, t) });
    this.w = dataDir ? debounceWriter(path.join(dataDir, 'rocket.json'), () => ({ v: 1, track: this.st.track, done: this.st.done, seen: this.st.seen, totals: this.st.totals, best: this.st.best, thought: this.st.thought, brain: this.brain.toJSON() }), 15000) : { schedule() {}, flush() {} };
    this.radar = []; this.lastScan = null; this.geckoAt = 0; this.gecko = new Set(); this.prevRank = {}; this.spark = {}; this.sources = {}; this.busy = false; this.rt = {}; this.errors = [];
  }
  save() { this.w.schedule(); } flush() { this.w.flush(); }
  cfg() { return this.e.cfg; }
  on() { return this.cfg().rocketOn !== false; }

  // ---------- raccolta candidati
  async collect(now = Date.now()) {
    const cands = new Map(); const err = []; const src = {};
    const put = (t, tag, rank) => { const c = cands.get(t.id) || normJup(t, now); if (!c) return; c.src.add(tag); if (rank != null) c.rank[tag] = Math.min(c.rank[tag] || 999, rank + 1); cands.set(c.mint, c); };
    // limite gratuito di Jupiter: a ogni giro 2 classifiche fisse + 1 a rotazione (ogni classifica torna ogni 3 giri)
    this.rot = ((this.rot || 0) + 1) % 3; const lists = ['toptrending/5m', 'recent', ['toptrending/1h', 'toporganicscore/5m', 'toptraded/5m'][this.rot]];
    this.lists = this.lists || {};
    for (const l of lists) {
      try { const r = await jq(() => fetchJson(`${JUP_BASE}/tokens/v2/${l}?limit=100`, { retries: 0, timeout: 12000 })); if (Array.isArray(r)) this.lists[l] = { t: now, r }; }
      catch (e) { err.push(`Jupiter ${l}: ${String(e.message).replace(/https?:\/\/\S+/g, '').trim()}`); }
    }
    // le classifiche non aggiornate in questo giro (rotazione o limite gratuito 429) restano valide fino a 5 minuti
    for (const l of JUP_LISTS) { const L = this.lists[l]; if (!L || now - L.t > 5 * 60e3) continue; L.r.forEach((t, i) => put(t, 'jup:' + l, l === 'recent' ? null : i)); src['Jupiter ' + l] = L.r.length; }
    const extra = new Map(); // mint → boost
    for (const u of ['token-boosts/latest/v1', 'token-boosts/top/v1', 'token-profiles/latest/v1']) {
      try { const r = await dq(() => fetchJson(`https://api.dexscreener.com/${u}`, { retries: 0 })); let n = 0; for (const x of r || []) if (x.chainId === 'solana' && x.tokenAddress) { n++; extra.set(x.tokenAddress, Math.max(extra.get(x.tokenAddress) || 0, x.totalAmount || x.amount || 0)); } src['DexScreener ' + u.split('/')[0]] = n; }
      catch (e) { err.push(`DexScreener ${u}: ${e.message}`); }
    }
    if (now - this.geckoAt > RK.GECKO_MS) {
      try { const r = await gq(() => fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1', { retries: 0 })); const s = new Set();
        for (const p of (r && r.data) || []) { const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id; if (id && id.startsWith('solana_')) s.add(id.slice(7)); }
        this.gecko = s; this.geckoAt = now; } catch (e) { err.push(`GeckoTerminal: ${e.message}`); }
    }
    src['GeckoTerminal trending'] = this.gecko.size;
    const missing = [...new Set([...extra.keys(), ...this.gecko])].filter((m) => !cands.has(m)).slice(0, 100);
    if (missing.length) { await new Promise((r) => setTimeout(r, 1500)); try { const r = await jq(() => fetchJson(`${JUP_BASE}/tokens/v2/search?query=${missing.join(',')}`, { retries: 0, timeout: 12000 })); for (const t of r || []) put(t, 'dex', null); } catch (e) { err.push(`Jupiter search: ${e.message}`); } }
    for (const [m, b] of extra) { const c = cands.get(m); if (c) { c.src.add('dex'); c.boost = Math.max(c.boost, b ? 1 : 0); } }
    for (const m of this.gecko) { const c = cands.get(m); if (c) c.src.add('gecko'); }
    for (const c of cands.values()) { const best = Math.min(...Object.values(c.rank).concat([999])); const pb = this.prevRank[c.mint]; c.rankUp = pb != null && best < pb - 5; this.prevRank[c.mint] = best; }
    return { cands: [...cands.values()], err, src };
  }
  async enrichDex(list) {
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      try { const pairs = await dq(() => fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.map((c) => c.mint).join(',')}`, { retries: 0 }));
        for (const c of chunk) { const own = (pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken && p.baseToken.address === c.mint).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0)); if (own[0]) mergeDex(c, own[0]); }
      } catch (e) { this.errors.push(`DexScreener tokens: ${e.message}`); }
    }
  }
  brainAdj(x) { const s = this.brain.scoreAdj(RK.ID, x); return { d: Math.round((s.d / BLIM.TRADER_MAX) * RK.BRAIN_PTS * 10) / 10, p: s.p, k: s.k }; }

  // ---------- un giro completo del cacciatore
  async scan(now = Date.now()) {
    if (this.busy || !this.on()) return null; this.busy = true; this.errors = [];
    try {
      const cfg = this.cfg(); const { cands, err, src } = await this.collect(now); this.errors.push(...err); this.sources = src;
      const held = new Set(this.e.book.positions.map((p) => p.mint));
      let list = cands.filter((c) => c.price && c.liq >= 5000 && !c.tags.some((t) => EXCL_TAGS.includes(t)) && (c.mcap || 0) <= 3e8);
      for (const c of list) { c.pre = scoreCand(c, cfg).score; }
      list.sort((a, b) => b.pre - a.pre);
      await this.enrichDex(list.slice(0, RK.DEX_MAX));
      const out = []; let rugN = 0; const rej = {};
      for (const c of list) {
        const sc = scoreCand(c, cfg); const x = features(c); const ba = this.brainAdj(x);
        c.score = Math.round(clamp(sc.score + ba.d, 0, 100)); c.raw = sc.score; c.brain = ba; c.parts = sc.parts; c.badges = sc.badges; c.x = x;
        const seen = this.st.seen[c.mint]; const fails = quickGates(c, cfg, seen);
        this.st.seen[c.mint] = { t: now, devPct: c.audit.devPct != null ? c.audit.devPct : seen && seen.devPct, sym: c.symbol, liq: c.liq || null };
        let sf = this.e.market.safety[c.mint] || null;
        if (!fails.length && c.score >= cfg.rocketMinScore - 15 && (rugN < RK.RUG_PER_SCAN || sf)) {
          if (!sf || now - sf.ts > 30 * 60e3) { rugN++; sf = await this.e.market.checkSafety(c.mint, (m) => this.e.chainMintInfo(m)).catch(() => null); }
          fails.push(...safetyGates(c, sf));
          c.safeChecked = true;
        }
        c.fails = fails; c.sf = sf ? { lp: sf.lpLockedPct != null ? Math.round(sf.lpLockedPct) : null, rug: sf.rugScore, danger: sf.danger || [], mintAuth: !!sf.mintAuthority, freezeAuth: !!sf.freezeAuthority, t22: !!sf.token2022Ext } : null;
        c.status = fails.length ? 'scartato' : !c.safeChecked ? 'osserva' : c.score >= cfg.rocketMinScore ? 'pronto' : 'osserva';
        for (const f of fails) rej[f.code] = (rej[f.code] || 0) + 1;
        const sp = this.spark[c.mint] || (this.spark[c.mint] = []); sp.push(+c.price.toPrecision(6)); if (sp.length > RK.SPARK) sp.shift();
        this.trackAdd(c, now, held.has(c.mint));
        out.push(c);
      }
      for (const k of Object.keys(rej)) this.st.totals.rejected[k] = (this.st.totals.rejected[k] || 0) + rej[k];
      const seenCut = now - 3 * 864e5; for (const [m, v] of Object.entries(this.st.seen)) if (v.t < seenCut) delete this.st.seen[m];
      for (const m of Object.keys(this.spark)) if (!out.some((c) => c.mint === m) && !held.has(m)) delete this.spark[m];
      out.sort((a, b) => (a.status === 'scartato') - (b.status === 'scartato') || b.score - a.score);
      this.radar = out.slice(0, RK.RADAR); this.lastScan = { t: now, found: cands.length, scored: out.length, ready: out.filter((c) => c.status === 'pronto').length, rejected: out.filter((c) => c.status === 'scartato').length, rej };
      this.st.totals.scans++; this.st.totals.seen += out.length;
      this.think(now);
      if (this.e.cfg.trading && !this.e.book.killed) await this.turn(now);
      this.save();
      return this.lastScan;
    } finally { this.busy = false; }
  }
  think(now) {
    const ready = this.radar.filter((c) => c.status === 'pronto'); const top = this.radar.find((c) => c.status !== 'scartato') || this.radar[0];
    const S = this.lastScan; let t;
    if (!top) t = 'Nessun candidato utile in questo giro: le fonti non hanno restituito memecoin con prezzo su Jupiter.';
    else if (ready.length) { const c = ready[0]; const why = c.parts.filter((p) => p.max && p.pts >= p.max * 0.6).slice(0, 3).map((p) => p.txt).join('; ');
      t = `$${c.symbol} a ${c.score}/100 passa tutti i controlli anti-rug: ${why}. ${ready.length > 1 ? `Altri ${ready.length - 1} pronti.` : ''} Entro solo se l'andata e ritorno su Jupiter costa meno del ${this.cfg().rocketMaxRtPct}%.`; }
    else { const miss = top.fails && top.fails.length ? `scartata: ${top.fails[0].label}` : top.score < this.cfg().rocketMinScore ? `punteggio ${top.score} < ${this.cfg().rocketMinScore}` : 'controlli di sicurezza in corso';
      t = `Ho esaminato ${S.scored} memecoin (${S.rejected} scartate dai filtri anti-rug). La migliore è $${top.symbol} a ${top.score}/100, ma ${miss}. Aspetto: meglio nessun ingresso che un rug.`; }
    this.st.thought = { t: now, text: t };
  }

  // ---------- ingressi
  blocked() {
    const cfg = this.cfg(); const e = this.e;
    if (!this.on()) return 'Cacciatore di Razzi spento';
    if (!cfg.trading) return 'Bot in pausa';
    if (cfg.mode === 'REAL' && !cfg.realSpot) return 'Spot REALE spento: in REALE Razzo non compra (attivalo in Impostazioni solo quando vuoi soldi veri)';
    if (cfg.mode === 'REAL' && !e.ks.kp) return 'Portafoglio bloccato';
    if (!e.book || e.book.killed) return 'Kill switch';
    return null;
  }
  async turn(now = Date.now()) {
    const cfg = this.cfg(); const e = this.e; const b = e.book; const blk = this.blocked(); if (blk) { this.lastBlock = blk; return []; }
    const opened = [];
    for (const c of this.radar.filter((x) => x.status === 'pronto')) {
      const eq = e.equity(); const S = e.limitsCheck(0); if (S.kill) { await e.killSwitch(S.reason); break; } if (!S.canOpen) { this.lastBlock = S.reason; break; }
      const room = bucketRoom(b, eq, cfg); if (room.open >= cfg.rocketMaxOpen) { this.lastBlock = `già ${room.open} memecoin aperte (max ${cfg.rocketMaxOpen})`; break; }
      if (b.positions.some((p) => p.mint === c.mint)) continue;
      const cd = b.cooldown[`${RK.ID}:${c.mint}:LONG`]; if (cd && cd > now) continue;
      const minTrade = cfg.baseCurrency === 'SOL' ? 0.01 : 2; const size = sizeFor(c.score, eq, cfg, room.room, e.cash());
      if (size < minTrade) { this.lastBlock = room.room < minTrade ? `secchiello memecoin pieno (${e.fmtBase(room.used)} su ${e.fmtBase(room.cap)})` : 'liquidità insufficiente'; break; }
      const rt = await this.roundTrip(c, size).catch((er) => ({ ok: false, err: er.message }));
      c.rt = rt;
      if (!rt.ok) { c.status = 'scartato'; c.fails = [...(c.fails || []), { code: 'andata-ritorno', label: rt.err || `andata e ritorno ${rt.loss.toFixed(1)}% > ${cfg.rocketMaxRtPct}%` }]; this.st.totals.rejected['andata-ritorno'] = (this.st.totals.rejected['andata-ritorno'] || 0) + 1; b.cooldown[`${RK.ID}:${c.mint}:LONG`] = now + 30 * 60e3; continue; }
      const p = await this.open(c, size, rt);
      if (p) { opened.push(p); this.st.totals.bought++; }
    }
    return opened;
  }
  async roundTrip(c, size) {
    const cfg = this.cfg(); const e = this.e; const base = e.base; const raw = BigInt(Math.floor(size * 10 ** base.decimals));
    const k = `${c.mint}:${Math.round(size)}`; const hit = this.rt[k]; if (hit && Date.now() - hit.t < RK.QUOTE_TTL) return hit;
    const buy = await e.jup.quote(base.mint, c.mint, raw, cfg.rocketSlipBps);
    let back; try { back = await e.jup.quote(c.mint, base.mint, BigInt(buy.outAmount), cfg.rocketSlipBps); } catch (er) { return { ok: false, loss: 100, err: 'nessuna via di vendita su Jupiter (honeypot?)' }; }
    const loss = roundTripLoss(raw, back.outAmount); const imp = Number(buy.priceImpactPct || 0) * 100;
    const r = { t: Date.now(), ok: loss <= cfg.rocketMaxRtPct, loss: r2(loss), impact: r2(imp), err: loss > cfg.rocketMaxRtPct ? `andata e ritorno −${loss.toFixed(1)}% > ${cfg.rocketMaxRtPct}% (tasse o liquidità sottile)` : null };
    this.rt[k] = r; return r;
  }
  async open(c, size, rt) {
    const cfg = this.cfg(); const e = this.e;
    const plan = { slPct: cfg.rocketSlPct, tpPct: cfg.rocketTp1Pct, trailPct: cfg.rocketTrailPct, atrPct: null };
    e.agent('DIMENSIONE', `Razzo: ${e.fmtBase(size)} su $${c.symbol} (${((size / e.equity()) * 100).toFixed(1)}% del capitale, punteggio ${c.score}/100)`, 'size', { token: c.symbol, size, bot: RK.ID });
    const p = await e.openPosition({ m: c.mint, s: { symbol: c.symbol, decimals: c.decimals }, bot: RK.ID, maxImpact: Math.max(cfg.maxPriceImpactPct, cfg.rocketMaxRtPct / 2), ctx: { rocket: true, score: c.score }, a: {} }, size, plan);
    if (!p) return null;
    p.rocket = { score: c.score, raw: c.raw, sl: cfg.rocketSlPct, tp1: cfg.rocketTp1Pct, s1: cfg.rocketTp1Sell, tp2: cfg.rocketTp2Pct, s2: cfg.rocketTp2Sell, trail: cfg.rocketTrailPct, timeH: cfg.rocketTimeStopH, liq0: c.liq, dev0: c.audit.devPct, rt: rt.loss, x: c.x, badges: c.badges, why: c.parts.filter((q) => q.max && q.pts >= q.max * 0.6).map((q) => q.txt).slice(0, 3) };
    const t = `🚀 compro $${c.symbol} · punteggio ${c.score}/100 · stop rigido −${cfg.rocketSlPct}% · scaglioni +${cfg.rocketTp1Pct}% (${cfg.rocketTp1Sell}%) e +${cfg.rocketTp2Pct}% (${cfg.rocketTp2Sell}%) · trailing ${cfg.rocketTrailPct}%`;
    e.log('RAZZO', t); e.agent('ESECUZIONE', t, 'buy', { token: c.symbol, bot: RK.ID });
    this.st.thought = { t: Date.now(), text: `Sono entrato su $${c.symbol} (${c.score}/100): ${p.rocket.why.join('; ')}. Stop rigido a −${cfg.rocketSlPct}%: sulle memecoin lo stop può scivolare oltre.` };
    e.save(); this.save(); return p;
  }

  // ---------- sorveglianza veloce (ogni 4 s) ed emergenze (ogni 60 s)
  async fast(now = Date.now()) {
    const ps = rocketPositions(this.e.book).filter((p) => !p.closing); if (!ps.length) return 0;
    try { await this.e.market.refreshPrices(ps.map((p) => p.mint)); } catch { return 0; }
    let n = 0; for (const p of ps) { const px = this.e.priceBase(p.mint); if (px && await this.check(p, px, now)) n++; }
    return n;
  }
  async check(p, px, now = Date.now()) {
    if (p.closing) return false; const r = ladderExit(p, px, now, this.cfg());
    if (r.action === 'close') { this.e.log('RAZZO', `$${p.symbol}: ${r.reason}`); await this.e.sellPosition(p, 1, r.reason); return true; }
    if (r.action === 'partial') { await this.e.sellPosition(p, r.frac, r.reason, null, r.stage); return true; }
    return false;
  }
  async emergencyTick() {
    const ps = rocketPositions(this.e.book).filter((p) => !p.closing); if (!ps.length) return;
    try { await this.e.market.refreshStats(ps.map((p) => p.mint)); } catch {}
    for (const p of ps) {
      const s = this.e.market.stats[p.mint] || {}; const seen = this.st.seen[p.mint] || {}; const sf = this.e.market.safety[p.mint] || {};
      try { const raw = BigInt(p.qtyRaw); await this.e.jup.quote(p.mint, this.e.base.mint, raw / 10n > 0n ? raw / 10n : raw, this.cfg().rocketSlipBps); p.rocket.routeFails = 0; }
      catch (err) { if (isRouteFail(err)) p.rocket.routeFails = (p.rocket.routeFails || 0) + 1; } // 429/timeout = rete, non rug
      const liqDex = s.liquidityUsd > 0 ? s.liquidityUsd : null; if (liqDex && !(p.rocket.liqDex0 > 0)) p.rocket.liqDex0 = liqDex;
      const liq = seen.liq > 0 && seen.t > (p.openedAt || 0) ? seen.liq : null;
      const why = emergency(p, { liq, liqDex, devPct: seen.devPct, danger: sf.danger });
      if (why) { this.e.log('RAZZO', `$${p.symbol}: ${why} → vendo subito`, 'warn'); await this.e.sellPosition(p, 1, why); }
    }
  }

  // ---------- apprendimento: ogni candidato seguito per 24 h
  trackAdd(c, now, held) {
    const T = this.st.track; const cur = T.find((x) => x.mint === c.mint);
    if (cur && !(c.score >= this.cfg().rocketMinScore && cur.score < this.cfg().rocketMinScore && !c.fails.length)) { cur.lastScore = c.score; return; } // nuovo «segnale» solo se ora è sopra soglia
    if (T.length >= RK.TRACK_MAX) { const i = T.reduce((bi, x, j) => (x.score < T[bi].score ? j : bi), 0); if (T[i].score >= c.score) return; T.splice(i, 1); }
    T.push({ id: `${c.mint}:${now}`, mint: c.mint, sym: c.symbol, t0: now, p0: c.price, score: c.score, raw: c.raw, ok: !c.fails.length, fails: c.fails.map((f) => f.code).slice(0, 4), x: c.x, max: 0, min: 0, last: 0, bought: held });
  }
  async trackTick(now = Date.now()) {
    const T = this.st.track; if (!T.length) return 0;
    const mints = [...new Set(T.map((x) => x.mint))];
    try { await this.e.market.refreshPrices(mints); } catch { return 0; }
    let fin = 0;
    for (const x of [...T]) {
      const px = this.e.market.usd(x.mint); if (px && x.p0) { const ch = (px / x.p0 - 1) * 100; x.max = Math.max(x.max, ch); x.min = Math.min(x.min, ch); x.last = ch; if (x.hitAt == null && ch >= RK.HIT) x.hitAt = now; if (x.dumpAt == null && ch <= RK.DUMP) x.dumpAt = now; }
      if (now - x.t0 >= RK.TRACK_H * 3.6e6 || (x.dumpAt && !x.hitAt) || x.hitAt) { this.finish(x, now); fin++; }
    }
    if (fin && this.st.done.filter((d) => d.x).length >= BLIM.MIN_TRAIN && (!this.trainedAt || now - this.trainedAt > 30 * 60e3)) { this.brain.train(RK.ID, now); this.trainedAt = now; }
    this.save(); return fin;
  }
  finish(x, now) {
    this.st.track = this.st.track.filter((y) => y !== x);
    const y = x.hitAt && (!x.dumpAt || x.hitAt <= x.dumpAt) ? 1 : 0;
    const d = { id: x.id, mint: x.mint, sym: x.sym, t0: x.t0, t1: now, score: x.score, ok: x.ok, max: r2(x.max), min: r2(x.min), y, bought: !!x.bought };
    this.st.done.push(d); if (this.st.done.length > RK.DONE_MAX) this.st.done.splice(0, this.st.done.length - RK.DONE_MAX);
    if (Array.isArray(x.x) && x.x.length === 18) this.brain.learn(RK.ID, x.x, y, { src: 'razzo', key: x.id, r: x.max, w: x.ok ? 1.5 : 1 });
    if (!this.st.best || d.max > this.st.best.max) this.st.best = { sym: d.sym, mint: d.mint, max: d.max, score: d.score, t0: d.t0, ok: d.ok };
  }

  scoreOf(mint) { const c = this.radar.find((x) => x.mint === mint); return c ? { score: c.score, status: c.status, why: c.fails && c.fails[0] ? c.fails[0].label : null } : null; }
  // ---------- viste
  candView(c) {
    return { mint: c.mint, symbol: c.symbol, name: c.name, score: c.score, raw: c.raw, brain: c.brain && c.brain.d ? c.brain.d : 0, status: c.status, badges: c.badges, parts: c.parts,
      fails: (c.fails || []).map((f) => f.label), ageH: c.ageH != null ? r2(c.ageH) : null, liq: Math.round(c.liq), mcap: c.mcap ? Math.round(c.mcap) : null, holders: c.holders, price: c.price,
      p1: metrics(c).p1 != null ? r2(metrics(c).p1) : null, p5: c.s5.priceChange != null ? r2(c.s5.priceChange) : null, launchpad: c.launchpad, dex: c.dex || null, graduated: c.graduated, social: c.social,
      checks: [
        { k: 'Autorità di mint revocata', ok: c.audit.mintOff && !(c.sf && c.sf.mintAuth) },
        { k: 'Autorità di freeze revocata', ok: c.audit.freezeOff && !(c.sf && c.sf.freezeAuth) },
        { k: 'LP bruciata/bloccata ≥ 90% o pool pump.fun graduato', ok: c.sf ? c.sf.lp >= 90 || (c.graduated && (c.launchpad === 'pump.fun' || c.dex === 'pumpswap')) : null },
        { k: `Top 10 holder ≤ ${this.cfg().rocketMaxTop10Pct}%${c.audit.top10 != null ? ` (${Math.round(c.audit.top10)}%)` : ''}`, ok: c.audit.top10 != null && c.audit.top10 <= this.cfg().rocketMaxTop10Pct },
        { k: `Dev non sta vendendo${c.audit.devPct != null ? ` (tiene ${c.audit.devPct.toFixed(1)}%)` : ''}`, ok: !(c.fails || []).some((f) => f.code === 'dev' || f.code === 'dev-vende') },
        { k: 'RugCheck senza pericoli', ok: c.sf ? !c.sf.danger.length && c.sf.rug != null : null },
        { k: `Liquidità ≥ $${Math.round(this.cfg().rocketMinLiqUsd / 1000)}k`, ok: c.liq >= this.cfg().rocketMinLiqUsd },
        { k: `Andata e ritorno su Jupiter ≤ ${this.cfg().rocketMaxRtPct}%${c.rt ? ` (${c.rt.loss}%)` : ''}`, ok: c.rt ? c.rt.ok : null },
      ], spark: (this.spark[c.mint] || []).slice(-RK.SPARK), rt: c.rt || null,
      links: { phantom: `https://phantom.com/tokens/solana/${c.mint}`, solscan: `https://solscan.io/token/${c.mint}`, dexscreener: `https://dexscreener.com/solana/${c.mint}`, jupiter: `https://jup.ag/tokens/${c.mint}` } };
  }
  posView(p) {
    const R = p.rocket || {}; const px = this.e.priceBase(p.mint); const ch = px && p.entryPrice ? (px / p.entryPrice - 1) * 100 : 0; const peak = p.highest && p.entryPrice ? (p.highest / p.entryPrice - 1) * 100 : 0;
    const val = px ? p.qty * px : p.costBase; const pnl = val - p.costBase - (p.feesBase || 0) + (p.realizedPart || 0);
    return { id: p.id, symbol: p.symbol, mint: p.mint, costBase: p.origCost || p.costBase, value: val, pnl, change: r2(ch), peak: r2(peak), score: R.score, sl: R.sl, tp1: R.tp1, tp2: R.tp2, s1: R.s1, s2: R.s2, trail: R.trail,
      r1: !!p.r1Done, r2: !!p.r2Done, trailStop: p.trailStop && p.entryPrice ? r2((p.trailStop / p.entryPrice - 1) * 100) : null, soldPct: p.initQty ? Math.round((1 - p.qty / p.initQty) * 100) : 0, openedAt: p.openedAt, why: R.why || [], rt: R.rt,
      links: { phantom: `https://phantom.com/tokens/solana/${p.mint}`, solscan: `https://solscan.io/token/${p.mint}`, dexscreener: `https://dexscreener.com/solana/${p.mint}` } };
  }
  view() {
    const cfg = this.cfg(); const b = this.e.book; const eq = this.e.equity(); const room = bucketRoom(b, eq, cfg);
    const trades = b.trades.filter((t) => t.bot === RK.ID); const wins = trades.filter((t) => t.pnl >= 0).length;
    const bs = this.brain.status(RK.ID);
    return { on: this.on(), t: Date.now(), lastScan: this.lastScan, thought: this.st.thought, blocked: this.blocked() || this.lastBlock || null, sources: this.sources, errors: this.errors.slice(0, 4),
      radar: this.radar.map((c) => this.candView(c)), positions: rocketPositions(b).map((p) => this.posView(p)),
      bucket: { cap: room.cap, used: room.used, room: room.room, open: room.open, max: cfg.rocketMaxOpen, pct: cfg.rocketBucketPct, tradePct: cfg.rocketTradePct },
      cfg: Object.fromEntries(Object.keys(cfg).filter((k) => k.startsWith('rocket')).map((k) => [k, cfg[k]])),
      stats: { buckets: bucketStats(this.st.done), tracked: this.st.track.length, done: this.st.done.length, best: this.st.best, bestTrade: trades.reduce((a, t) => (!a || t.pnlPct > a.pnlPct ? { symbol: t.symbol, pnlPct: r2(t.pnlPct), pnl: t.pnl } : a), null),
        trades: trades.length, wins, winRate: trades.length ? Math.round((wins / trades.length) * 100) : null, pnl: trades.reduce((a, t) => a + (t.pnl || 0), 0), totals: this.st.totals },
      brain: { ready: !!(bs && bs.ready), samples: bs ? bs.samples : 0, valAcc: bs ? bs.valAcc : null, baseline: bs ? bs.valMaj : null, edge: bs ? bs.edge : 0, minReady: BLIM.MIN_READY, feats: FEATS } };
  }
  summary() {
    const cfg = this.cfg(); const b = this.e.book; const room = bucketRoom(b, this.e.equity(), cfg); const trades = b.trades.filter((t) => t.bot === RK.ID); const w = trades.filter((t) => t.pnl >= 0).length; const top = this.radar[0];
    return { on: this.on(), open: room.open, max: cfg.rocketMaxOpen, used: room.used, cap: room.cap, ready: this.lastScan ? this.lastScan.ready : 0, scored: this.lastScan ? this.lastScan.scored : 0, top: top ? { symbol: top.symbol, score: top.score, status: top.status } : null, trades: trades.length, winRate: trades.length ? Math.round((w / trades.length) * 100) : null, thought: this.st.thought ? this.st.thought.text : null };
  }
}

module.exports = { Rocket, RK, FEATS, normJup, mergeDex, metrics, features, scoreCand, quickGates, safetyGates, roundTripLoss, bucketRoom, sizeFor, ladderExit, emergency, isRouteFail, bucketStats, rocketPositions, EXCL_TAGS };
