# GrokBot Solana nel cloud (gratis, sempre acceso, HTTPS) — guida da iPhone

Hosting consigliato: **Northflank – piano Sandbox gratuito** (verificato novembre 2026):
sempre acceso (non va in sospensione), nessuna carta di credito, HTTPS automatico,
**volume persistente** per il wallet cifrato e lo stato, build dal `Dockerfile` di questo progetto.

> Il bot usa **solo API gratuite** (Jupiter lite-api, DexScreener, GeckoTerminal, RugCheck, RPC pubblico Solana).

## Cosa ti serve (una volta sola)
1. Un account **GitHub** (gratis) con il codice del bot in un repository **pubblico**
   (il codice non contiene chiavi né password: wallet e PIN restano solo sul volume del server).
2. Un account **Northflank** (gratis, accesso con GitHub).

## Passi da iPhone (Safari)
1. Apri **app.northflank.com/signup** → «Continua con GitHub» → scegli il piano **Sandbox (Free)**.
2. **Create new → Project** → nome `grokbot` → regione **Europa** (es. *Europe – West*) → Create.
3. **Create new → Service → Combined service** → nome `bot`.
   - *Repository*: collega GitHub e scegli il repo `grokbot-solana`, branch `main`.
   - *Build options*: **Dockerfile** (percorso `/Dockerfile`, contesto `/`).
   - *Resources*: il più piccolo disponibile nel piano gratuito.
   - *Networking → Ports*: porta **8787**, protocollo **HTTP**, spunta **Publicly expose**.
   - *Environment variables*:
     - `DATA_PERSISTENT` = `1`
     - `SETUP_PIN` = il tuo PIN (6–12 cifre) – facoltativo ma consigliato
   - **Create service**.
4. Nel servizio apri **Volumes → Add volume** → nome `dati`, dimensione **1 GB**, mount path **`/data`** → Create.
   Il servizio si riavvia: da adesso wallet, PIN, impostazioni e storico sopravvivono a riavvii e aggiornamenti.
5. Attendi lo stato **Running** (2–4 minuti la prima volta). In **Networking** trovi l'indirizzo
   `https://….code.run`: aprilo in Safari.
6. **Primo accesso**: se hai impostato `SETUP_PIN` entra con quel PIN. Altrimenti apri **Logs** del servizio,
   copia il **CODICE DI CONFIGURAZIONE** (8 caratteri) e inseriscilo insieme al nuovo PIN.
   Il codice vale una sola volta: dopo, nessun altro può impostare il PIN.
7. In Safari: **Condividi → Aggiungi alla schermata Home** → l'app si apre a tutto schermo come un'app vera.
8. **Phantom**: dall'app premi «Collega Phantom» → si apre il browser interno di Phantom sulla stessa pagina
   (l'indirizzo è https, quindi Phantom lo accetta) → collega e usa «Deposita».

## Sicurezza
- Solo HTTPS (le richieste http vengono reindirizzate), cookie di sessione `Secure; HttpOnly; SameSite=Strict`, HSTS.
- PIN con blocco dopo 5 errori; chiave del bot cifrata (scrypt + AES‑256‑GCM) con la tua password, mai salvata in chiaro.
- La chiave del wallet del bot vive sul server Northflank: tieni nel bot **solo il budget** che sei disposto a rischiare.
- Fai comunque un **backup**: Impostazioni → Portafoglio del bot → «Esporta chiave» (o «Backup cifrato»).

## Aggiornare il bot
Ogni modifica al repository GitHub fa ripartire la build in automatico; i dati restano sul volume `/data`.
Dopo un riavvio il trading riparte **in pausa** e in REALE va risbloccato con la password (per sicurezza).
Se nel wallet c'erano token di posizioni aperte, il bot li **recupera** e li rimette sotto stop‑loss.

## Alternative (peggiori, solo se Northflank non va)
- **Render (render.yaml incluso)**: gratis ma si **addormenta dopo 15 minuti** senza visite e il disco si
  **cancella** a ogni riavvio. Serve `KEEPALIVE_URL` = indirizzo del servizio, `SETUP_PIN` e, per il
  trading reale, `WALLET_ENC_JSON` = testo del «Backup cifrato». Uso reale sconsigliato.
- **Koyeb free**: si sospende dopo 1 ora di inattività e non ha volumi. Sconsigliato per un bot 24/7.

## Variabili d'ambiente supportate
| Variabile | Scopo |
|---|---|
| `SETUP_PIN` | PIN impostato all'avvio (utile se il disco non è persistente) |
| `DATA_PERSISTENT=1` | dichiara che `/data` è un volume persistente (toglie l'avviso) |
| `WALLET_ENC_JSON` | backup cifrato del wallet del bot (ripristinato se manca il file) |
| `BOT_WALLET_PASSWORD` | sblocco automatico all'avvio (comodo ma meno sicuro: sconsigliato) |
| `KEEPALIVE_URL` | auto‑ping ogni 10 min per hosting che si addormentano |
| `DEMO_MODE=1` | solo simulazione: wallet e fondi reali disattivati |
| `PORT` | porta (default 8787) |
