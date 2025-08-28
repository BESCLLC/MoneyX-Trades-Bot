// MoneyX Trades TG Bot — Direct On-Chain Events 🚀
// No The Graph, no 429s. ESM-compatible for Node 18+ / 20+ / 22+

import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  RPC_WS_URL = 'wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ',
  EXPLORER_TX_BASE = 'https://bscscan.com/tx/',
  CMC_API_KEY,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !RPC_WS_URL || !CMC_API_KEY) {
  console.error('❌ Missing env vars: TG_BOT_TOKEN, TG_CHAT_ID, RPC_WS_URL, CMC_API_KEY');
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// === Token symbols (BNB, ETH, DOGE, XRP, BTC, USDC on BSC) ===
const SYMBOLS = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0xba2ae424d960c26247dd6c32edc70b295c744c43': 'DOGE',
  '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe': 'XRP',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'BTC',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC'
};
const sym = (addr) => SYMBOLS[addr?.toLowerCase()] || (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—');

// === Helpers ===
const short = (addr) => (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '');
const fmtUsd = (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPrice = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const calcLev = (size, coll) => (!size || !coll ? '—' : (size / coll).toFixed(1) + 'x');

const scale1e30 = (v) => Number(v) / 1e30;
const scale1e18 = (v) => Number(v) / 1e18;

// === Price cache from CMC ===
const PRICE_CACHE = {};
async function getPrice(symbol) {
  if (PRICE_CACHE[symbol] && Date.now() - PRICE_CACHE[symbol].ts < 60_000) {
    return PRICE_CACHE[symbol].usd;
  }
  const res = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
    params: { symbol, convert: 'USD' },
    headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY }
  });
  const usd = res.data.data[symbol].quote.USD.price;
  PRICE_CACHE[symbol] = { usd, ts: Date.now() };
  return usd;
}
async function getTokenPriceUsd(addr) {
  const s = SYMBOLS[addr?.toLowerCase()];
  if (!s) return null;
  return getPrice(s);
}

// === Addresses you provided ===
const ADDR = {
  PositionRouter: '0x065F9746b33F303c6481549BAc42A3885903fA44',
  Vault:          '0xeB0E5E1a8500317A1B8fDd195097D5509Ef861de'
};

// === ABIs (minimal events) ===
const PositionRouterABI = [
  'event CreateIncreasePosition(address account,address collateralToken,address indexToken,uint256 amountIn,uint256 minOut,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 indexTokenPrice,uint256 blockNumber,uint256 blockTime,bytes32 key,uint256 orderIndex)',
  'event CreateDecreasePosition(address account,address collateralToken,address indexToken,uint256 collateralDelta,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 indexTokenPrice,uint256 blockNumber,uint256 blockTime,bytes32 key,uint256 orderIndex)'
];

const VaultABI = [
  'event LiquidatePosition(address account,address collateralToken,address indexToken,bool isLong,uint256 size,uint256 collateral,uint256 reserveAmount,uint256 realisedPnl,uint256 markPrice)'
];

// === WS provider with auto-reconnect ===
let provider;
let pr; // PositionRouter
let vault;

async function initProvider() {
  if (provider) {
    try { await provider.destroy(); } catch {}
  }

  provider = new ethers.WebSocketProvider(RPC_WS_URL);

  provider._websocket?.on?.('close', (code) => {
    console.warn('⚠️ WS closed:', code, '— reconnecting in 3s…');
    setTimeout(initProvider, 3000);
  });
  provider._websocket?.on?.('error', (err) => {
    console.warn('⚠️ WS error:', err?.message, '— reconnecting in 5s…');
    setTimeout(initProvider, 5000);
  });

  pr = new ethers.Contract(ADDR.PositionRouter, PositionRouterABI, provider);
  vault = new ethers.Contract(ADDR.Vault, VaultABI, provider);

  subscribeEvents();

  console.log('🚀 MoneyX TG bot live on-chain (Alchemy WS) — no rate limits!');
}

// === Event subscriptions ===
function subscribeEvents() {
  pr.removeAllListeners();
  vault.removeAllListeners();

  // Increase
  pr.on('CreateIncreasePosition', async (
    account,
    collateralToken,
    indexToken,
    amountIn,
    _minOut,
    sizeDelta,
    isLong,
    acceptablePrice,
    _executionFee,
    _indexTokenPrice,
    _blockNumber,
    blockTime,
    key
  ) => {
    try {
      const size = scale1e30(sizeDelta);
      const coll = scale1e18(amountIn);
      const px = await getTokenPriceUsd(indexToken);
      const collUsd = px ? coll * px : coll;

      const msg = `${size > 10000 ? ' 🐳' : ''} 📈 Increase ${isLong ? '🟢 LONG' : '🔴 SHORT'}
• Pair: ${sym(indexToken)}-USD
• Wallet: ${short(account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(collUsd)} (${sym(collateralToken)})
• Leverage: ${calcLev(size, collUsd)}
• Price: ${fmtPrice(scale1e30(acceptablePrice))}
• Time: ${new Date(Number(blockTime) * 1000).toLocaleTimeString()}`;

      await bot.sendMessage(TG_CHAT_ID, msg);
    } catch (e) {
      console.error('Increase handler error:', e.message);
    }
  });

  // Decrease
  pr.on('CreateDecreasePosition', async (
    account,
    collateralToken,
    indexToken,
    collateralDelta,
    sizeDelta,
    isLong,
    acceptablePrice,
    _executionFee,
    _indexTokenPrice,
    _blockNumber,
    blockTime,
    key
  ) => {
    try {
      const size = scale1e30(sizeDelta);
      const collOut = scale1e18(collateralDelta);
      const mark = await getTokenPriceUsd(indexToken);
      if (!mark) return;

      const entry = scale1e30(acceptablePrice); // proxy
      const delta = isLong ? (mark - entry) : (entry - mark);
      const pnlUsd = (delta / entry) * size;
      const pnlPct = (pnlUsd / size) * 100;

      const header = pnlUsd >= 0 ? '💰 Close 🟢 PROFIT' : '🔻 Close 🔴 LOSS';
      const msg = `${header}
• ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)
• Pair: ${sym(indexToken)}-USD
• Wallet: ${short(account)}
• Collateral Out: ${fmtUsd(collOut)} (${sym(collateralToken)})
• Time: ${new Date(Number(blockTime) * 1000).toLocaleTimeString()}`;

      await bot.sendMessage(TG_CHAT_ID, msg);
    } catch (e) {
      console.error('Decrease handler error:', e.message);
    }
  });

  // Liquidation
  vault.on('LiquidatePosition', async (
    account,
    collateralToken,
    indexToken,
    isLong,
    size,
    collateral,
    _reserveAmount,
    realisedPnl,
    markPrice
  ) => {
    try {
      const sizeUsd = scale1e30(size);
      const coll = scale1e18(collateral);
      const loss = scale1e30(realisedPnl);

      const msg = `💥 LIQUIDATION
• Wallet REKT: ${short(account)}
• Pair: ${sym(indexToken)}-USD
• Size: ${fmtUsd(sizeUsd)}
• Collateral: ${fmtUsd(coll)} (${sym(collateralToken)})
• Loss: ${fmtUsd(loss)}
• Price: ${fmtPrice(scale1e30(markPrice))}`;

      await bot.sendMessage(TG_CHAT_ID, msg);
    } catch (e) {
      console.error('Liquidation handler error:', e.message);
    }
  });
}

// Kickoff
initProvider().catch((e) => {
  console.error('Init error:', e.message);
  process.exit(1);
});
