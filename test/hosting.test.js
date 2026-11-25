'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keepAliveUrl } = require('../src/hosting');

test('keep-alive: usa KEEPALIVE_URL se presente', () => {
  assert.strictEqual(keepAliveUrl({ KEEPALIVE_URL: 'https://x.onrender.com/' }), 'https://x.onrender.com');
});
test('keep-alive: su Render usa RENDER_EXTERNAL_URL', () => {
  assert.strictEqual(keepAliveUrl({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://bot.onrender.com' }), 'https://bot.onrender.com');
});
test('keep-alive: disattivabile e assente fuori da Render', () => {
  assert.strictEqual(keepAliveUrl({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://b.onrender.com', KEEPALIVE_URL: 'off' }), null);
  assert.strictEqual(keepAliveUrl({}), null);
  assert.strictEqual(keepAliveUrl({ KEEPALIVE_URL: 'javascript:alert(1)' }), null);
});
