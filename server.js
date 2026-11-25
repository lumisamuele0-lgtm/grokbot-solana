'use strict';
// GrokBot Solana — server (gira sul tuo PC o in hosting). Interfaccia: http://localhost:8787
// Tutte le protezioni (intestazioni, sessioni, CSRF, limiti, validazione, archivio cifrato) sono in src/app.js.
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { createApp, lanUrls: lan } = require('./src/app');
const { keepAliveUrl } = require('./src/hosting');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.accessSync(DATA, fs.constants.W_OK); } catch { console.error(`ERRORE: la cartella dati ${DATA} non è scrivibile`); process.exit(1); }
const ctx = createApp({ dataDir: DATA });
const { app, engine } = ctx;
const IN_CONTAINER = ctx.inContainer; const DEMO = ctx.demo; const PERSISTENT = ctx.persistent;
const lanUrls = () => lan(PORT);
const server = app.listen(PORT, HOST, async () => {
  const urls = lanUrls();
  console.log('\n  =============================================');
  console.log('     GROKBOT SOLANA - bot di trading attivo');
  console.log('  =============================================');
  if (IN_CONTAINER) console.log(`  In ascolto sulla porta ${PORT} (l'hosting fornisce l'indirizzo https)`);
  else { console.log(`  Su questo computer:  http://localhost:${PORT}`); for (const u of urls) console.log(`  Da iPhone (stessa Wi-Fi):  ${u}`); }
  if (urls[0] && !process.env.NO_QR && !IN_CONTAINER) { try { console.log(await QRCode.toString(urls[0], { type: 'terminal', small: true })); console.log('  Inquadra il QR con la fotocamera dell\'iPhone.'); } catch {} }
  if (!IN_CONTAINER) console.log('  Lascia questa finestra aperta: se la chiudi il bot si ferma.\n');
  if (DEMO) console.log('  MODALITÀ DEMO: solo simulazione, wallet e fondi reali disattivati.');
  if (!PERSISTENT) console.log('  ATTENZIONE: disco non persistente. Imposta SETUP_PIN e, se usi il trading reale, WALLET_ENC_JSON (backup cifrato).');
  if (ctx.setupToken) console.log(`\n  >>> CODICE DI CONFIGURAZIONE (primo accesso da remoto): ${ctx.setupToken} <<<\n`);
  // Keep-alive: Render (piano free) spegne il servizio dopo 15 minuti senza traffico in ENTRATA.
  // Se KEEPALIVE_URL non è impostata, su Render si usa l'indirizzo pubblico RENDER_EXTERNAL_URL fornito da Render.
  // KEEPALIVE_URL=off lo disattiva.
  const keepUrl = keepAliveUrl(process.env);
  if (keepUrl) {
    const ping = () => fetch(keepUrl + '/healthz', { signal: AbortSignal.timeout(20000) }).catch(() => {});
    setInterval(ping, 10 * 60000).unref();
    console.log('  Keep-alive attivo verso', keepUrl);
  }
  engine.start();
  if (process.env.OPEN_BROWSER === '1') {
    const { exec } = require('child_process');
    const u = `http://localhost:${PORT}`;
    exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`, () => {});
  }
});
const shutdown = () => { console.log('\nArresto in corso, salvo lo stato…'); engine.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
module.exports = { app, engine };
