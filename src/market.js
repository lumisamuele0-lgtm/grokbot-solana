'use strict';
// Dati di mercato gratuiti: Jupiter (prezzi), DexScreener (liquidità, volumi, scoperta meme),
// GeckoTerminal (candele 1m), RugCheck (rischio), RPC (autorità mint), cambio EUR/USD.
const { fetchJson, rateQueue, sleep } = require('./util');
const { JUP_BASE, jupQueue: jq } = require('./jupiter');

const dq = rateQueue(1100);
const gq = rateQueue(6500); // GeckoTerminal gratuito: limite basso, ~9 richieste/min
const rq = rateQueue(1500);

class Market {
  constructor(log) {
    this.log = log || (() => {});
    this.prices = {}; // mint -> {usd, ts}
    this.stats = {}; // mint -> stats DexScreener
    this.candles = {}; // mint -> [{t,o,h,l,c,v}]
    this.candleTs = {}; // mint -> ultimo backfill
    this.safety = {}; // mint -> {..., ts}
    this.eurPerUsd = 0.92; this.eurTs = 0;
  }

  async refreshPrices(mints) {
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += 50) {
      const ids = uniq.slice(i, i + 50).join(',');
      const r = await jq(() => fetchJson(`${JUP_BASE}/price/v3?ids=${ids}`, { retries: 1 }));
      const now = Date.now();
      for (const [m, v] of Object.entries(r || {})) {
        if (v && v.usdPrice > 0) { this.prices[m] = { usd: v.usdPrice, ts: now, change24h: v.priceChange24h }; this.pushLive(m, v.usdPrice, now); }
      }
    }
  }
  usd(mint) { const p = this.prices[mint]; return p && Date.now() - p.ts < 180000 ? p.usd : null; }

  pushLive(mint, price, now) {
    if (!this.candles[mint]) this.candles[mint] = [];
    const arr = this.candles[mint];
    const t = Math.floor(now / 60000) * 60000;
    const last = arr[arr.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; }
    else if (!last || t > last.t) { arr.push({ t, o: last ? last.c : price, h: Math.max(price, last ? last.c : price), l: Math.min(price, last ? last.c : price), c: price, v: 0 }); if (arr.length > 400) arr.shift(); }
  }

  static pickPair(pairs, mint) {
    const own = (pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint);
    own.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    return own[0] || null;
  }
  static statsFromPair(p, mint, core) {
    const tx = p.txns || {}; const v = p.volume || {}; const pc = p.priceChange || {};
    return {
      mint, core: !!core, symbol: String(p.baseToken.symbol || '?').replace(/^\$+/, '').trim().slice(0, 14), name: p.baseToken.name, pairAddress: p.pairAddress, dex: p.dexId, url: p.url,
      icon: p.info && p.info.imageUrl, priceUsd: +p.priceUsd || null,
      liquidityUsd: (p.liquidity && p.liquidity.usd) || 0, volume24h: v.h24 || 0, volume6h: v.h6 || 0, volume1h: v.h1 || 0,
      change1h: pc.h1 ?? null, change24h: pc.h24 ?? null, buys1h: (tx.h1 && tx.h1.buys) || 0, sells1h: (tx.h1 && tx.h1.sells) || 0,
      ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null, mcapUsd: p.marketCap || p.fdv || null, ts: Date.now(),
    };
  }
  async refreshStats(mints, coreSet) {
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += 30) {
      const chunk = uniq.slice(i, i + 30);
      const pairs = await dq(() => fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { retries: 1 }));
      for (const m of chunk) {
        const p = Market.pickPair(pairs, m);
        if (p) this.stats[m] = Market.statsFromPair(p, m, coreSet && coreSet.has(m));
      }
    }
  }

  // Scoperta meme token Solana: profili recenti + boost (gratuiti, senza chiave).
  async discover() {
    const urls = ['https://api.dexscreener.com/token-profiles/latest/v1', 'https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-boosts/top/v1'];
    const found = new Set();
    for (const u of urls) {
      try {
        const r = await dq(() => fetchJson(u));
        for (const x of r || []) if (x.chainId === 'solana' && x.tokenAddress) found.add(x.tokenAddress);
      } catch (e) { this.log('warn', `DexScreener scoperta: ${e.message}`); }
    }
    return [...found];
  }

  // Candele 1m reali (GeckoTerminal) sul pool più liquido.
  async backfill(mint) {
    const s = this.stats[mint]; if (!s || !s.pairAddress) throw new Error('pool sconosciuto');
    if (this.geckoPauseUntil && Date.now() < this.geckoPauseUntil) throw new Error('GeckoTerminal in pausa (limite gratuito), uso i prezzi live');
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${s.pairAddress}/ohlcv/minute?aggregate=1&limit=300&token=${mint}`;
    let r;
    try { r = await gq(() => fetchJson(url, { retries: 0, timeout: 15000 })); }
    catch (e) { if (e.status === 429) { this.geckoPauseUntil = Date.now() + 70000; this.candleTs[mint] = Date.now() - 13 * 60000; } throw e; }
    const list = (r && r.data && r.data.attributes && r.data.attributes.ohlcv_list) || [];
    const arr = list.map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).sort((a, b) => a.t - b.t);
    // riempie i minuti senza scambi per avere una serie regolare
    const out = [];
    for (const k of arr) {
      let last = out[out.length - 1];
      while (last && k.t - last.t > 60000 && out.length < 1000) { out.push({ t: last.t + 60000, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 }); last = out[out.length - 1]; }
      out.push(k);
    }
    const live = this.candles[mint] || [];
    const lastT = out.length ? out[out.length - 1].t : 0;
    for (const k of live) if (k.t > lastT) out.push(k);
    this.candles[mint] = out.slice(-400);
    this.candleTs[mint] = Date.now();
    return this.candles[mint].length;
  }
  needsBackfill(mint, maxAgeMs = 15 * 60000) { return !this.candleTs[mint] || Date.now() - this.candleTs[mint] > maxAgeMs; }

  async checkSafety(mint, chainMintInfo) {
    const c = this.safety[mint];
    if (c && Date.now() - c.ts < 30 * 60000) return c;
    const out = { ts: Date.now(), rugScore: null, danger: [], holderRisk: false, mintAuthority: null, freezeAuthority: null, token2022Ext: false, risks: [] };
    try {
      const mi = await chainMintInfo(mint);
      out.mintAuthority = mi.mintAuthority; out.freezeAuthority = mi.freezeAuthority; out.token2022Ext = mi.risky2022.length > 0; out.decimals = mi.decimals;
    } catch (e) { out.rpcError = e.message; }
    try {
      const r = await rq(() => fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { retries: 1 }));
      out.rugScore = r.score_normalised ?? null;
      out.risks = (r.risks || []).map((x) => `${x.name}${x.level === 'danger' ? ' ⚠' : ''}`);
      out.danger = (r.risks || []).filter((x) => x.level === 'danger').map((x) => x.name);
      out.holderRisk = (r.risks || []).some((x) => /holder/i.test(x.name) && x.level !== 'info');
      out.holderDanger = (r.risks || []).some((x) => /holder/i.test(x.name) && x.level === 'danger');
      out.lpLockedPct = r.lpLockedPct;
    } catch (e) { out.rugError = e.message; }
    if (out.rpcError && out.rugError) { out.ts = Date.now() - 25 * 60000; }
    this.safety[mint] = out;
    return out;
  }

  async refreshEur() {
    if (Date.now() - this.eurTs < 3600000) return;
    try {
      const r = await fetchJson('https://open.er-api.com/v6/latest/USD');
      if (r && r.rates && r.rates.EUR) { this.eurPerUsd = r.rates.EUR; this.eurTs = Date.now(); return; }
    } catch {}
    try {
      const r = await fetchJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
      if (r && r.rates && r.rates.EUR) { this.eurPerUsd = r.rates.EUR; this.eurTs = Date.now(); }
    } catch (e) { this.log('warn', `Cambio EUR non disponibile: ${e.message}`); }
  }
}
module.exports = { Market, sleep };
