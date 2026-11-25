'use strict';
// Cripto principali su Solana (no meme). Mint verificati sulla lista token di Jupiter (tag strict/verified) il 25/11/2026.
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CORE = [
  { symbol: 'SOL', mint: SOL, decimals: 9, core: true },
  { symbol: 'cbBTC', mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', decimals: 8, core: true }, // Bitcoin (Coinbase)
  { symbol: 'ETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8, core: true }, // Ether (Wormhole Portal)
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, core: true },
  { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6, core: true },
  { symbol: 'KMNO', mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', decimals: 6, core: true },
  { symbol: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9, core: true },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6, core: true },
  { symbol: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', decimals: 6, core: true },
  { symbol: 'RENDER', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', decimals: 8, core: true },
  { symbol: 'HNT', mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', decimals: 8, core: true },
  { symbol: 'W', mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', decimals: 6, core: true },
];
// meme rimossi dalla lista (le posizioni già aperte vengono comunque gestite fino alla chiusura)
const OLD_MEMES = ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'];
const BASES = {
  USDC: { symbol: 'USDC', mint: USDC, decimals: 6 },
  SOL: { symbol: 'SOL', mint: SOL, decimals: 9 },
};
module.exports = { SOL, USDC, CORE, BASES, OLD_MEMES };
