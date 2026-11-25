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

### La partita: Fulmini Rossi contro Squali Blu (14 bot)
Al posto dei 9 bot ci sono **2 squadre da 7**: 6 giocatori + 1 allenatore. Premi **Avvia** = calcio d'inizio: **20 minuti**, vince la squadra che fa **più profitto**. Poi compare **«Nuova partita?» Sì / No**.
- **Cripto (max 3 per squadra)**: l'allenatore sceglie fino a 3 cripto fra tutte quelle scambiabili su Solana con Phantom/Jupiter, compresi i token nel tuo Phantom, e le rivaluta ogni 5 minuti (mai mentre ha posizioni aperte su quella cripto). Le due squadre possono scegliere cripto diverse. Filtri di sicurezza: token verificato su Jupiter, niente autorità di mint/freeze, niente Token-2022, niente stablecoin/azioni tokenizzate, liquidità ≥ 250k $, volume 24h ≥ 500k $, capitalizzazione ≥ 10M $, età ≥ 7 giorni, holder non troppo concentrati, niente pump/crolli estremi, poi RugCheck e verifica che esista una via di vendita su Jupiter (anti-honeypot).
- **Leva e short solo dove si può**: su SOL, BTC ed ETH (Jupiter Perps) leva minima 5x, long e short, stop prima della liquidazione. Su tutte le altre cripto **spot 1x, solo long** (swap Jupiter), stessa dimensione 7% e uscite furbe. Per ogni cripto giocano 2 giocatori: perps = attaccante (long) + difensore (short); spot = attaccante + scalper (entrambi long). Chi resta senza posto va in panchina.
- **Spot REALE**: in modalità REALE gli acquisti spot veri partono solo se accendi «Spot REALE» in Impostazioni (budget, kill switch e limiti giornalieri restano). Leva e short reali restano bloccati fino al test con 5-10 USDC.
- **Cassa**: metà del capitale disponibile a ciascuna squadra, con gli stessi limiti di sempre (margine 7%, leva minima 5x, stop prima della liquidazione, uscite intelligenti, limiti giornalieri, kill switch).
- **Giocatori**: ognuno è specialista di una cripto e di una direzione (SOL/BTC/ETH × long/short) e fa per la sua operazione tutto il lavoro dei vecchi bot (scansione, verifica, flusso, scelta, dimensione, rischio, esecuzione, sorveglianza). I **Fulmini Rossi** giocano su trend e momentum, gli **Squali Blu** in contropiede sugli eccessi (RSI, Bande di Bollinger, funding…).
- **Allenatori** (Mister Fiamma, Mister Ghiaccio): ricevono le lezioni del **Mentore** e le notizie, e possono solo: piccola spinta di punteggio a chi è in forma (max +0,5), focus su una cripto (+0,2), più selettività dopo 2 perdite di fila, time-out di 2 minuti dopo 3 perdite. **Non toccano mai** margine, leva, stop o kill switch.
- **Fine partita**: si chiudono le posizioni della partita (in simulazione al prezzo di mercato), si proclama il vincitore e il migliore in campo; storico e vittorie sono salvati in `data/matches.json`. La partita sopravvive ai riavvii (dopo un riavvio il bot è in pausa: premi **Avvia**; il cronometro intanto continua).
- **REALE**: la partita segue la modalità scelta, ma in REALE i perps restano bloccati finché non approvi il test con 5-10 USDC: l'app lo scrive chiaramente e non invia nessun ordine reale.
- **Animazioni**: stadio con tifosi, tabellone e cronometro; giocatori con maglie e accessori diversi che camminano, palleggiano la posizione aperta, esultano o si rattristano; monete che volano tra la cassa della squadra e la Borsa; fumetti degli allenatori; ultimo minuto con battito rosso e numeroni finali; coppa, coriandoli e fuochi d'artificio per chi vince, nuvoletta di pioggia per chi perde, stretta di mano in caso di pareggio. Con «Riduci movimento» attivo su iPhone gli effetti sono ridotti.

## 5. I pulsanti

- **Phantom**: collega il tuo wallet.
- **Budget**: cambia capitale e modalità.
- **Deposita**: sposta il budget da Phantom al wallet del bot (lo confermi tu in Phantom).
- **Avvia / Pausa**: calcio d'inizio di una nuova partita (o ripresa di quella in corso) / pausa dei bot.
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
| Cripto | solo SOL, BTC, ETH con leva | ogni nuovo ingresso è con leva (min 5x) su Jupiter Perps, LONG o SHORT · niente acquisti spot (le vecchie posizioni spot vengono solo gestite fino alla chiusura) |
| Rischio per operazione | 7% | del capitale (budget + utili realizzati) investito in ogni trade, meme compresi |
| Posizioni max | 3 | |
| Slippage | 100 bps (1%) | |
| Impatto prezzo max | 1% | se lo swap muove troppo il prezzo, non entra |
| Durata max | 240 min | poi chiude comunque |
| Filtri meme | Liq ≥ 40k $, Vol 24h ≥ 3k $, età dalla creazione del pool ≥ 1 minuto, MCap ≥ 300k $, RugCheck ≤ 30, niente mint/freeze authority | |

Il bot entra **sempre con leva**: LONG e SHORT solo su **SOL, BTC, ETH** tramite Jupiter Perps, leva **5x o 10x** (minimo 5x, default 5x, limite rigido 10x). Nessun nuovo acquisto spot: vedi sotto.

### Uscite furbe (attive di default)
R = distanza dello stop-loss iniziale, calcolata sulla volatilità (ATR × 2,2, tra 1,5% e 10%; meme almeno 3%).
- **Presa parziale 1**: a +1R vende il 40% e sposta lo stop a pareggio (+0,3% per coprire le commissioni).
- **Presa parziale 2**: a +2R vende un altro 30% della quantità iniziale.
- **Trailing stop**: si attiva da +1R e segue il massimo a 1,5 × ATR di distanza, mai più largo dello stop iniziale; non scende mai.
- **Meme**: prese e trailing più vicini (× 0,75).
- **Uscita a tempo**: dopo 90 minuti sotto +0,5% e senza prese, chiude. Resta il limite massimo di 240 minuti.
- **Uscita rapida**: crollo oltre il 3% (o 2 × ATR) in 5 minuti sotto la EMA9, oppure sui meme vendite ≥ 75% delle transazioni dell'ultima ora (almeno 40), dopo i primi 3 minuti.
Le prese parziali entrano subito nel PnL realizzato; il resto resta "aperto". Nello storico il trade compare una sola volta, alla chiusura completa, con il rendimento complessivo (ed è da questo che impara il Mentore). Tutto è modificabile in Impostazioni → Uscite furbe.

### LONG + SHORT (Jupiter Perps, leva 5x / 10x)
- Il CAPO cerca anche segnali **SHORT** speculari a quelli LONG: EMA9 sotto EMA21, trend 5m ribassista, EMA21 in discesa, RSI 28–50, momentum 15m negativo, flusso non in acquisto; niente short se il mercato SOL sale più dell'1% in un'ora.
- Solo **SOL, BTC, ETH** si possono shortare (mercati Jupiter Perps, collaterale **USDC**). Mai un long e uno short sullo stesso asset insieme.
- **Margine** = rischio per operazione (7% del capitale, non cambia con la leva). **Leva** selezionabile 5x (default e minimo) o 10x → esposizione 35% o 70% del capitale. Valori sotto 5x vengono portati a 5x.
- **Long con leva** (acceso di default, migrazione v7): i LONG su SOL/BTC/ETH usano Jupiter Perps alla stessa leva. Se lo spegni il bot fa solo SHORT. Gli altri token non vengono più comprati; una posizione spot già aperta resta gestita (stop, prese, trailing) fino alla chiusura, senza vendite forzate.

| Leva | Liquidazione (movimento contrario) | Stop-loss massimo | Chiusura forzata |
|---|---|---|---|
| 5x | ~19,7% | 7,9% (in pratica lo stop ATR, max 6%) | 15,7% |
| 10x | ~9,7% | 3,9% | 7,7% |

Prese parziali e trailing sono multipli dello stop, quindi con più leva diventano automaticamente più stretti.
- **Commissioni** (lette on-chain il 25/11/2026): 0,06% all'apertura + 0,06% alla chiusura sull'esposizione, più il **prestito orario** (oggi ~0,0001%/h; in simulazione contiamo 0,001%/h, prudente). L'impatto prezzo per importi piccoli è trascurabile.
- **Liquidazione**: lo stop-loss è sempre al massimo il 40% della distanza dalla liquidazione (commissioni e prestito inclusi) e il bot chiude comunque se il prezzo arriva all'80% della distanza.
- Uscite furbe specchiate: prese parziali quando il prezzo scende, stop a pareggio, trailing che scende col minimo, uscita rapida su rimbalzo, time stop.
- **Stato in REALE**: le transazioni (apertura, chiusura parziale e totale) sono costruite dal bot e **simulate su mainnet** con esito positivo (`node scripts/perps-check.js`, nessun invio). L'esecuzione da parte dei keeper Jupiter con fondi veri non è ancora verificata, quindi **in REALE il bot non apre nessuna nuova operazione**: dashboard e Logger mostrano *«In REALE nessuna nuova operazione: la leva è ancora in attesa del test con 5-10 USDC.»* Le posizioni già aperte continuano a essere gestite. In SIMULAZIONE funzionano completamente.

### Il Mentore (9° bot)
Impara da ogni trade chiuso, simulato o reale (i reali pesano 1,5×), quali caratteristiche portano a vincere o perdere: tipo di token, età del pool, volume, liquidità, fascia oraria, volatilità, RSI, momentum, flusso acquisti/vendite, condizioni rispettate e andamento di SOL. Le statistiche sono smussate (prior bayesiano di 8 trade verso la media), salvate in `knowledge.json` e sopravvivono ai riavvii. Dopo 10 trade inizia a consigliare: riordina i candidati e la watchlist e blocca i setup con rendimento atteso negativo e un pattern chiaramente perdente (≥ 8 trade, < 40% vincenti). Non cambia mai il 7% per operazione, i filtri minimi, lo stop-loss o il kill switch.

### Strategie studiate dal Mentore (ricerca sul web)
Il MENTORE legge ogni 15 minuti dati gratuiti dal web (nessuna chiave, nessuna API a pagamento): candele di SOL/BTC/ETH (Binance, con riserva Bybit → OKX → Coinbase → Kraken se una borsa blocca il server), funding e open interest dei perpetui (Binance/Bybit/OKX) e l'indice Fear & Greed (alternative.me).
Ogni 2 ore studia 12 strategie molto usate — trend following EMA+ADX, breakout Donchian, mean reversion RSI+Bollinger, momentum MACD, VWAP, volatility squeeze, funding contrarian, regime Fear & Greed, Supertrend, pullback RSI(2), momentum ROC 24h, contrarian long/short OKX — con un backtest **walk-forward** su 10–60 giorni di candele 5m/15m/1h, alla tua leva, con commissioni Jupiter (0,06% + 0,06%), slittamento, prestito, margine 7% e stop sempre prima della liquidazione.
I parametri si scelgono sul passato e il voto si dà su settimane mai viste (fuori campione). Una strategia diventa **attiva** solo se resta positiva dopo lo "sconto" per pochi dati (≥ 8 operazioni, profit factor > 1,1, drawdown < 25%); in un regime di mercato dove perde viene ignorata. Le attive danno un voto al CAPO (possono far entrare o bloccare un ingresso), ma non cambiano mai margine, leva, stop o kill switch. Le vedi nella scheda "Strategie studiate dal Mentore"; lo stato pubblico delle fonti è su `/api/research/status`. I risultati passati non garantiscono quelli futuri.

### Diario del Mentore: post-mortem e correzioni automatiche
Ogni trade chiuso (simulato o reale) riceve un **post-mortem**: subito una prima diagnosi, poi la verifica finale 60 minuti dopo l'uscita guardando dove è andato il prezzo. Errori riconosciuti: entrata contro il trend, stop troppo stretto o troppo largo, uscita troppo presto, entrata senza slancio, commissioni più grandi del movimento, funding/posizionamento avverso, volatilità troppo alta, notizie ad alto rischio.
Dal post-mortem il Mentore fa **correzioni piccole e limitate** per cripto e direzione (es. "SOL LONG"): stop ×0,8–1,3, target ×1–1,4, selettività degli ingressi 0–3, pause di 2–6 ore per i setup perdenti (es. niente LONG in mercato in ribasso), soglia del rischio notizie. Ogni correzione è graduale (5% alla volta) e dopo 6 trade viene giudicata: se i risultati sono peggiorati, viene **annullata** (rollback). Non cambia mai la leva (minimo 5x), il margine del 7%, lo stop prima della liquidazione, il kill switch, le chiavi o il PIN.
Ogni ~90 secondi legge anche le **notizie** da 6 feed RSS gratuiti (CoinDesk, Cointelegraph, Decrypt, The Block, CryptoSlate, Bitcoin Magazine), con richieste condizionali (se il feed non è cambiato il server risponde 304 senza dati), timeout di 8 s per feed e pausa crescente per un feed che dà errori o limita le richieste; solo i titoli nuovi vengono valutati: un conteggio di parole nei titoli dà sentiment e rischio per SOL/BTC/ETH; con rischio alto non apre nuove operazioni su quella cripto. Ogni ora legge il contesto (CoinGecko: mercato totale; DefiLlama: TVL di Solana ed Ethereum; OKX: rapporto long/short). Tutto è nella scheda "Diario del Mentore". Il sentiment è un indizio semplice, non una previsione.

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
