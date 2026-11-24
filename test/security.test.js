const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { encryptSecret, decryptSecret, Keystore } = require('../src/keystore');
const { Auth } = require('../src/auth');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-'));

test('cifratura scrypt + AES-256-GCM: round trip e password errata', () => {
  const secret = Buffer.from('chiave-segreta-di-prova-0123456789');
  const blob = encryptSecret(secret, 'password-lunga');
  assert.strictEqual(blob.cipher, 'aes-256-gcm'); assert.strictEqual(blob.kdf.name, 'scrypt');
  assert.ok(!JSON.stringify(blob).includes('chiave-segreta'));
  assert.deepStrictEqual(decryptSecret(blob, 'password-lunga'), secret);
  assert.throws(() => decryptSecret(blob, 'sbagliata!!'), /Password errata/);
  const t = { ...blob, ct: Buffer.from(Buffer.from(blob.ct, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
  assert.throws(() => decryptSecret(t, 'password-lunga'), /Password errata/);
  assert.throws(() => encryptSecret(secret, 'corta'), /almeno 8/);
});
test('Keystore: crea, blocca, sblocca, esporta; file senza chiave in chiaro', () => {
  const d = tmp(); const f = path.join(d, 'w.json');
  const ks = new Keystore(f); const pk = ks.create('password-lunga');
  const raw = fs.readFileSync(f, 'utf8'); const j = JSON.parse(raw);
  assert.strictEqual(j.publicKey, pk); assert.ok(!('secretKey' in j));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  ks.lock(); assert.strictEqual(ks.info().unlocked, false);
  assert.throws(() => ks.unlock('nope-nope-nope'), /Password errata/);
  assert.strictEqual(ks.unlock('password-lunga'), pk);
  const bs58 = require('bs58').default; const { Keypair } = require('@solana/web3.js');
  assert.strictEqual(Keypair.fromSecretKey(bs58.decode(ks.exportBase58('password-lunga'))).publicKey.toBase58(), pk);
  assert.throws(() => ks.create('password-lunga'), /Esiste già/);
});
test('PIN: impostazione, login, blocco dopo 5 errori, sessioni', () => {
  const a = new Auth(path.join(tmp(), 'auth.json'));
  assert.throws(() => a.setup('12'), /6 a 12 cifre/);
  const tok = a.setup('123456'); assert.ok(a.check(tok));
  assert.throws(() => a.setup('654321'), /già/);
  for (let i = 0; i < 5; i++) assert.throws(() => a.login('000000', 'ip1'), /PIN errato/);
  assert.throws(() => a.login('123456', 'ip1'), /Troppi tentativi/);
  const t2 = a.login('123456', 'ip2'); assert.ok(a.check(t2));
  a.logout(t2); assert.ok(!a.check(t2)); assert.ok(!a.check('ff'.repeat(32)));
});
