'use strict';
// Jupiter Perpetuals (programma on-chain PERPHjGB…): costruzione delle richieste di posizione SHORT.
// Flusso Jupiter: l'utente crea una "position request" (PDA) con il collaterale; un keeper di Jupiter la esegue
// al prezzo dell'oracolo. Qui: indirizzi PDA, codifica istruzioni (Anchor/Borsh, senza dipendenze extra),
// decodifica della posizione e modello di commissioni/liquidazione usato anche in SIMULAZIONE.
//
// STATO: le istruzioni open/increase, decrease parziale e close totale sono state verificate con
// simulateTransaction su mainnet (25/11/2026, nessun invio). L'esecuzione da parte del keeper con fondi veri
// NON è ancora verificata, quindi gli short in modalità REALE restano disattivati (REAL_SHORTS_ENABLED = false).
const crypto = require('crypto');
const { PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js');

const REAL_SHORTS_ENABLED = false;
const REAL_SHORTS_BLOCK_MSG = 'Short in REALE non ancora attivi: le transazioni Jupiter Perps sono costruite e simulate su mainnet, ma l\'esecuzione del keeper con fondi veri non è ancora stata verificata. In REALE il bot fa solo LONG; gli short funzionano in SIMULAZIONE.';

const PROGRAM_ID = new PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');
const EVENT_AUTHORITY = new PublicKey('37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN');
const POOL = new PublicKey('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const CUSTODY = {
  SOL: new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
  ETH: new PublicKey('AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn'),
  BTC: new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
  USDC: new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
};
// mercati shortabili: mint dei nostri token → mercato Jupiter Perps
const SHORT_MARKETS = {
  So11111111111111111111111111111111111111112: 'SOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'BTC',
};
// parametri letti on-chain il 25/11/2026: apertura/chiusura 6 bps, leva max protocollo 500x,
// tasso di prestito USDC (curva a salto) ~0,0001%/h all'utilizzo attuale: usiamo 0,001%/h, prudente.
const FEES = { openBps: 6, closeBps: 6, borrowHourlyPct: 0.001, protocolMaxLev: 500 };

const disc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const optU64 = (v) => (v == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(v)]));
const optBool = (v) => (v == null ? Buffer.from([0]) : Buffer.from([1, v ? 1 : 0]));
const SIDE = { long: 1, short: 2 };

const ata = (mint, owner) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const perpetualsPda = () => PublicKey.findProgramAddressSync([Buffer.from('perpetuals')], PROGRAM_ID)[0];
function positionPda(owner, custody, side = 'short', collateralCustody = CUSTODY.USDC) {
  return PublicKey.findProgramAddressSync([Buffer.from('position'), owner.toBuffer(), POOL.toBuffer(), custody.toBuffer(), collateralCustody.toBuffer(), Buffer.from([SIDE[side]])], PROGRAM_ID)[0];
}
function positionRequestPda(position, counter, change) {
  return PublicKey.findProgramAddressSync([Buffer.from('position_request'), position.toBuffer(), u64(counter), Buffer.from([change === 'increase' ? 1 : 2])], PROGRAM_ID)[0];
}
const meta = (pubkey, isWritable, isSigner = false) => ({ pubkey, isWritable, isSigner });

// Apri/aumenta uno short: collaterale in USDC (6 decimali), dimensione in USD (6 decimali).
// minPrice6: per uno short il prezzo minimo accettabile (protezione slittamento).
function increaseShortIx({ owner, market, sizeUsd6, collateral6, minPrice6, counter }) {
  const custody = CUSTODY[market]; if (!custody) throw new Error('Mercato short non supportato: ' + market);
  const position = positionPda(owner, custody, 'short');
  const positionRequest = positionRequestPda(position, counter, 'increase');
  const data = Buffer.concat([disc('create_increase_position_market_request'), u64(sizeUsd6), u64(collateral6), Buffer.from([SIDE.short]), u64(minPrice6), optU64(null), u64(counter)]);
  const keys = [meta(owner, true, true), meta(ata(USDC_MINT, owner), true), meta(perpetualsPda(), false), meta(POOL, false), meta(position, true), meta(positionRequest, true), meta(ata(USDC_MINT, positionRequest), true),
    meta(custody, false), meta(CUSTODY.USDC, false), meta(USDC_MINT, false), meta(PROGRAM_ID, false) /* referral assente */, meta(TOKEN_PROGRAM, false), meta(ATA_PROGRAM, false), meta(SystemProgram.programId, false), meta(EVENT_AUTHORITY, false), meta(PROGRAM_ID, false)];
  return { ix: new TransactionInstruction({ programId: PROGRAM_ID, keys, data }), position, positionRequest };
}
// Riduci o chiudi uno short; il ricavato arriva in USDC. maxPrice6: prezzo massimo accettabile per ricomprare.
function decreaseShortIx({ owner, market, sizeUsd6 = 0, entire = false, maxPrice6, counter }) {
  const custody = CUSTODY[market]; if (!custody) throw new Error('Mercato short non supportato: ' + market);
  const position = positionPda(owner, custody, 'short');
  const positionRequest = positionRequestPda(position, counter, 'decrease');
  const data = Buffer.concat([disc('create_decrease_position_market_request'), u64(0), u64(entire ? 0 : sizeUsd6), u64(maxPrice6), optU64(null), optBool(entire), u64(counter)]);
  const keys = [meta(owner, true, true), meta(ata(USDC_MINT, owner), true), meta(perpetualsPda(), false), meta(POOL, false), meta(position, false), meta(positionRequest, true), meta(ata(USDC_MINT, positionRequest), true),
    meta(custody, false), meta(CUSTODY.USDC, false), meta(USDC_MINT, false), meta(PROGRAM_ID, false), meta(TOKEN_PROGRAM, false), meta(ATA_PROGRAM, false), meta(SystemProgram.programId, false), meta(EVENT_AUTHORITY, false), meta(PROGRAM_ID, false)];
  return { ix: new TransactionInstruction({ programId: PROGRAM_ID, keys, data }), position, positionRequest };
}
function createAtaIdempotentIx(payer, owner, mint) {
  return new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [meta(payer, true, true), meta(ata(mint, owner), true), meta(owner, false), meta(mint, false), meta(SystemProgram.programId, false), meta(TOKEN_PROGRAM, false)] });
}
// Decodifica di un account Position (layout dall'IDL ufficiale)
function decodePosition(data) {
  const d = Buffer.from(data); const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  const sides = ['none', 'long', 'short'];
  return { owner: pk(8), pool: pk(40), custody: pk(72), collateralCustody: pk(104), openTime: Number(d.readBigInt64LE(136)), updateTime: Number(d.readBigInt64LE(144)), side: sides[d[152]],
    price: Number(d.readBigUInt64LE(153)) / 1e6, sizeUsd: Number(d.readBigUInt64LE(161)) / 1e6, collateralUsd: Number(d.readBigUInt64LE(169)) / 1e6, realisedPnlUsd: Number(d.readBigInt64LE(177)) / 1e6 };
}

// ---------- modello economico (stesso in SIMULAZIONE e per stimare il REALE)
// margine in USD, leva → dimensione; commissione d'apertura tolta dal collaterale (come su Jupiter)
function openShortModel({ marginUsd, lev, priceUsd, fees = FEES }) {
  const sizeUsd = marginUsd * lev; const openFeeUsd = (sizeUsd * fees.openBps) / 1e4;
  return { sizeUsd, collateralUsd: marginUsd - openFeeUsd, openFeeUsd, entry: priceUsd };
}
// valore netto se chiusa ora (USD): collaterale + PnL − prestito − commissione di chiusura (minimo 0)
function shortState(p, priceUsd, now, fees = FEES) {
  const hours = Math.max(0, (now - (p.lastAccrual || p.openedAt)) / 3.6e6);
  const borrowUsd = (p.borrowUsd || 0) + p.sizeUsd * (fees.borrowHourlyPct / 100) * hours;
  const grossPnl = p.sizeUsd * ((p.entryPrice - priceUsd) / p.entryPrice);
  const closeFeeUsd = (p.sizeUsd * fees.closeBps) / 1e4;
  const valueUsd = Math.max(0, p.collateralUsd + grossPnl - borrowUsd - closeFeeUsd);
  return { grossPnl, borrowUsd, closeFeeUsd, valueUsd, liqPrice: liquidationPrice(p, borrowUsd, fees) };
}
// liquidazione: perdita ammessa = collaterale − (dimensione / leva max protocollo) − commissioni
function liquidationPrice(p, borrowUsd = p.borrowUsd || 0, fees = FEES) {
  const closeFee = (p.sizeUsd * fees.closeBps) / 1e4;
  const room = p.collateralUsd - p.sizeUsd / fees.protocolMaxLev - closeFee - borrowUsd;
  return p.entryPrice * (1 + room / p.sizeUsd);
}

module.exports = { REAL_SHORTS_ENABLED, REAL_SHORTS_BLOCK_MSG, PROGRAM_ID, POOL, CUSTODY, USDC_MINT, SHORT_MARKETS, FEES, disc, positionPda, positionRequestPda, increaseShortIx, decreaseShortIx, createAtaIdempotentIx, decodePosition, openShortModel, shortState, liquidationPrice, ata };
