'use strict';
// UNIVERSO delle cripto per le squadre: tutte le cripto scambiabili su Solana con Phantom/Jupiter
// (lista token gratuita di Jupiter: più scambiate e con più volume "organico" nelle 24h) + i token presenti nel tuo Phantom.
// Filtri di sicurezza: token verificato su Jupiter, niente autorità di mint/freeze, niente Token-2022, niente stablecoin,
// azioni tokenizzate o "liquid staking", liquidità/volume/capitalizzazione/età minime, holder non troppo concentrati,
// niente pump o crolli estremi. Leva e short SOLO dove esistono i mercati Jupiter Perps (SOL, BTC, ETH): il resto è spot 1x, solo long.
const { fetchJson } = require('./util');
const { JUP_BASE, jupQueue: jq } = require('./jupiter');
const P = require('./perps');
const { USDC, SOL } = require('./tokens');

const TOKENS_API = `${JUP_BASE}/tokens/v2`;
const REFRESH_MS = 10 * 60e3;
const STABLE_RE = /^(usd|usdc|usdt|usds|usde|pyusd|fdusd|usdg|usdgo|eurc|europ|eur|ausd|usdy|susd|usdai|susdai|usd1|dai|frax|tusd|usdh|uxd|usdx|husd|gusd)/i;
const BAD_TAGS = ['stocks', 'rwa', 'xstocks', 'equities', 'prestocks', 'pre-ipo', 'lst', 'stable', 'stablecoin'];
// colori fissi dei mercati con leva (le altre cripto hanno un colore calcolato dal mint)
const PERP_INFO = { SOL: { name: 'Solana', color: '#9945FF' }, BTC: { name: 'Bitcoin', color: '#F7931A' }, ETH: { name: 'Ethereum', color: '#7B8CFF' } };
function coinColor(mint, sym) {
  const pm = P.SHORT_MARKETS[mint]; if (pm) return PERP_INFO[pm].color;
  let h = 0; for (const ch of String(mint || sym)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360},78%,62%)`;
}
const num = (x) => (Number.isFinite(+x) ? +x : null);
// normalizza un token della lista Jupiter
function fromJup(t, phantom = false) {
  const s24 = t.stats24h || {}, s1h = t.stats1h || {}, s5 = t.stats5m || {}, s6 = t.stats6h || {};
  const created = (t.firstPool && t.firstPool.createdAt) || t.createdAt;
  const perp = P.SHORT_MARKETS[t.id] || null;
  return {
    mint: t.id, symbol: perp || String(t.symbol || '?').replace(/^\$+/, '').trim().slice(0, 12), name: perp ? PERP_INFO[perp].name : String(t.name || t.symbol || '').slice(0, 40), icon: t.icon || null, decimals: t.decimals,
    perp: !!perp, market: perp, color: coinColor(t.id, t.symbol), phantom,
    verified: !!t.isVerified, tags: t.tags || [], tokenProgram: t.tokenProgram, mintAuthority: t.mintAuthority || null, freezeAuthority: t.freezeAuthority || null,
    liquidityUsd: num(t.liquidity) || 0, volume24h: (num(s24.buyVolume) || 0) + (num(s24.sellVolume) || 0), mcapUsd: num(t.mcap) || num(t.fdv) || 0,
    holders: num(t.holderCount) || 0, topHoldersPct: t.audit ? num(t.audit.topHoldersPercentage) : null, organic: num(t.organicScore) || 0,
    change5m: num(s5.priceChange), change1h: num(s1h.priceChange), change6h: num(s6.priceChange), change24h: num(s24.priceChange),
    buys1h: num(s1h.numBuys) || 0, sells1h: num(s1h.numSells) || 0, volChange1h: num(s1h.volumeChange),
    ageDays: created ? (Date.now() - Date.parse(created)) / 864e5 : null, usdPrice: num(t.usdPrice),
  };
}
// regole del filtro (pure, testate): ritorna l'elenco dei motivi di scarto
function screen(c, cfg) {
  const out = []; const k = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : `${Math.round(x / 1000)}k`);
  if (c.mint === USDC || (cfg.baseCurrency === 'SOL' && c.mint === SOL && !c.perp)) out.push('valuta base');
  if (c.perp) { // SOL/BTC/ETH: mercati principali con leva, sempre ammessi (cbBTC ha autorità di Coinbase)
    if (c.change24h != null && c.change24h < -cfg.maxDump24hPct) out.push(`crollo 24h > ${cfg.maxDump24hPct}%`);
    return out;
  }
  if (!c.verified) out.push('non verificato su Jupiter');
  if (c.mintAuthority || c.freezeAuthority) out.push('autorità mint/freeze attive');
  if (c.tokenProgram && c.tokenProgram !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') out.push('Token-2022');
  if (STABLE_RE.test(c.symbol) || c.tags.some((t) => BAD_TAGS.includes(t))) out.push('stablecoin/azione/staking');
  if (c.liquidityUsd < cfg.uniMinLiqUsd) out.push(`liquidità < ${k(cfg.uniMinLiqUsd)} $`);
  if (c.volume24h < cfg.uniMinVol24hUsd) out.push(`volume 24h < ${k(cfg.uniMinVol24hUsd)} $`);
  if (c.mcapUsd < cfg.uniMinMcapUsd) out.push(`capitalizzazione < ${k(cfg.uniMinMcapUsd)} $`);
  if (c.ageDays == null || c.ageDays < cfg.uniMinAgeDays) out.push(`età < ${cfg.uniMinAgeDays} giorni`);
  if (c.organic < cfg.uniMinOrganic) out.push(`volume organico basso (${Math.round(c.organic)})`);
  if (c.topHoldersPct != null && c.topHoldersPct > cfg.uniMaxTopHoldersPct) out.push(`holder concentrati (${Math.round(c.topHoldersPct)}%)`);
  if (c.change1h != null && c.change1h > cfg.maxPump1hPct) out.push(`pump 1h > ${cfg.maxPump1hPct}%`);
  if (c.change24h != null && c.change24h < -cfg.maxDump24hPct) out.push(`crollo 24h > ${cfg.maxDump24hPct}%`);
  return out;
}
// offerta di trading: leva + long/short solo dove Jupiter Perps lo permette
function offer(c, lev) { return c.perp ? { lev, sides: ['LONG', 'SHORT'], label: `${lev}x · L/S` } : { lev: 1, sides: ['LONG'], label: 'Spot · Long' }; }

class Universe {
  constructor({ log = () => {}, getCfg, phantomMints = () => [], fetch = fetchJson } = {}) {
    this.log = log; this.getCfg = getCfg; this.phantomMints = phantomMints; this.fetch = fetch;
    this.coins = {}; this.ts = 0; this.err = null; this.busy = false;
  }
  async refresh(force = false) {
    if (this.busy || (!force && Date.now() - this.ts < REFRESH_MS)) return this.list();
    this.busy = true;
    try {
      const cfg = this.getCfg(); const got = {};
      const add = (arr, phantom) => { for (const t of arr || []) if (t && t.id) { const c = fromJup(t, phantom || (got[t.id] && got[t.id].phantom)); got[t.id] = c; } };
      for (const u of [`${TOKENS_API}/toptraded/24h?limit=100`, `${TOKENS_API}/toporganicscore/24h?limit=100`]) {
        try { add(await jq(() => this.fetch(u, { retries: 1, timeout: 15000 }))); } catch (e) { this.err = `lista Jupiter: ${e.message}`; }
      }
      // i mercati con leva ci sono sempre; poi i token del tuo Phantom
      const ph = [...new Set(this.phantomMints())].filter((m) => m && m !== USDC);
      const need = [...Object.keys(P.SHORT_MARKETS), ...ph];
      for (let i = 0; i < need.length; i += 50) {
        try { add(await jq(() => this.fetch(`${TOKENS_API}/search?query=${need.slice(i, i + 50).join(',')}`, { retries: 1, timeout: 15000 }))); } catch (e) { this.err = `ricerca Jupiter: ${e.message}`; }
      }
      for (const m of ph) if (got[m]) got[m].phantom = true;
      for (const c of Object.values(got)) c.reasons = screen(c, cfg);
      if (Object.keys(got).length) { this.coins = got; this.ts = Date.now(); this.err = null; }
      const ok = this.eligible().length;
      this.log('SCANSIONE', `Universo cripto aggiornato: ${Object.keys(got).length} token letti da Jupiter${ph.length ? ` (+${ph.length} dal tuo Phantom)` : ''}, ${ok} superano i filtri di sicurezza`);
    } finally { this.busy = false; }
    return this.list();
  }
  list() { return Object.values(this.coins); }
  get(mint) { return this.coins[mint] || null; }
  eligible() { return this.list().filter((c) => !c.reasons || !c.reasons.length); }
  // nel test si può iniettare l'universo
  setCoins(arr, cfg) { this.coins = {}; for (const c of arr) { c.reasons = screen(c, cfg || this.getCfg()); this.coins[c.mint] = c; } this.ts = Date.now(); }
  status() {
    const all = this.list(); const ok = this.eligible();
    return { ts: this.ts, total: all.length, eligible: ok.length, err: this.err,
      phantom: all.filter((c) => c.phantom).map((c) => ({ symbol: c.symbol, mint: c.mint, icon: c.icon, ok: !c.reasons.length, why: c.reasons.slice(0, 2) })).slice(0, 30),
      top: ok.sort((a, b) => b.volume24h - a.volume24h).slice(0, 12).map((c) => ({ symbol: c.symbol, mint: c.mint, icon: c.icon, perp: c.perp })) };
  }
}
module.exports = { Universe, screen, fromJup, offer, coinColor, PERP_INFO };
