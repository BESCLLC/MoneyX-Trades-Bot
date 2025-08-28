// MoneyX Trades TG Bot — Direct On-Chain Events 🚀
// Uses Alchemy BNB WS endpoint, no The Graph.

require('dotenv').config();
const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  RPC_WS_URL = "wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ",
  EXPLORER_TX_BASE = "https://bscscan.com/tx/",
  CMC_API_KEY,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !RPC_WS_URL || !CMC_API_KEY) {
  console.error("❌ Missing env vars: TG_BOT_TOKEN, TG_CHAT_ID, RPC_WS_URL, CMC_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });
const provider = new ethers.WebSocketProvider(RPC_WS_URL);

// === Contracts ===
const PositionRouter = new ethers.Contract(
  "0x065F9746b33F303c6481549BAc42A3885903fA44", // PositionRouter
  [
    "event CreateIncreasePosition(address account,address collateralToken,address indexToken,uint256 amountIn,uint256 minOut,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 indexTokenPrice,uint256 blockNumber,uint256 blockTime,bytes32 key,uint256 orderIndex)",
    "event CreateDecreasePosition(address account,address collateralToken,address indexToken,uint256 collateralDelta,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 indexTokenPrice,uint256 blockNumber,uint256 blockTime,bytes32 key,uint256 orderIndex)"
  ],
  provider
);

const Vault = new ethers.Contract(
  "0xeB0E5E1a8500317A1B8fDd195097D5509Ef861de", // Vault
  [
    "event LiquidatePosition(address account,address collateralToken,address indexToken,bool isLong,uint256 size,uint256 collateral,uint256 reserveAmount,uint256 realisedPnl,uint256 markPrice)"
  ],
  provider
);

// === Token symbols ===
const SYMBOLS = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "BNB",
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": "ETH",
  "0xba2ae424d960c26247dd6c32edc70b295c744c43": "DOGE",
  "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe": "XRP",
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": "BTC",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
};
const sym = (addr) => SYMBOLS[addr?.toLowerCase()] || addr?.slice(0, 6) + "…" + addr?.slice(-4);

// === Price cache from CMC ===
const PRICE_CACHE = {};
async function getPrice(symbol) {
  if (PRICE_CACHE[symbol] && Date.now() - PRICE_CACHE[symbol].ts < 60000) {
    return PRICE_CACHE[symbol].usd;
  }
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest", {
    params: { symbol, convert: "USD" },
    headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
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

// === Format helpers ===
const short = (addr) => (addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "");
const fmtUsd = (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPrice = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const calcLev = (size, coll) => (!size || !coll ? "—" : (size / coll).toFixed(1) + "x");

// === Event Handlers ===
PositionRouter.on("CreateIncreasePosition", async (
  account, collateralToken, indexToken, amountIn, , sizeDelta, isLong,
  acceptablePrice, , , , blockTime, key
) => {
  const size = Number(sizeDelta) / 1e30;
  const coll = Number(amountIn) / 1e18;
  const price = await getTokenPriceUsd(indexToken);
  const collUsd = price ? coll * price : coll;

  const msg = `📈 Increase ${isLong ? "🟢 LONG" : "🔴 SHORT"}
• Pair: ${sym(indexToken)}-USD
• Wallet: ${short(account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(collUsd)} (${sym(collateralToken)})
• Leverage: ${calcLev(size, collUsd)}
• Price: ${fmtPrice(Number(acceptablePrice) / 1e30)}
• Time: ${new Date(Number(blockTime) * 1000).toLocaleTimeString()}`;

  bot.sendMessage(TG_CHAT_ID, msg);
});

PositionRouter.on("CreateDecreasePosition", async (
  account, collateralToken, indexToken, collateralDelta, sizeDelta, isLong,
  acceptablePrice, , , , blockTime, key
) => {
  const size = Number(sizeDelta) / 1e30;
  const coll = Number(collateralDelta) / 1e18;
  const price = await getTokenPriceUsd(indexToken);
  const collUsd = price ? coll * price : coll;

  const msg = `📉 Decrease ${isLong ? "🟢 LONG" : "🔴 SHORT"}
• Pair: ${sym(indexToken)}-USD
• Wallet: ${short(account)}
• Size: ${fmtUsd(size)}
• Collateral Out: ${fmtUsd(collUsd)} (${sym(collateralToken)})
• Price: ${fmtPrice(Number(acceptablePrice) / 1e30)}
• Time: ${new Date(Number(blockTime) * 1000).toLocaleTimeString()}`;

  bot.sendMessage(TG_CHAT_ID, msg);
});

Vault.on("LiquidatePosition", async (
  account, collateralToken, indexToken, isLong,
  size, collateral, , realisedPnl, markPrice
) => {
  const sizeUsd = Number(size) / 1e30;
  const coll = Number(collateral) / 1e18;
  const loss = Number(realisedPnl) / 1e30;

  const msg = `💥 LIQUIDATION
• Wallet REKT: ${short(account)}
• Pair: ${sym(indexToken)}-USD
• Size: ${fmtUsd(sizeUsd)} 
• Collateral: ${fmtUsd(coll)} (${sym(collateralToken)})
• Loss: ${fmtUsd(loss)}
• Price: ${fmtPrice(Number(markPrice) / 1e30)}`;

  bot.sendMessage(TG_CHAT_ID, msg);
});

console.log("🚀 MoneyX TG bot live on-chain with Alchemy — no more rate limits!");
