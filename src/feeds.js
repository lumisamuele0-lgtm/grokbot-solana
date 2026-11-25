'use strict';
// Dati gratuiti dal web per il MENTORE (nessuna API a pagamento, nessuna chiave):
// candele storiche, funding rate, open interest e indice Fear & Greed. Ogni dato ha più fonti in cascata:
// se una borsa blocca la regione del server (es. Binance dagli USA) si passa alla successiva.
const { fetchJson, sleep } = require('./util');

const ASSETS = { SOL: { bn: 'SOLUSDT', okx: 'SOL-USDT', cb: 'SOL-USD', kr: 'SOLUSD' }, BTC: { bn: 'BTCUSDT', okx: 'BTC-USDT', cb: 'BTC-USD', kr: 'XBTUSD' }, ETH: { bn: 'ETHUSDT', okx: 'ETH-USDT', cb: 'ETH-USD', kr: 'ETHUSD' } };
const TF_MIN = { '5m': 5, '15m': 15, '1h': 60 };
const norm = (arr) => { const m = new Map(); for (const k of arr) if (k && Number.isFinite(k.c) && k.c > 0) m.set(k.t, k); return [...m.values()].sort((a, b) => a.t - b.t); };

// ---------- candele: ogni fonte scarica a ritroso fino a "bars" candele chiuse
const CANDLE_SOURCES = {
  'Binance': async (a, tf, bars) => {
    let end = Date.now(); const out = [];
    for (let i = 0; i < 12 && out.length < bars; i++) {
      const r = await fetchJson(`https://data-api.binance.vision/api/v3/klines?symbol=${ASSETS[a].bn}&interval=${tf}&limit=1000&endTime=${end}`, { retries: 1 });
      if (!Array.isArray(r) || !r.length) break;
      out.unshift(...r.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })));
      end = r[0][0] - 1; if (r.length < 1000) break;
    }
    return out;
  },
  'Bybit': async (a, tf, bars) => {
    let end = Date.now(); const out = []; const iv = { '5m': '5', '15m': '15', '1h': '60' }[tf];
    for (let i = 0; i < 12 && out.length < bars; i++) {
      const r = await fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${ASSETS[a].bn}&interval=${iv}&limit=1000&end=${end}`, { retries: 1 });
      const list = r && r.result && r.result.list; if (!list || !list.length) break;
      out.unshift(...list.map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).reverse());
      end = +list[list.length - 1][0] - 1; if (list.length < 1000) break;
    }
    return out;
  },
  'OKX': async (a, tf, bars) => {
    let after = ''; const out = []; const bar = { '5m': '5m', '15m': '15m', '1h': '1H' }[tf];
    for (let i = 0; i < 45 && out.length < bars; i++) {
      const r = await fetchJson(`https://www.okx.com/api/v5/market/history-candles?instId=${ASSETS[a].okx}&bar=${bar}&limit=100${after ? '&after=' + after : ''}`, { retries: 1 });
      const d = r && r.data; if (!d || !d.length) break;
      out.unshift(...d.map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).reverse());
      after = d[d.length - 1][0]; await sleep(120);
    }
    return out;
  },
  'Coinbase': async (a, tf, bars) => {
    const g = TF_MIN[tf] * 60; let end = Math.floor(Date.now() / 1000); const out = [];
    for (let i = 0; i < 40 && out.length < bars; i++) {
      const start = end - g * 300;
      const r = await fetchJson(`https://api.exchange.coinbase.com/products/${ASSETS[a].cb}/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`, { retries: 1, headers: { 'user-agent': 'grokbot-solana' } });
      if (!Array.isArray(r) || !r.length) break;
      out.unshift(...r.map((x) => ({ t: x[0] * 1000, l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] })).reverse());
      end = start; await sleep(150);
    }
    return out;
  },
  'Kraken': async (a, tf) => { // solo le ultime 720 candele
    const r = await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${ASSETS[a].kr}&interval=${TF_MIN[tf]}`, { retries: 1 });
    const res = r && r.result; const k = res && Object.keys(res).find((x) => x !== 'last'); if (!k) return [];
    return res[k].map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] }));
  },
};

class Feeds {
  constructor(health = {}) { this.health = health; } // health[nome] = { ok, lastOk, lastErr, lastTry, uses }
  mark(name, ok, err) {
    const h = this.health[name] || (this.health[name] = { ok: false, lastOk: null, lastErr: null, lastTry: null, uses: 0 });
    h.lastTry = Date.now(); h.ok = ok; if (ok) { h.lastOk = h.lastTry; h.uses++; h.lastErr = null; } else h.lastErr = String(err || 'errore').slice(0, 140);
  }
  // prova le fonti in ordine; ritorna { data, source } oppure lancia l'ultimo errore
  async firstOk(kind, list, accept) {
    let last;
    for (const [name, fn] of list) {
      try { const data = await fn(); if (!accept(data)) throw new Error('dati vuoti o incompleti'); this.mark(`${kind}:${name}`, true); return { data, source: name }; }
      catch (e) { last = e; this.mark(`${kind}:${name}`, false, e.message); }
    }
    throw last || new Error('nessuna fonte disponibile');
  }
  async candles(asset, tf, bars) {
    const now = Date.now(); const ms = TF_MIN[tf] * 60000;
    const r = await this.firstOk('candele', Object.entries(CANDLE_SOURCES).map(([n, fn]) => [n, () => fn(asset, tf, bars)]), (d) => Array.isArray(d) && d.length >= Math.min(bars, 300));
    const data = norm(r.data).filter((k) => k.t + ms <= now).slice(-bars); // solo candele chiuse
    return { candles: data, source: r.source };
  }
  async funding(asset) { // storico funding (frazione per 8h), crescente
    const a = ASSETS[asset];
    const r = await this.firstOk('funding', [
      ['Binance', async () => (await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${a.bn}&limit=1000`, { retries: 1 })).map((x) => ({ t: +x.fundingTime, rate: +x.fundingRate }))],
      ['Bybit', async () => { const out = []; let end = Date.now(); for (let i = 0; i < 4; i++) { const r = await fetchJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${a.bn}&limit=200&endTime=${end}`, { retries: 1 }); const l = r && r.result && r.result.list; if (!l || !l.length) break; out.push(...l.map((x) => ({ t: +x.fundingRateTimestamp, rate: +x.fundingRate }))); end = +l[l.length - 1].fundingRateTimestamp - 1; } return out; }],
      ['OKX', async () => { const out = []; let after = ''; for (let i = 0; i < 4; i++) { const r = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${a.okx}-SWAP&limit=100${after ? '&after=' + after : ''}`, { retries: 1 }); const d = r && r.data; if (!d || !d.length) break; out.push(...d.map((x) => ({ t: +x.fundingTime, rate: +(x.realizedRate || x.fundingRate) }))); after = d[d.length - 1].fundingTime; } return out; }],
    ], (d) => Array.isArray(d) && d.length >= 20);
    return { series: [...new Map(r.data.filter((x) => Number.isFinite(x.rate)).map((x) => [x.t, x])).values()].sort((x, y) => x.t - y.t), source: r.source };
  }
  async openInterest(asset) { // open interest attuale in USD
    const a = ASSETS[asset];
    const r = await this.firstOk('oi', [
      ['OKX', async () => +(await fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${a.okx}-SWAP`, { retries: 1 })).data[0].oiUsd],
      ['Bybit', async () => +(await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${a.bn}`, { retries: 1 })).result.list[0].openInterestValue],
      ['Binance', async () => { const r = await fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${a.bn}`, { retries: 1 }); const p = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${a.bn}`, { retries: 1 }); return +r.openInterest * +p.markPrice; }],
    ], (v) => Number.isFinite(v) && v > 0);
    return { usd: r.data, source: r.source };
  }
  async longShort(asset) { // rapporto conti long/short dei perpetui OKX (orario, ~30 giorni), crescente, con z-score a 7 giorni
    const r = await this.firstOk('longshort', [
      ['OKX', async () => (await fetchJson(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${asset}&period=1H`, { retries: 1 })).data.map((x) => ({ t: +x[0], ratio: +x[1] }))],
    ], (d) => Array.isArray(d) && d.length > 50);
    const s = r.data.filter((x) => Number.isFinite(x.ratio)).sort((a, b) => a.t - b.t);
    for (let i = 0; i < s.length; i++) { const w = s.slice(Math.max(0, i - 167), i + 1).map((x) => x.ratio); if (w.length < 48) { s[i].z = null; continue; } const m = w.reduce((a, b) => a + b, 0) / w.length; const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length) || 1e-9; s[i].z = (s[i].ratio - m) / sd; }
    return { series: s, source: r.source };
  }
  async global() { // capitalizzazione totale e dominanza BTC (CoinGecko, gratuito)
    const r = await this.firstOk('globale', [
      ['CoinGecko', async () => { const d = (await fetchJson('https://api.coingecko.com/api/v3/global', { retries: 1 })).data; return { mcapChange24h: +d.market_cap_change_percentage_24h_usd, btcDom: +d.market_cap_percentage.btc, ethDom: +d.market_cap_percentage.eth }; }],
    ], (d) => d && Number.isFinite(d.mcapChange24h));
    return { ...r.data, source: r.source };
  }
  async tvl(chain) { // valore bloccato nella DeFi della chain (DefiLlama, gratuito): variazione 1 e 7 giorni
    const r = await this.firstOk('tvl', [
      ['DefiLlama', async () => (await fetchJson(`https://api.llama.fi/v2/historicalChainTvl/${chain}`, { retries: 1 })).map((x) => ({ t: +x.date * 1000, tvl: +x.tvl }))],
    ], (d) => Array.isArray(d) && d.length > 8);
    const s = r.data; const last = s[s.length - 1];
    return { tvl: last.tvl, ch1d: (last.tvl / s[s.length - 2].tvl - 1) * 100, ch7d: (last.tvl / s[s.length - 8].tvl - 1) * 100, source: r.source };
  }
  async fearGreed() { // storico giornaliero, crescente
    const r = await this.firstOk('fng', [
      ['alternative.me', async () => (await fetchJson('https://api.alternative.me/fng/?limit=120&format=json', { retries: 1 })).data.map((x) => ({ t: +x.timestamp * 1000, value: +x.value, label: x.value_classification }))],
    ], (d) => Array.isArray(d) && d.length > 5);
    return { series: r.data.sort((a, b) => a.t - b.t), source: r.source };
  }
}
module.exports = { Feeds, ASSETS, TF_MIN, CANDLE_SOURCES };
