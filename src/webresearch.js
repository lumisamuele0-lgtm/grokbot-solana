'use strict';
// RICERCA WEB AUTORIZZATA di ogni bot: solo fonti pubbliche e gratuite, specifiche per il lavoro di ciascuno.
// Sicurezza: elenco chiuso di domini (allowlist esatta), solo https sulla porta 443, nessun redirect fuori elenco,
// niente credenziali negli URL, timeout 8 s, risposta massima 400 KB, al massimo 1 richiesta ogni 3 s per dominio e 40 ogni
// 10 minuti in tutto, cache di 15 minuti. Il contenuto è trattato SOLO come dato (titoli puliti da markup, troncati, valutati con
// il dizionario delle notizie): non viene mai eseguito né usato come istruzione e non può far aprire operazioni da solo.
const { scoreTitle, parseRss } = require('./news');

const ALLOW = new Set(['news.google.com', 'api.dexscreener.com', 'api.coingecko.com', 'www.okx.com', 'api.alternative.me', 'data-api.binance.vision']);
const LIMITS = { TIMEOUT_MS: 8000, MAX_BYTES: 400 * 1024, HOST_GAP_MS: 3000, WINDOW_MS: 10 * 60e3, WINDOW_MAX: 40, CACHE_MS: 15 * 60e3, MAX_REDIRECTS: 2 };
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// argomenti di ricerca per specialità (analisti e trader)
const TOPICS = {
  trend: { q: ['solana price trend', 'bitcoin price technical analysis'], label: 'trend di SOL/BTC' },
  momentum: { q: ['crypto rally momentum', 'solana surge'], label: 'accelerazioni di prezzo' },
  breakout: { q: ['bitcoin breakout resistance', 'solana breakout'], label: 'rotture di livelli' },
  reversion: { q: ['crypto oversold bounce', 'bitcoin overbought'], label: 'eccessi e rimbalzi' },
  flow: { q: ['solana dex volume'], dex: 'boosts', label: 'flussi e volumi on-chain' },
  meme: { q: ['solana memecoin rug pull', 'pump.fun memecoin'], dex: 'profiles', trending: true, label: 'memecoin: token, sviluppatori, social, truffe' },
  news: { q: ['crypto news solana', 'crypto market today'], label: 'notizie del giorno' },
  funding: { q: ['crypto liquidations funding rate'], okx: true, label: 'funding e liquidazioni dei perps' },
  volatility: { q: ['crypto volatility'], label: 'volatilità' },
  mtf: { q: ['bitcoin weekly outlook'], label: 'scenario su più orizzonti' },
  whale: { q: ['crypto whale buys', 'solana whale'], dex: 'boosts', label: 'balene e grandi ordini' },
  macro: { q: ['federal reserve bitcoin', 'inflation crypto market'], global: true, fng: true, label: 'macro: Fed, inflazione, BTC' },
  alpha: { q: ['solana ethereum bitcoin price', 'crypto derivatives'], okx: true, label: 'mercati con leva SOL/BTC/ETH' },
  omega: { q: ['solana token launch', 'solana ecosystem'], trending: true, dex: 'profiles', label: 'cripto spot dell\'ecosistema Solana' },
};

function checkUrl(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error('URL non valido'); }
  if (u.protocol !== 'https:') throw new Error('solo https');
  if (u.username || u.password) throw new Error('credenziali negli URL non ammesse');
  if (u.port && u.port !== '443') throw new Error('porta non ammessa');
  if (!ALLOW.has(u.hostname)) throw new Error(`dominio non autorizzato: ${u.hostname}`);
  return u;
}
class WebResearch {
  constructor({ log = () => {}, fetchImpl = null, now = () => Date.now() } = {}) {
    this.log = log; this.fetch = fetchImpl || ((...a) => fetch(...a)); this.now = now;
    this.cache = new Map(); this.hostLast = {}; this.window = []; this.stats = { requests: 0, cached: 0, errors: 0, blocked: 0, lastErr: null };
    this.findings = {}; // bot → ultime scoperte
  }
  // richiesta sicura (allowlist, timeout, limite di byte, redirect controllati, velocità limitata, cache)
  async get(url, { json = false } = {}) {
    let u = checkUrl(url); const key = u.toString(); const now = this.now();
    const c = this.cache.get(key); if (c && now - c.t < LIMITS.CACHE_MS) { this.stats.cached++; return c.v; }
    this.window = this.window.filter((t) => now - t < LIMITS.WINDOW_MS);
    if (this.window.length >= LIMITS.WINDOW_MAX) { this.stats.blocked++; throw new Error('limite di richieste raggiunto: riprovo più tardi'); }
    if (now - (this.hostLast[u.hostname] || 0) < LIMITS.HOST_GAP_MS) { this.stats.blocked++; throw new Error(`troppo presto per ${u.hostname}`); }
    this.hostLast[u.hostname] = now; this.window.push(now); this.stats.requests++;
    for (let hop = 0; ; hop++) {
      const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), LIMITS.TIMEOUT_MS);
      try {
        const res = await this.fetch(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (grokbot-solana research)', accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' } });
        if (res.status >= 300 && res.status < 400) {
          if (hop >= LIMITS.MAX_REDIRECTS) throw new Error('troppi redirect');
          const loc = res.headers && res.headers.get && res.headers.get('location'); if (!loc) throw new Error('redirect senza destinazione');
          u = checkUrl(new URL(loc, u).toString()); continue; // anche il redirect deve essere in elenco
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${u.hostname}`);
        const text = await readCapped(res, LIMITS.MAX_BYTES);
        const v = json ? JSON.parse(text) : text;
        this.cache.set(key, { t: now, v }); if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
        return v;
      } catch (e) { this.stats.errors++; this.stats.lastErr = e.name === 'AbortError' ? `timeout ${u.hostname}` : e.message; throw e.name === 'AbortError' ? new Error(`timeout ${u.hostname}`) : e; }
      finally { clearTimeout(tm); }
    }
  }
  // una sessione di ricerca per un bot: ritorna le scoperte (titolo, fonte, sentiment, rischio, cripto citate)
  async research(bot, { coins = [] } = {}) {
    const T = TOPICS[bot]; if (!T) return [];
    const now = this.now(); const out = []; const errs = [];
    const add = (title, source, extra = {}) => { const t = clean(title); if (!t) return; const sc = scoreTitle(t); out.push({ t: now, bot, title: t, source, sentiment: +sc.sentiment.toFixed(2), risk: +Math.min(1, (sc.risk || 0) / 2).toFixed(2), assets: sc.assets || [], market: !!sc.market, coins: coins.filter((s) => s && new RegExp(`\\b${escRx(s)}\\b`, 'i').test(t)).slice(0, 4), ...extra }); };
    const q = T.q[Math.floor(now / 60e3) % T.q.length];
    try { const xml = await this.get(gnews(q)); for (const it of parseRss(xml, 'Google News').filter((x) => !x.t || now - x.t < 2 * 864e5).slice(0, 6)) add(it.title, 'Google News'); } catch (e) { errs.push(e.message); }
    if (T.dex) try { const j = await this.get(`https://api.dexscreener.com/${T.dex === 'boosts' ? 'token-boosts/top/v1' : 'token-profiles/latest/v1'}`, { json: true });
      for (const x of (Array.isArray(j) ? j : []).filter((z) => z && z.chainId === 'solana').slice(0, 5)) add(`${T.dex === 'boosts' ? 'Token promosso' : 'Nuovo profilo token'} su DexScreener: ${String(x.description || x.tokenAddress || '').slice(0, 120)}`, 'DexScreener', { mint: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.tokenAddress || '') ? x.tokenAddress : null, social: Array.isArray(x.links) ? x.links.length : 0 });
    } catch (e) { errs.push(e.message); }
    if (T.trending) try { const j = await this.get('https://api.coingecko.com/api/v3/search/trending', { json: true }); const l = (j && j.coins || []).slice(0, 7).map((c) => c.item && c.item.symbol).filter(Boolean); if (l.length) add(`Di tendenza su CoinGecko: ${l.join(', ')}`, 'CoinGecko', { trending: l }); } catch (e) { errs.push(e.message); }
    if (T.global) try { const d = (await this.get('https://api.coingecko.com/api/v3/global', { json: true })).data; const ch = +d.market_cap_change_percentage_24h_usd; add(`Capitalizzazione crypto ${ch >= 0 ? 'rises' : 'falls'} ${ch.toFixed(1)}% in 24h, BTC dominance ${(+d.market_cap_percentage.btc).toFixed(1)}%`, 'CoinGecko'); } catch (e) { errs.push(e.message); }
    if (T.fng) try { const d = (await this.get('https://api.alternative.me/fng/', { json: true })).data[0]; add(`Fear & Greed ${d.value} (${d.value_classification})${+d.value < 25 ? ' fear' : +d.value > 75 ? ' greed bullish' : ''}`, 'alternative.me'); } catch (e) { errs.push(e.message); }
    if (T.okx) try { const j = await this.get('https://www.okx.com/api/v5/public/funding-rate?instId=SOL-USDT-SWAP', { json: true }); const r = +j.data[0].fundingRate; add(`Funding SOL perps ${(r * 100).toFixed(4)}%${r > 0.0003 ? ' troppi long: warning' : r < -0.0001 ? ' troppi short: rebound possibile' : ''}`, 'OKX'); } catch (e) { errs.push(e.message); }
    this.findings[bot] = [...out, ...(this.findings[bot] || [])].slice(0, 10);
    return { findings: out, errors: errs };
  }
  // sentiment web recente (ultime 6 ore) per un bot e, se indicato, per una cripto
  sentiment(bot, symbol = null, now = this.now()) {
    const f = (this.findings[bot] || []).filter((x) => now - x.t < 6 * 3600e3 && (!symbol || x.assets.includes(symbol) || x.coins.includes(symbol) || (!x.assets.length && !x.coins.length)));
    if (!f.length) return { s: 0, n: 0, top: null };
    const s = f.reduce((a, x) => a + x.sentiment - 0.5 * x.risk, 0) / f.length;
    const top = [...f].sort((p, q) => Math.abs(q.sentiment) + q.risk - Math.abs(p.sentiment) - p.risk)[0];
    return { s: Math.max(-1, Math.min(1, s)), n: f.length, top };
  }
  latest(bot, k = 4) { return (this.findings[bot] || []).slice(0, k).map(({ t, title, source, sentiment, risk, coins }) => ({ t, title, source, sentiment, risk, coins })); }
}
async function readCapped(res, max) {
  if (res.body && res.body.getReader) {
    const rd = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > max) { try { await rd.cancel(); } catch {} throw new Error('risposta troppo grande'); } chunks.push(value); }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const t = await res.text(); if (t.length > max) throw new Error('risposta troppo grande'); return t;
}
const clean = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
module.exports = { WebResearch, TOPICS, ALLOW, LIMITS, checkUrl };
