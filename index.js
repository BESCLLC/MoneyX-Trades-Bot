/**
 * 💎 MoneyX Trade Relay v5 — Binance-Grade Edition
 * Full visual polish + on-chain + subgraph fusion
 * ------------------------------------------------
 * ENV:
 *   TG_BOT_TOKEN=xxx
 *   TG_CHAT_ID=xxx
 * ------------------------------------------------
 */

require("dotenv").config();
const { WebSocketProvider, Contract } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const { request, gql } = require("graphql-request");

// ===== CONFIG =====
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ALCHEMY_WSS = "wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ";
if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error("Missing .env vars");
  process.exit(1);
}

// ===== ADDRESSES =====
const ADDR = {
  Vault: "0xeB0E5E1a8500317A1B8fDd195097D5509Ef861de",
  PositionRouter: "0x065F9746b33F303c6481549BAc42A3885903fA44",
};

// ===== SUBGRAPHS =====
const ENDPOINTS = {
  stats:
    "https://api.goldsky.com/api/public/project_clhjdosm96z2v49wghcvog65t/subgraphs/project_clhjdosm96z2v4/moneyx-stats/gn",
  trades:
    "https://api.goldsky.com/api/public/project_clhjdosm96z2v49wghcvog65t/subgraphs/moneyx-trades/v1.0.1/gn",
};

// ===== TOKENS + ICONS =====
const TOKENS = {
  MONEY: { addr: "0x4fFe5ec4D8B9822e01c9E49678884bAEc17F60D9", emoji: "💵" },
  USDG: { addr: "0x4925C7e05347d90A3c7e07f8D8b3A52FaAC91bCb", emoji: "💰" },
  BNB: { addr: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", emoji: "⚡" },
  BTC: { addr: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", emoji: "🟠" },
  ETH: { addr: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", emoji: "💎" },
  SOL: { addr: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", emoji: "☀️" },
  XRP: { addr: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", emoji: "💠" },
  DOGE: { addr: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", emoji: "🐶" },
  USDC: { addr: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", emoji: "💵" },
};
function sym(addr) {
  const found = Object.entries(TOKENS).find(
    ([, t]) => t.addr.toLowerCase() === (addr || "").toLowerCase()
  );
  return found ? `${found[1].emoji} ${found[0]}` : addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ===== ABIs =====
const ABI_VAULT = [
  "function getPosition(address account,address collateralToken,address indexToken,bool isLong) view returns (uint256 size,uint256 collateral,uint256 averagePrice,uint256 entryFundingRate,uint256 reserveAmount,uint256 realisedPnl,bool realisedPnlIsPositive,uint256 lastIncreasedTime)",
  "function getPositionDelta(address account,address collateralToken,address indexToken,bool isLong) view returns (bool hasProfit,uint256 delta)",
  "event LiquidatePosition(bytes32 key,address account,address collateralToken,address indexToken,bool isLong,uint256 size,uint256 collateral,uint256 reserveAmount,int256 realisedPnl,uint256 markPrice)",
];
const ABI_ROUTER = [
  "event ExecuteIncreasePosition(address indexed account,address[] path,address indexToken,uint256 amountIn,uint256 minOut,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 blockGap,uint256 timeGap)",
  "event ExecuteDecreasePosition(address indexed account,address[] path,address indexToken,uint256 collateralDelta,uint256 sizeDelta,bool isLong,address receiver,uint256 acceptablePrice,uint256 minOut,uint256 executionFee,uint256 blockGap,uint256 timeGap)",
];

// ===== HELPERS =====
function numFmt(n) {
  const x = Number(n);
  if (x >= 1e9) return (x / 1e9).toFixed(2) + " B";
  if (x >= 1e6) return (x / 1e6).toFixed(2) + " M";
  if (x >= 1e3) return (x / 1e3).toFixed(2) + " K";
  return x.toFixed(2);
}
function usdFmt(x) {
  return "$" + numFmt(Number(x) / 1e30);
}
function lev(size, coll) {
  return coll && coll > 0 ? (Number(size) / Number(coll)).toFixed(1) + "×" : "—";
}
function walletTag(a) {
  return `<code>${a.slice(0, 6)}…${a.slice(-4)}</code>`;
}
function pnlEmoji(pct) {
  if (pct > 0.1) return "💚";
  if (pct > 0.01) return "🟢";
  if (pct < -0.1) return "💥";
  if (pct < -0.01) return "🔴";
  return "⚪";
}

// ===== SUBGRAPH DATA =====
const STATS_QUERY = gql`
  {
    tradingStats(first: 1, orderBy: timestamp, orderDirection: desc) {
      longOpenInterest
      shortOpenInterest
    }
    volumeStats(first: 1, orderBy: timestamp, orderDirection: desc) {
      swap
      margin
      liquidation
    }
  }
`;
async function getStats() {
  try {
    const res = await request(ENDPOINTS.stats, STATS_QUERY);
    const t = res.tradingStats?.[0];
    const v = res.volumeStats?.[0];
    return {
      oiLong: t ? `$${numFmt(Number(t.longOpenInterest) / 1e30)}` : "—",
      oiShort: t ? `$${numFmt(Number(t.shortOpenInterest) / 1e30)}` : "—",
      vol24h: v ? `$${numFmt((Number(v.swap) + Number(v.margin) + Number(v.liquidation)) / 1e30)}` : "—",
    };
  } catch {
    return { oiLong: "—", oiShort: "—", vol24h: "—" };
  }
}

// ===== TELEGRAM =====
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });
async function send(msg) {
  try {
    await bot.sendMessage(TG_CHAT_ID, msg, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) {
    console.error("TG send error:", e.message);
  }
}

// ===== CORE =====
async function getPosition(vault, account, coll, index, isLong) {
  try {
    const r = await vault.getPosition(account, coll, index, isLong);
    const d = await vault.getPositionDelta(account, coll, index, isLong);
    const [size, collateral, avg] = [r[0], r[1], r[2]];
    const [hasProfit, pnl] = [d[0], d[1]];
    if (size === 0n) return null;
    const pct = collateral > 0n ? (Number(pnl) / Number(collateral)) * 100 : 0;
    return {
      size: usdFmt(size),
      coll: usdFmt(collateral),
      lev: lev(size, collateral),
      entry: "$" + (Number(avg) / 1e30).toFixed(2),
      pnl: `${pnlEmoji(pct / 100)} ${hasProfit ? "+" : "-"}$${numFmt(Math.abs(Number(pnl) / 1e30))} (${pct.toFixed(2)}%)`,
    };
  } catch (e) {
    console.error("getPosition error:", e.message);
    return null;
  }
}

async function connect() {
  const provider = new WebSocketProvider(ALCHEMY_WSS);
  const vault = new Contract(ADDR.Vault, ABI_VAULT, provider);
  const router = new Contract(ADDR.PositionRouter, ABI_ROUTER, provider);

  console.log("🚀 MoneyX Relay v5 online");
  await send("✅ <b>MoneyX Trade Relay v5</b> is online — monitoring live positions.");

  const stats = await getStats();

  // 📈 INCREASE
  router.on(
    "ExecuteIncreasePosition",
    async (account, path, indexToken, amountIn, minOut, sizeDelta, isLong, acceptablePrice, execFee, blockGap, timeGap, ev) => {
      const collToken = path[path.length - 1];
      const p = await getPosition(vault, account, collToken, indexToken, isLong);
      const pair = sym(indexToken);
      const side = isLong ? "🟢 LONG" : "🔴 SHORT";
      const msg = `📈 <b>${pair} ${side}</b> | ${p?.lev || "—"}\n💰 Size ${p?.size || usdFmt(sizeDelta)} Coll ${p?.coll || "—"}\n🎯 Entry ${p?.entry || "—"} Fee $${(Number(execFee) / 1e18).toFixed(2)}\n📊 PnL ${p?.pnl || "—"}\n📈 OI L ${stats.oiLong} OI S ${stats.oiShort}\n💹 24 h Vol ${stats.vol24h}\n👤 ${walletTag(account)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`;
      await send(msg);
    }
  );

  // 📉 DECREASE
  router.on(
    "ExecuteDecreasePosition",
    async (account, path, indexToken, collDelta, sizeDelta, isLong, receiver, acceptablePrice, minOut, execFee, blockGap, timeGap, ev) => {
      const collToken = path[path.length - 1];
      const p = await getPosition(vault, account, collToken, indexToken, isLong);
      const pair = sym(indexToken);
      const side = isLong ? "🟢 LONG" : "🔴 SHORT";
      const msg = `📉 <b>${pair} ${side}</b> | ${p?.lev || "—"}\n💰 Size Δ ${usdFmt(sizeDelta)} Coll Out ${usdFmt(collDelta)}\n🎯 Entry ${p?.entry || "—"} Fee $${(Number(execFee) / 1e18).toFixed(2)}\n📊 PnL ${p?.pnl || "—"}\n📈 OI L ${stats.oiLong} OI S ${stats.oiShort}\n💹 24 h Vol ${stats.vol24h}\n👤 ${walletTag(account)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`;
      await send(msg);
    }
  );

  // 💥 LIQUIDATION
  vault.on(
    "LiquidatePosition",
    async (key, account, collToken, indexToken, isLong, size, collateral, reserve, realised, mark, ev) => {
      const pair = sym(indexToken);
      const msg = `💥 <b>LIQUIDATION</b>\n${pair} | ${isLong ? "LONG" : "SHORT"}\n💰 Size ${usdFmt(size)} Coll ${usdFmt(collateral)}\n💸 Mark $${(Number(mark) / 1e30).toFixed(2)}\n📈 OI L ${(await getStats()).oiLong} OI S ${(await getStats()).oiShort}\n👤 ${walletTag(account)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`;
      await send(msg);
    }
  );

  // Reconnect logic
  if (provider._ws) {
    provider._ws.on("close", () => {
      console.error("WS closed, reconnecting in 5 s…");
      setTimeout(connect, 5000);
    });
    provider._ws.on("error", (err) => {
      console.error("WS error:", err.message);
    });
  }
}

connect();
