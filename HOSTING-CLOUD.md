# GrokBot Solana nel cloud (gratis, sempre acceso, HTTPS) — guida da iPhone

Hosting consigliato: **Northflank – piano Sandbox gratuito** (verificato novembre 2026):
sempre acceso (non va in sospensione), $20/mese di risorse gratis, HTTPS automatico,
**volume persistente** per il wallet cifrato e lo stato, build dal `Dockerfile` di questo progetto.

> Il bot usa **solo API gratuite** (Jupiter lite-api, DexScreener, GeckoTerminal, RugCheck, RPC pubblico Solana).

## Cosa ti serve (una volta sola)
1. Il repository **privato** `grokbot-solana` sul tuo GitHub (`lumisamuele0-lgtm`): solo tu lo vedi.
   Non contiene chiavi né password: wallet e PIN restano solo sul volume del server.
2. Un account **Northflank** (piano gratuito Sandbox). Northflank legge il repo privato tramite la sua
   app GitHub, a cui dai accesso **solo** a `grokbot-solana`.
   Nota: Northflank può chiedere una carta **solo per verifica identità** (non addebita nulla se resti
   nei $20/mese gratuiti; imposta comunque un avviso di spesa a $1).

## Passi da iPhone (Safari)
1. Apri **app.northflank.com/signup** → «Sign up with GitHub» → accedi con GitHub → piano **Sandbox (Free)**.
2. Quando chiede di collegare Git: **Link GitHub** → si apre GitHub → «Only select repositories» →
   scegli **grokbot-solana** → **Install**. Torni su Northflank.
   (Se non lo chiede: menu team → **Integrations → Git → Link GitHub**.)
3. **Create new → Project** → nome `grokbot` → regione **Europa** → **Create**.
4. **Create new → Service → Combined service** → nome `bot`:
   - *Repository*: `lumisamuele0-lgtm/grokbot-solana` · branch `main`
   - *Build*: **Dockerfile** · percorso `/Dockerfile` · contesto `/`
   - *Resources*: il piano più piccolo
   - *Ports*: **8787**, **HTTP**, spunta **Publicly expose**
   - *Environment*: `DATA_PERSISTENT` = `1` e `SETUP_PIN` = il tuo PIN (6–12 cifre)
   - **Create service**
5. Nel servizio: **Volumes → Add volume** → nome `dati` · **1 GB** · mount path **`/data`** → **Create**.
6. Aspetta **Running** (2–4 minuti). In **Networking** copia l'indirizzo `https://….code.run` e aprilo.
7. Entra con il PIN di `SETUP_PIN`. (Se non l'hai messo: **Logs** → copia il **CODICE DI CONFIGURAZIONE**
   di 8 caratteri e inseriscilo con il nuovo PIN; vale una sola volta.)
8. Safari → **Condividi → Aggiungi alla schermata Home**.
9. **Phantom**: «Collega Phantom» apre la stessa pagina nel browser di Phantom → collega → «Deposita».
10. Consigliato: **Billing → Alerts** → avviso a **$1**, così sai subito se superi il gratuito.

## Sicurezza
- Solo HTTPS (le richieste http vengono reindirizzate), cookie di sessione `Secure; HttpOnly; SameSite=Strict`, HSTS.
- PIN con blocco dopo 5 errori; chiave del bot cifrata (scrypt + AES‑256‑GCM) con la tua password, mai salvata in chiaro.
- La chiave del wallet del bot vive sul server Northflank: tieni nel bot **solo il budget** che sei disposto a rischiare.
- Fai comunque un **backup**: Impostazioni → Portafoglio del bot → «Esporta chiave» (o «Backup cifrato»).

## Aggiornare il bot
Ogni modifica al repository privato su GitHub fa ripartire la build in automatico; i dati restano sul volume `/data`.
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
