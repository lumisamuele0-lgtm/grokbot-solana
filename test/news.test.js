const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/news');
const { Research } = require('../src/research');

const T0 = Date.UTC(2026, 10, 25, 12);
const rss = (titles) => `<rss><channel>${titles.map((t, i) => `<item><title>${t}</title><pubDate>${new Date(T0 - (i + 1) * 60e3).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const hdr = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, headers: opts.headers }); const r = script(url, opts, calls.length); if (r instanceof Error) throw r; return { status: r.status || 200, ok: (r.status || 200) < 300, headers: hdr(r.headers || {}), text: async () => r.body || '' }; };
  fn.calls = calls; return fn;
}

test('notizie: lettura ogni ~90 s con timeout per feed', () => {
  assert.ok(N.NEWS_INTERVAL_MS >= 60e3 && N.NEWS_INTERVAL_MS <= 120e3, 'tra 1 e 2 minuti');
  assert.ok(N.FEED_TIMEOUT_MS <= 10e3);
});

test('notizie: richieste condizionali (ETag / If-Modified-Since) e 304 senza ricontare nulla', async () => {
  const f = fakeFetch((url, o, n) => (n === 1 ? { body: rss(['Bitcoin surges to record high', 'Solana DEX hacked']), headers: { etag: 'W/"abc"', 'last-modified': 'Wed, 25 Nov 2026 11:00:00 GMT' } } : { status: 304 }));
  const r = new N.NewsReader(null, { sources: [['Feed', 'https://x/rss']], fetchImpl: f });
  const a = await r.poll(T0); assert.strictEqual(a.fresh.length, 2);
  const b = await r.poll(T0 + 90e3); assert.strictEqual(b.fresh.length, 0);
  assert.strictEqual(f.calls[1].headers['if-none-match'], 'W/"abc"'); assert.strictEqual(f.calls[1].headers['if-modified-since'], 'Wed, 25 Nov 2026 11:00:00 GMT');
  assert.strictEqual(r.feeds.Feed.notModified, 1); assert.strictEqual(r.checks, 2);
  // stato salvato e ripreso: i titoli già visti non tornano "nuovi"
  const r2 = new N.NewsReader(JSON.parse(JSON.stringify(r.state())), { sources: [['Feed', 'https://x/rss']], fetchImpl: fakeFetch(() => ({ body: rss(['Bitcoin surges to record high', 'Solana DEX hacked', 'Ether rallies']) })) });
  const c = await r2.poll(T0 + 180e3); assert.deepStrictEqual(c.fresh.map((x) => x.title), ['Ether rallies']);
});

test('notizie: titoli duplicati tra feed diversi contati una volta sola', async () => {
  const f = fakeFetch(() => ({ body: rss(['Bitcoin surges to record high!', 'Ether falls']) }));
  const r = new N.NewsReader(null, { sources: [['A', 'https://a'], ['B', 'https://b']], fetchImpl: f });
  const a = await r.poll(T0); assert.strictEqual(a.fresh.length, 2);
});

test('notizie: 429 → pausa per quel feed (rispetta Retry-After), gli altri continuano; errori con pausa crescente', async () => {
  const f = fakeFetch((url) => (url.includes('lim') ? { status: 429, headers: { 'retry-after': '600' } } : url.includes('bad') ? new Error('rete') : { body: rss(['Solana rallies']) }));
  const r = new N.NewsReader(null, { sources: [['Lim', 'https://lim'], ['Bad', 'https://bad'], ['Ok', 'https://ok']], fetchImpl: f });
  const a = await r.poll(T0); assert.strictEqual(a.fresh.length, 1);
  assert.strictEqual(r.feeds.Lim.rateLimited, 1); assert.strictEqual(r.feeds.Lim.backoffUntil, T0 + 600e3);
  const b1 = r.feeds.Bad.backoffUntil - T0; assert.ok(b1 >= 180e3);
  const n = f.calls.length; await r.poll(T0 + 90e3);
  assert.strictEqual(f.calls.length - n, 1, 'solo il feed sano viene richiesto durante la pausa');
  await r.poll(T0 + 700e3); assert.ok(r.feeds.Bad.backoffUntil - (T0 + 700e3) > b1, 'pausa crescente');
  assert.ok(r.feeds.Lim.backoffUntil <= T0 + 700e3 + N.MAX_BACKOFF_MS);
});

test('notizie: timeout del singolo feed', async () => {
  const slow = (url, opts) => new Promise((res, rej) => { opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const r = new N.NewsReader(null, { sources: [['Lento', 'https://slow']], fetchImpl: slow });
  const t = Date.now(); const out = await r.poll(T0); assert.ok(Date.now() - t < N.FEED_TIMEOUT_MS + 2000);
  assert.match(out.results[0].error, /timeout/);
}, { timeout: 15000 });

test('ricerca: sentiment ricalcolato solo con titoli nuovi; log solo quando ce ne sono', async () => {
  const logs = []; const r = new Research({ dataDir: null, log: (a, t) => logs.push(t) });
  let body = rss(['Solana hacked, funds drained']);
  r.reader = new N.NewsReader(null, { sources: [['F', 'https://f']], fetchImpl: fakeFetch(() => ({ body })) });
  const now = Date.now();
  const a = await r.pollNews(now); assert.strictEqual(a.fresh, 1); assert.ok(r.st.news.agg.SOL.risk > 0);
  const t1 = r.st.news.t; const nLogs = logs.length;
  const b = await r.pollNews(now + 90e3); assert.strictEqual(b.fresh, 0); assert.strictEqual(r.st.news.t, t1, 'nessun ricalcolo'); assert.strictEqual(r.st.news.lastCheck, now + 90e3); assert.strictEqual(logs.length, nLogs);
  body = rss(['Solana hacked, funds drained', 'Bitcoin surges']);
  const c = await r.pollNews(now + 180e3); assert.strictEqual(c.fresh, 1); assert.ok(r.st.news.t > t1);
  const ps = r.publicStatus(); assert.strictEqual(ps.news.intervalSec, 90); assert.strictEqual(ps.news.checks, 3); assert.ok(ps.news.feeds.F.lastOk);
});
