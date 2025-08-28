// index.js — MoneyX TG Bot (production ready)

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { WebSocketProvider, Contract, formatUnits, parseUnits } = require("ethers");
const abiVault = require("./abi/Vault.json");
const abiRouter = require("./abi/PositionRouter.json");

// 🔗 Alchemy BNB Chain WebSocket
const provider = new WebSocketProvider("wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ");

// 📲 Telegram
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID;

// 📝 Contracts (your deployed addresses)
const addresses = {
  Vault: "0xeB0E5E1a8500317A1B8fDd195097D5509Ef861de",
  PositionRouter: "0x065F9746b33F303c6481549BAc42A3885903fA44",
  VaultPriceFeed: "0x31086dBa211D1e66F51701535AD4C0e0f98A3482",
};

// 📝 Tokens (add more as needed)
const TOKENS = {
  MONEY:  { addr: "0x4fFe5ec4D8B9822e01c9E49678884bAEc17F60D9", symbol: "MONEY", decimals: 18 },
  USDG:   { addr: "0x4925C7e05347d90A3c7e07f8D8b3A52FaAC91bCb", symbol: "USDG", decimals: 18 },
  BTC:    { addr: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTC", decimals: 18 },
  ETH:    { addr: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18 },
  BNB:    { addr: "0xB8c77482e45F1F44De1745F52C74426C631bdd52", symbol: "BNB", decimals: 18 },
  DOGE:   { addr: "0xba2ae424d960c26247dd6c32edc70b295c744c43", symbol: "DOGE", decimals: 8 },
  XRP:    { addr: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", symbol: "XRP", decimals: 18 },
  USDC:   { addr: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", symbol: "USDC", decimals: 18 },
};

// ⚙️ Contracts
const vault = new Contract(addresses.Vault, abiVault, provider);
const router = new Contract(addresses.PositionRouter, abiRouter, provider);

// 🔍 Helper: find token symbol from address
function tokenSymbol(addr) {
  for (const [k, v] of Object.entries(TOKENS)) {
    if (v.addr.toLowerCase() === addr.toLowerCase()) return v.symbol;
  }
  return "UNKNOWN";
}

// 🔍 Format USD
function fmtUsd(val) {
  return `$${Number(val / 1e30).toFixed(2)}`;
}

// 🔍 Send to Telegram
async function sendMsg(text) {
  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

// 🔍 Parse Position & PnL
async function parsePosition(account, collateralToken, indexToken, isLong) {
  const [size, collateral, avgPrice, entryFundingRate, reserveAmt, realisedPnl, hasProfit, lastIncreased] =
    await vault.getPosition(account, collateralToken, indexToken, isLong);

  if (size == 0n) return null;

  const [pHasProfit, delta] = await vault.getPositionDelta(account, collateralToken, indexToken, isLong);

  const leverage = Number(size) / Number(collateral || 1n);
  const pnlUsd = Number(delta) / 1e30;
  const pnlColor = pHasProfit ? "🟢" : "🔴";
  const side = isLong ? "LONG" : "SHORT";

  return {
    side,
    size: fmtUsd(size),
    collateral: fmtUsd(collateral),
    avgPrice: Number(avgPrice) / 1e30,
    leverage: leverage.toFixed(1) + "x",
    pnl: `${pnlColor} ${pHasProfit ? "+" : "-"}$${Math.abs(pnlUsd).toFixed(2)}`
  };
}

// 🚀 Listen for events
router.on("ExecuteIncreasePosition", async (account, path, indexToken, amountIn, minOut, sizeDelta, isLong, acceptablePrice, execFee, blockGap, timeGap, event) => {
  const pos = await parsePosition(account, path[path.length-1], indexToken, isLong);
  if (!pos) return;
  await sendMsg(
    `📈 <b>Increase ${pos.side}</b>\n` +
    `• Trader: <code>${account}</code>\n` +
    `• Pair: ${tokenSymbol(indexToken)}\n` +
    `• Size: ${pos.size}\n` +
    `• Collateral: ${pos.collateral}\n` +
    `• Leverage: ${pos.leverage}\n` +
    `• Entry Price: $${pos.avgPrice}\n` +
    `• PnL: ${pos.pnl}\n` +
    `🔗 <a href="https://bscscan.com/tx/${event.transactionHash}">tx</a>`
  );
});

router.on("ExecuteDecreasePosition", async (account, path, indexToken, collDelta, sizeDelta, isLong, receiver, acceptablePrice, minOut, execFee, blockGap, timeGap, event) => {
  const pos = await parsePosition(account, path[path.length-1], indexToken, isLong);
  if (!pos) return;
  await sendMsg(
    `📉 <b>Decrease ${pos.side}</b>\n` +
    `• Trader: <code>${account}</code>\n` +
    `• Pair: ${tokenSymbol(indexToken)}\n` +
    `• Size: ${pos.size}\n` +
    `• Collateral: ${pos.collateral}\n` +
    `• Leverage: ${pos.leverage}\n` +
    `• Entry Price: $${pos.avgPrice}\n` +
    `• PnL: ${pos.pnl}\n` +
    `🔗 <a href="https://bscscan.com/tx/${event.transactionHash}">tx</a>`
  );
});

vault.on("LiquidatePosition", async (key, account, collateralToken, indexToken, isLong, size, collateral, reserveAmt, realisedPnl, markPrice, event) => {
  await sendMsg(
    `💀 <b>Liquidation</b>\n` +
    `• Trader: <code>${account}</code>\n` +
    `• Pair: ${tokenSymbol(indexToken)}\n` +
    `• Side: ${isLong ? "LONG" : "SHORT"}\n` +
    `• Size: ${fmtUsd(size)}\n` +
    `• Collateral: ${fmtUsd(collateral)}\n` +
    `• Mark Price: $${Number(markPrice) / 1e30}\n` +
    `🔗 <a href="https://bscscan.com/tx/${event.transactionHash}">tx</a>`
  );
});

console.log("🚀 MoneyX TG bot fully live (Vault + Router events + exact leverage/PnL)");
