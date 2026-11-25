'use strict';
// Rete: ogni chiamata esterna (RPC, Jupiter, prezzi, ricerca) solo su HTTPS/TLS
const test = require('node:test'); const assert = require('node:assert');
const { assertTls, fetchJson, fetchText } = require('../../src/util');
const chain = require('../../src/chain');

test('assertTls: solo https (localhost ammesso per i test locali)', () => {
  for (const u of ['https://api.mainnet-beta.solana.com', 'https://lite-api.jup.ag/swap/v1/quote?x=1', 'http://127.0.0.1:8899', 'http://localhost:8899']) assert.doesNotThrow(() => assertTls(u), u);
  for (const u of ['http://api.mainnet-beta.solana.com', 'ftp://x.io', 'file:///etc/passwd', 'ws://x.io', 'javascript:alert(1)', 'not a url', '', null]) assert.throws(() => assertTls(u), String(u));
});

test('fetchJson/fetchText e la connessione RPC rifiutano http in chiaro (prima di aprire la connessione)', async () => {
  await assert.rejects(() => fetchJson('http://example.com/x.json'));
  await assert.rejects(() => fetchText('http://example.com/'));
  assert.throws(() => chain.connection('http://api.mainnet-beta.solana.com'));
});
