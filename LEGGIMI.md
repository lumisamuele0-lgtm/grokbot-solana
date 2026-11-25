# GrokBot Solana — guida passo passo

Bot di trading **completamente automatico** su Solana. Gira sul **tuo computer**, lo controlli dal PC o dall'**iPhone**, usa **Phantom** per depositare e prelevare e **Jupiter** per gli scambi. Non servono API a pagamento.

> ⚠️ **Leggi prima di usare soldi veri.** Il trading automatico, soprattutto sulle meme coin, può far perdere velocemente il capitale. Nessuna strategia garantisce profitti. Parti in **SIMULAZIONE**, poi prova la modalità reale con un importo piccolo che puoi permetterti di perdere.

---

## 1. Cosa ti serve

- Un computer Windows, Mac o Linux che resti **acceso** mentre il bot lavora (se il PC si spegne o va in stop, il bot si ferma).
- **Node.js** (gratuito): scarica la versione **LTS** da <https://nodejs.org/it/download> e installala con le opzioni predefinite.
- **Phantom**: estensione per il browser del PC (<https://phantom.com/download>) e/o app su iPhone.

## 2. Avvio

1. Estrai lo zip in una cartella, per esempio `Documenti/GrokBot`.
2. Avvia:
   - **Windows**: doppio clic su `avvia-windows.bat`.
   - **Mac**: doppio clic su `avvia-mac.command` (la prima volta: clic destro → *Apri* → *Apri*).
   - **Linux**: `./avvia-mac-linux.sh` dal terminale.
   - In alternativa, da terminale nella cartella: `npm install` e poi `npm start`.
3. La prima volta installa i componenti (1–2 minuti). Poi si apre il browser su **http://localhost:8787**.
4. **Lascia aperta la finestra nera**: se la chiudi il bot si ferma.

## 3. Primo accesso

1. Scegli un **PIN** di 6–12 cifre. Serve per entrare dall'iPhone e da altri dispositivi. (Il primo PIN si può impostare solo dal computer dove gira il bot.)
2. Nella schermata **Capitale di partenza** scegli:
   - **Modalità**: *Simulazione* (consigliato all'inizio) o *Reale*.
   - **Valuta**: USDC (consigliato: i profitti e il kill switch restano in dollari) oppure SOL.
   - **Budget massimo**: il bot non userà mai più di questa cifra.
3. Premi **Avvia sessione** e poi **Avvia** nella barra in basso.

## 4. La schermata principale

- **Saldo in €** con profitto/perdita e moltiplicatore (es. `1,02x`), grafico dell'andamento.
- **Sala operativa**: gli 8 bot si muovono davvero quando il motore lavora (scansione, filtro, analisi, swap su Jupiter, monete che entrano/escono dalla cassa). **Tocca un bot** per leggere cosa sta decidendo e perché.
- **Token analizzati / scartati / approvati**, **Banco · 8 agenti** (tocca una riga per lo storico), **Logger** in tempo reale, **Scartati per regola**, posizioni aperte, storico e portafogli.

### Gli 8 agenti
| Agente | Ruolo |
|---|---|
| SCANSIONE (Scout) | trova token: lista principale (SOL, JUP, BONK, WIF, JTO, PYTH, RAY, POPCAT) + meme Solana nuovi/di tendenza da DexScreener |
| VERIFICA (Filtro) | regole anti-rug: liquidità, volume, età del pool, market cap, pump/crollo, vendite>acquisti, mint/freeze authority, RugCheck, holder concentrati |
| SOCIAL (Flusso) | flusso reale acquisti/vendite e accelerazione dei volumi (DexScreener) |
| CAPO (Analista) | indicatori su candele 1 minuto reali: EMA 9/21, trend 5m, RSI, momentum, volatilità (ATR); sceglie il migliore |
| DIMENSIONE | quanto investire (max % del capitale, metà per i meme, ridotto se volatile) |
| RISCHIO | stop-loss/target in base alla volatilità, trailing stop, limiti giornalieri, posizioni max, **kill switch** |
| ESECUZIONE | quote e swap su Jupiter (gratuito), firma con il wallet del bot, conferma on-chain |
| SORVEGLIANZA | controlla le posizioni e chiude a target, stop, trailing o tempo massimo |

## 5. I pulsanti

- **Phantom**: collega il tuo wallet.
- **Budget**: cambia capitale e modalità.
- **Deposita**: sposta il budget da Phantom al wallet del bot (lo confermi tu in Phantom).
- **Avvia / Pausa**: accende o ferma i bot.
- **Preleva**: vende tutto e rimanda tutti i fondi al tuo Phantom.
- **Impostazioni**: rischio, token, RPC, wallet del bot, accesso da iPhone, stop di emergenza.

## 6. Passare ai soldi veri (modalità REALE)

Phantom non permette a un'app di firmare da sola ogni operazione, quindi il bot usa un **wallet dedicato** (separato dal tuo Phantom) che contiene solo il budget che gli dai.

1. **Impostazioni → Guida trading reale** (oppure scegli *Reale* nella schermata Budget).
2. **Crea il wallet del bot** con una password (almeno 8 caratteri). La chiave è cifrata su questo PC (scrypt + AES-256-GCM) e non viene mai inviata da nessuna parte. **Se perdi la password non si recupera.**
3. **Collega Phantom**.
4. **Deposita**: il pulsante prepara un trasferimento del budget + **0,03 SOL** di riserva per le commissioni. Controlla importo e destinatario in Phantom e conferma. Il primo indirizzo Phantom che deposita diventa l'**indirizzo di prelievo**.
5. Scrivi **ATTIVA REALE** e conferma. Poi premi **Avvia**.

Ogni transazione reale è nel Logger e in *Portafogli* con il link a **Solscan**.

**Preleva tutto** (serve la password del wallet): ferma il bot, vende tutte le posizioni, invia tutti gli USDC e i SOL al tuo Phantom, chiude i conti token vuoti per recuperare l'affitto.

**Dopo un riavvio del PC** il wallet del bot è bloccato e il trading è in pausa: entra nell'app, sbloccalo con la password e premi Avvia. (Per un avvio automatico senza intervento esistono le variabili `BOT_WALLET_PASSWORD` e `BOT_AUTOSTART=1`, ma mettere la password in chiaro in un file riduce la sicurezza: usale solo se sai cosa fai.)

## 7. Usarlo dall'iPhone

**Stessa rete Wi-Fi di casa**
1. Nella finestra nera c'è l'indirizzo *Da iPhone* (es. `http://192.168.1.20:8787`) e un **QR code**: inquadralo con la fotocamera. Lo trovi anche in **Impostazioni → Apri da iPhone**.
2. Entra con il PIN.
3. In Safari: **Condividi → Aggiungi alla schermata Home**. Si apre a schermo intero come un'app.
4. Se Windows chiede di consentire l'accesso alla rete per Node.js, scegli **Reti private → Consenti**.

**Phantom su iPhone (deposito dal telefono)**
Su iPhone il collegamento a Phantom funziona dentro l'app Phantom: tocca **Phantom** nell'app → **Apri in Phantom**. La pagina si apre nel browser interno di Phantom, dove colleghi il wallet e firmi il deposito (dovrai inserire di nuovo il PIN). Se Phantom non apre un indirizzo `http://`, usa l'accesso HTTPS qui sotto (Tailscale Serve o Cloudflare).

**Fuori casa (gratis)**
- **Tailscale (consigliato, privato)**: crea un account gratuito su <https://tailscale.com>, installa Tailscale sul PC e sull'iPhone con lo stesso account. Poi dall'iPhone apri `http://NOME-DEL-PC:8787` (o l'IP 100.x.x.x mostrato da Tailscale). Per avere HTTPS: sul PC esegui `tailscale serve --bg 8787` e usa l'indirizzo `https://…ts.net` che ti mostra.
- **Cloudflare Quick Tunnel (senza account)**: installa `cloudflared` (<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>) e lancia `cloudflared tunnel --url http://localhost:8787`. Ti dà un indirizzo `https://….trycloudflare.com` che cambia a ogni avvio. È pubblico: ti protegge solo il PIN, quindi scegline uno lungo e chiudi il tunnel quando non serve.

## 8. Tenere il bot acceso 24/7

- **Windows**: Impostazioni → Sistema → Alimentazione → *Sospensione: Mai* (con alimentatore collegato).
- **Mac**: il file di avvio usa `caffeinate`, che impedisce lo stop finché il bot è aperto. Lascia il Mac collegato alla corrente e non chiudere il coperchio (salvo con monitor esterno).
- Connessione Internet stabile. Se manca la rete, il bot non apre nuove operazioni (indicatore "DATI IN ATTESA") e riprova da solo.

## 9. Impostazioni di rischio (valori iniziali)

| Impostazione | Valore | Significato |
|---|---|---|
| Kill switch % | 20 | se il capitale scende del 20%, vende tutto (in USDC) e si ferma |
| Kill switch assoluto | 0 (off) | come sopra ma in importo fisso |
| Stop giornaliero | 8% | niente nuove operazioni fino a domani |
| Cripto | solo principali | SOL, BTC (cbBTC), ETH, JUP, RAY, KMNO, JTO, PYTH, ORCA, RENDER, HNT, W · niente meme né pool nuovi (attivabili in Impostazioni) |
| Rischio per operazione | 7% | del capitale (budget + utili realizzati) investito in ogni trade, meme compresi |
| Posizioni max | 3 | |
| Slippage | 100 bps (1%) | |
| Impatto prezzo max | 1% | se lo swap muove troppo il prezzo, non entra |
| Durata max | 240 min | poi chiude comunque |
| Filtri meme | Liq ≥ 40k $, Vol 24h ≥ 3k $, età dalla creazione del pool ≥ 1 minuto, MCap ≥ 300k $, RugCheck ≤ 30, niente mint/freeze authority | |

I **LONG** sono sempre spot (1x). Gli **SHORT** (solo SOL, BTC, ETH) usano Jupiter Perps con leva massima **2x**: vedi sotto.

### Uscite furbe (attive di default)
R = distanza dello stop-loss iniziale, calcolata sulla volatilità (ATR × 2,2, tra 1,5% e 10%; meme almeno 3%).
- **Presa parziale 1**: a +1R vende il 40% e sposta lo stop a pareggio (+0,3% per coprire le commissioni).
- **Presa parziale 2**: a +2R vende un altro 30% della quantità iniziale.
- **Trailing stop**: si attiva da +1R e segue il massimo a 1,5 × ATR di distanza, mai più largo dello stop iniziale; non scende mai.
- **Meme**: prese e trailing più vicini (× 0,75).
- **Uscita a tempo**: dopo 90 minuti sotto +0,5% e senza prese, chiude. Resta il limite massimo di 240 minuti.
- **Uscita rapida**: crollo oltre il 3% (o 2 × ATR) in 5 minuti sotto la EMA9, oppure sui meme vendite ≥ 75% delle transazioni dell'ultima ora (almeno 40), dopo i primi 3 minuti.
Le prese parziali entrano subito nel PnL realizzato; il resto resta "aperto". Nello storico il trade compare una sola volta, alla chiusura completa, con il rendimento complessivo (ed è da questo che impara il Mentore). Tutto è modificabile in Impostazioni → Uscite furbe.

### LONG + SHORT (Jupiter Perps, max 2x)
- Il CAPO cerca anche segnali **SHORT** speculari a quelli LONG: EMA9 sotto EMA21, trend 5m ribassista, EMA21 in discesa, RSI 28–50, momentum 15m negativo, flusso non in acquisto; niente short se il mercato SOL sale più dell'1% in un'ora.
- Solo **SOL, BTC, ETH** si possono shortare (mercati Jupiter Perps, collaterale **USDC**). Mai un long e uno short sullo stesso asset insieme.
- **Margine** = rischio per operazione (7% del capitale), **leva 2x** di default (limite rigido 2x) → esposizione fino al 14%.
- **Commissioni** (lette on-chain il 25/11/2026): 0,06% all'apertura + 0,06% alla chiusura sull'esposizione, più il **prestito orario** (oggi ~0,0001%/h; in simulazione contiamo 0,001%/h, prudente). L'impatto prezzo per importi piccoli è trascurabile.
- **Liquidazione** a 2x: circa **+49,7%** sopra l'ingresso. Lo stop-loss è sempre al massimo il 40% di quella distanza e il bot chiude comunque se il prezzo arriva all'80% della distanza.
- Uscite furbe specchiate: prese parziali quando il prezzo scende, stop a pareggio, trailing che scende col minimo, uscita rapida su rimbalzo, time stop.
- **Stato in REALE**: le transazioni (apertura, chiusura parziale e totale) sono costruite dal bot e **simulate su mainnet** con esito positivo (`node scripts/perps-check.js`, nessun invio). L'esecuzione da parte dei keeper Jupiter con fondi veri non è ancora verificata, quindi **in REALE gli short restano spenti** (il bot fa solo LONG e lo scrive nel Logger). In SIMULAZIONE funzionano completamente.

### Il Mentore (9° bot)
Impara da ogni trade chiuso, simulato o reale (i reali pesano 1,5×), quali caratteristiche portano a vincere o perdere: tipo di token, età del pool, volume, liquidità, fascia oraria, volatilità, RSI, momentum, flusso acquisti/vendite, condizioni rispettate e andamento di SOL. Le statistiche sono smussate (prior bayesiano di 8 trade verso la media), salvate in `knowledge.json` e sopravvivono ai riavvii. Dopo 10 trade inizia a consigliare: riordina i candidati e la watchlist e blocca i setup con rendimento atteso negativo e un pattern chiaramente perdente (≥ 8 trade, < 40% vincenti). Non cambia mai il 7% per operazione, i filtri minimi, lo stop-loss o il kill switch.

## 10. Limiti e rischi (onesti)

- **Nessun profitto garantito.** Le strategie con indicatori tecnici perdono spesso, soprattutto nei mercati laterali. Commissioni e slippage pesano sulle operazioni piccole. In simulazione le prime operazioni di prova sono state sia in guadagno sia in perdita.
- **Meme coin**: possono crollare in pochi minuti, anche dopo i filtri; lo stop-loss può scattare a un prezzo peggiore (slippage). Puoi disattivarle: Impostazioni → *Scansiona meme coin*.
- **Hot wallet**: la chiave del bot è sul tuo PC (cifrata). Se il PC è compromesso mentre il wallet è sbloccato, i fondi del bot sono a rischio. Tieni sul bot solo il budget e preleva quando hai finito.
- **Servizi gratuiti**: RPC pubblico di Solana, Jupiter, DexScreener, GeckoTerminal e RugCheck hanno limiti di richieste. Se sono lenti o fuori servizio il bot aspetta; per più affidabilità puoi inserire un tuo RPC (anche gratuito, es. Helius o QuickNode free) in Impostazioni → Rete.
- **Simulazione**: usa prezzi e quote **reali** di Jupiter (incluso l'impatto sul prezzo) e stima le commissioni di rete, ma nella realtà gli eseguiti possono differire.
- **PC acceso**: se il computer si spegne, le posizioni aperte restano nel wallet del bot senza protezione finché non lo riaccendi.

## 11. File e dati

- `data/` (creata al primo avvio): impostazioni, stato, storico, `wallet.enc.json` (chiave cifrata), `auth.json` (PIN cifrato). **Fai un backup di `wallet.enc.json`** se usi soldi veri. Non condividere mai questi file.
- Per ricominciare da zero: chiudi il bot e cancella la cartella `data/` (prima **preleva tutto**!).

## 12. Per chi è tecnico

- `npm test` — test unitari (indicatori, filtri, rischio, uscite, cifratura, PIN, depositi, prelievo).
- `node scripts/sim-run.js 8` — motore in simulazione per 8 minuti su dati live.
- `node scripts/verify-real-path.js` — costruisce swap Jupiter e depositi reali e li fa **solo simulare** dall'RPC (non invia nulla).
- Variabili: `PORT` (8787), `HOST` (0.0.0.0), `DATA_DIR`, `NO_QR=1`, `OPEN_BROWSER=1`, `BOT_WALLET_PASSWORD`, `BOT_AUTOSTART=1`, `JUP_API`.

## Hosting cloud gratuito (sempre acceso, da iPhone)
Vedi **HOSTING-CLOUD.md**: Northflank Sandbox gratuito, HTTPS, volume persistente `/data`, Dockerfile incluso.
