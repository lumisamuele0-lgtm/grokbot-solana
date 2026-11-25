'use strict';
// MENTORE · notizie crypto da feed RSS pubblici e gratuiti (nessuna chiave).
// Ogni titolo viene associato a SOL/BTC/ETH (o al mercato intero) e valutato con un dizionario di parole:
// sentiment (−1 … +1) e rischio notizie (0 … 1: hack, exploit, cause legali, blocchi, crolli…).
// È un indicatore semplice e trasparente: modula gli ingressi, non li decide da solo.
const { fetchText } = require('./util');

const NEWS_SOURCES = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['The Block', 'https://www.theblock.co/rss.xml'],
  ['CryptoSlate', 'https://cryptoslate.com/feed/'],
  ['Bitcoin Magazine', 'https://bitcoinmagazine.com/feed'],
];
const POS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'record high', 'all-time high', 'ath', 'bull', 'bullish', 'approve', 'approves', 'approved', 'approval', 'adoption', 'inflow', 'inflows', 'upgrade', 'partnership', 'breakout', 'rebound', 'rebounds', 'recover', 'recovers', 'recovery', 'accumulate', 'accumulation', 'buy the dip', 'climb', 'climbs', 'outperform', 'green'];
const NEG = ['plunge', 'plunges', 'crash', 'crashes', 'drop', 'drops', 'fall', 'falls', 'slump', 'tumble', 'tumbles', 'sell-off', 'selloff', 'bear', 'bearish', 'outflow', 'outflows', 'lawsuit', 'sue', 'sues', 'fraud', 'ban', 'bans', 'crackdown', 'liquidation', 'liquidations', 'bankrupt', 'bankruptcy', 'reject', 'rejects', 'rejected', 'warning', 'fear', 'dump', 'dumps', 'decline', 'declines', 'slide', 'slides', 'sink', 'sinks', 'losses', 'red', 'capitulation', 'panic'];
const RISK = ['hack', 'hacked', 'exploit', 'exploited', 'breach', 'drained', 'stolen', 'outage', 'halt', 'halts', 'halted', 'depeg', 'insolvency', 'insolvent', 'bankrupt', 'bankruptcy', 'charges', 'lawsuit', 'ban', 'delist', 'delisting', 'emergency', 'attack', 'vulnerability', 'liquidations', 'crash', 'investigation', 'sanction', 'sanctions', 'shutdown', 'freeze', 'frozen'];
const ASSET_RX = { BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i };
const MARKET_RX = /\b(crypto|market|markets|fed|inflation|stablecoin|etf|altcoin|altcoins|sec|tariff|macro)\b/i;

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#8217;|&#8216;/g, "'").replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
function parseRss(xml, source) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const it = m[0]; const tag = (n) => { const r = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(it); return r ? decode(r[1]) : ''; };
    const title = tag('title'); if (!title) continue;
    const t = Date.parse(tag('pubDate') || tag('dc:date')) || null;
    out.push({ title: title.slice(0, 220), link: tag('link').slice(0, 300), t, source });
  }
  return out;
}
const words = (title) => title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
function count(text, list) { let n = 0; for (const w of list) { const rx = new RegExp(`(^|\\s)${w.replace(/[-]/g, '\\-')}(\\s|$)`); if (rx.test(text)) n++; } return n; }
// valuta un titolo: sentiment −1…+1, rischio (numero di parole di rischio), asset coinvolti
function scoreTitle(title) {
  const w = ' ' + words(title) + ' ';
  const p = count(w, POS), n = count(w, NEG), r = count(w, RISK);
  const sentiment = p + n ? (p - n) / (p + n) : 0;
  const assets = Object.entries(ASSET_RX).filter(([, rx]) => rx.test(title)).map(([a]) => a);
  return { sentiment, risk: r, assets, market: !assets.length && MARKET_RX.test(title), pos: p, neg: n };
}
// aggrega le notizie delle ultime 24h con decadimento (emivita ~6h)
function aggregate(items, now = Date.now()) {
  const res = {};
  for (const a of Object.keys(ASSET_RX)) {
    let s = 0, wsum = 0, risk = 0, n = 0; const top = [];
    for (const it of items) {
      if (!it.t || now - it.t > 24 * 3600e3 || it.t > now + 3600e3) continue;
      const sc = it.score || scoreTitle(it.title);
      const rel = sc.assets.includes(a) ? 1 : sc.market ? 0.4 : 0; if (!rel) continue;
      const d = Math.exp(-(now - it.t) / (6 * 3600e3)) * rel;
      s += d * sc.sentiment; wsum += d; risk += d * sc.risk; n++;
      if (sc.assets.includes(a) && (sc.risk || sc.sentiment)) top.push({ title: it.title, source: it.source, t: it.t, sentiment: sc.sentiment, risk: sc.risk });
    }
    res[a] = { sentiment: wsum ? Math.tanh((s / Math.max(wsum, 1)) * 1.5) : 0, risk: 1 - Math.exp(-risk / 2), n, top: top.sort((x, y) => y.risk - x.risk || y.t - x.t).slice(0, 3) };
  }
  return res;
}
async function fetchNews(health = null) {
  const all = []; const ok = [];
  await Promise.all(NEWS_SOURCES.map(async ([name, url]) => {
    try { const items = parseRss(await fetchText(url), name); if (!items.length) throw new Error('feed vuoto'); all.push(...items); ok.push(name); if (health) health(`notizie:${name}`, true); }
    catch (e) { if (health) health(`notizie:${name}`, false, e.message); }
  }));
  const seen = new Set(); const items = [];
  for (const it of all.sort((a, b) => (b.t || 0) - (a.t || 0))) { const k = it.title.toLowerCase().slice(0, 80); if (seen.has(k)) continue; seen.add(k); items.push({ ...it, score: scoreTitle(it.title) }); }
  return { items: items.slice(0, 150), sources: ok.sort() };
}

// Lettore continuo (ogni ~90 s): richieste condizionali (ETag / If-Modified-Since → 304 senza scaricare nulla),
// timeout per feed, titoli già visti scartati, pausa crescente per feed in caso di 429/errori (rispetta Retry-After).
const NEWS_INTERVAL_MS = 90e3;
const FEED_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 30 * 60e3;
const keyOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
class NewsReader {
  constructor(state = null, { sources = NEWS_SOURCES, fetchImpl = (...a) => fetch(...a), mark = null } = {}) {
    this.sources = sources; this.fetch = fetchImpl; this.mark = mark;
    const st = state || {};
    this.feeds = st.feeds || {}; // nome -> { etag, lastModified, fails, backoffUntil, lastStatus, lastOk, lastCheck, notModified, newItems, rateLimited }
    this.items = Array.isArray(st.items) ? st.items : []; // titoli delle ultime 24h (con punteggio), più recenti prima
    this.seen = new Set(this.items.map((x) => keyOf(x.title)));
    this.checks = st.checks || 0; this.lastCheck = st.lastCheck || null; this.lastNew = st.lastNew || null;
  }
  state() { return { feeds: this.feeds, items: this.items, checks: this.checks, lastCheck: this.lastCheck, lastNew: this.lastNew }; }
  async readFeed(name, url, now) {
    const f = this.feeds[name] || (this.feeds[name] = { etag: null, lastModified: null, fails: 0, backoffUntil: 0, lastStatus: null, lastOk: null, lastCheck: null, notModified: 0, newItems: 0, rateLimited: 0 });
    if (f.backoffUntil > now) return { name, skipped: true, items: [] };
    const headers = { 'user-agent': 'Mozilla/5.0 (grokbot-solana news reader)', accept: 'application/rss+xml, application/xml, text/xml, */*' };
    if (f.etag) headers['if-none-match'] = f.etag;
    if (f.lastModified) headers['if-modified-since'] = f.lastModified;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
    f.lastCheck = now;
    try {
      const res = await this.fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      f.lastStatus = res.status;
      if (res.status === 304) { f.fails = 0; f.lastOk = now; f.notModified++; if (this.mark) this.mark(`notizie:${name}`, true); return { name, notModified: true, items: [] }; }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        if (res.status === 429) f.rateLimited++;
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseRss(xml, name); if (!items.length) throw new Error('feed vuoto');
      f.etag = (res.headers.get && res.headers.get('etag')) || null; f.lastModified = (res.headers.get && res.headers.get('last-modified')) || null;
      f.fails = 0; f.backoffUntil = 0; f.lastOk = now; f.lastErr = null;
      if (this.mark) this.mark(`notizie:${name}`, true);
      return { name, items };
    } catch (e) {
      f.fails++; f.lastErr = String(e.name === 'AbortError' ? `timeout ${FEED_TIMEOUT_MS / 1000}s` : e.message).slice(0, 120);
      f.backoffUntil = now + Math.min(MAX_BACKOFF_MS, Math.max(e.retryAfterMs || 0, NEWS_INTERVAL_MS * 2 ** Math.min(f.fails, 5)));
      if (this.mark) this.mark(`notizie:${name}`, false, f.lastErr);
      return { name, error: f.lastErr, items: [] };
    } finally { clearTimeout(t); }
  }
  // un giro di lettura: ritorna i soli titoli NUOVI (già con punteggio)
  async poll(now = Date.now()) {
    const res = await Promise.all(this.sources.map(([n, u]) => this.readFeed(n, u, now)));
    const fresh = [];
    for (const r of res) for (const it of r.items) {
      const k = keyOf(it.title); if (this.seen.has(k)) continue;
      if (it.t && now - it.t > 24 * 3600e3) { this.seen.add(k); continue; }
      this.seen.add(k); fresh.push({ ...it, t: it.t || now, score: scoreTitle(it.title) });
      this.feeds[r.name].newItems++;
    }
    this.checks++; this.lastCheck = now;
    // tengo solo le ultime 24h (max 300 titoli); i titoli visti restano in memoria per non ricontarli
    this.items = [...fresh, ...this.items].filter((x) => now - x.t <= 24 * 3600e3).sort((a, b) => b.t - a.t).slice(0, 300);
    if (this.seen.size > 3000) this.seen = new Set([...this.items.map((x) => keyOf(x.title))]);
    if (fresh.length) this.lastNew = now;
    return { fresh, results: res };
  }
  okSources() { return Object.entries(this.feeds).filter(([, f]) => f.lastOk && (!f.backoffUntil || f.backoffUntil < Date.now() || f.fails === 0)).map(([n]) => n).sort(); }
}
module.exports = { NEWS_SOURCES, parseRss, scoreTitle, aggregate, fetchNews, NewsReader, NEWS_INTERVAL_MS, FEED_TIMEOUT_MS, MAX_BACKOFF_MS };
