// MoneyX Trades Bot — production ready, ethers v6
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { WebSocketProvider, Contract } = require('ethers');

// ===== ENV =====
const ALCHEMY_WSS   = 'wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ';
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error('Missing TG_BOT_TOKEN or TG_CHAT_ID in .env');
  process.exit(1);
}

// ===== ADDRESSES =====
const ADDR = {
  Vault:          '0xeB0E5E1a8500317A1B8fDd195097D5509Ef861de',
  PositionRouter: '0x065F9746b33F303c6481549BAc42A3885903fA44',
};

// ===== TOKENS =====
const TOKENS = {
  '0x4ffe5ec4d8b9822e01c9e49678884baec17f60d9': 'MONEY',
  '0x4925c7e05347d90a3c7e07f8d8b3a52faac91bcb': 'USDG',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'BTC',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe': 'XRP',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0xba2ae424d960c26247dd6c32edc70b295c744c43': 'DOGE',
};
const sym = (addr) => TOKENS[(addr||'').toLowerCase()] || addr?.slice(0,6)+'…'+addr?.slice(-4);

// ===== ABIs =====
const ABI_VAULT = [
  "function getPosition(address account,address collateralToken,address indexToken,bool isLong) view returns (uint256 size,uint256 collateral,uint256 averagePrice,uint256 entryFundingRate,uint256 reserveAmount,uint256 realisedPnl,bool realisedPnlIsPositive,uint256 lastIncreasedTime)",
  "function getPositionDelta(address account,address collateralToken,address indexToken,bool isLong) view returns (bool hasProfit,uint256 delta)",
  "event LiquidatePosition(bytes32 key,address account,address collateralToken,address indexToken,bool isLong,uint256 size,uint256 collateral,uint256 reserveAmount,int256 realisedPnl,uint256 markPrice)"
];
const ABI_ROUTER = [
  "event ExecuteIncreasePosition(address indexed account,address[] path,address indexToken,uint256 amountIn,uint256 minOut,uint256 sizeDelta,bool isLong,uint256 acceptablePrice,uint256 executionFee,uint256 blockGap,uint256 timeGap)",
  "event ExecuteDecreasePosition(address indexed account,address[] path,address indexToken,uint256 collateralDelta,uint256 sizeDelta,bool isLong,address receiver,uint256 acceptablePrice,uint256 minOut,uint256 executionFee,uint256 blockGap,uint256 timeGap)"
];

// ===== TG =====
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });
async function send(msg) {
  try {
    await bot.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) { console.error("TG send err:", e.message); }
}

// ===== Helpers =====
function usd30ToStr(x) { return `$${(Number(x)/1e30).toLocaleString(undefined,{maximumFractionDigits:2})}`; }
function from1e30(x)  { return Number(x)/1e30; }
function levStr(size, coll) { return (!coll||coll<=0)?'—':(Number(size)/Number(coll)).toFixed(1)+'x'; }

async function pullPosition(vault, account, collToken, indexToken, isLong) {
  try {
    const res   = await vault.getPosition(account, collToken, indexToken, isLong);
    const delta = await vault.getPositionDelta(account, collToken, indexToken, isLong);
    const [size, collateral, avgPrice] = [res[0], res[1], res[2]];
    const [hasProfit, pnl]             = [delta[0], delta[1]];
    if (size === 0n) return null;
    return {
      sizeStr: usd30ToStr(size),
      collStr: usd30ToStr(collateral),
      lev: levStr(size, collateral),
      entry: from1e30(avgPrice),
      pnlSign: hasProfit ? '🟢 +' : '🔴 -',
      pnlStr: `$${Math.abs(from1e30(pnl)).toLocaleString(undefined,{maximumFractionDigits:2})}`
    };
  } catch (e) { console.error("pullPosition err:", e.message); return null; }
}

// ===== Connect =====
async function connect() {
  const provider = new WebSocketProvider(ALCHEMY_WSS);
  const vault    = new Contract(ADDR.Vault, ABI_VAULT, provider);
  const router   = new Contract(ADDR.PositionRouter, ABI_ROUTER, provider);

  console.log("🚀 MoneyX TG bot live — listening (Router + Vault)");
  send("✅ MoneyX bot online — listening for trades…").catch(()=>{});

  // Increases
  router.on("ExecuteIncreasePosition", async (account, path, indexToken, amountIn, minOut, sizeDelta, isLong, acceptablePrice, execFee, blockGap, timeGap, ev) => {
    const collToken = path[path.length-1];
    const p = await pullPosition(vault, account, collToken, indexToken, isLong);
    const side = isLong?"🟢 LONG":"🔴 SHORT", pair=sym(indexToken);
    send(
      `📈 <b>Increase ${side}</b>\n• Trader: <code>${account}</code>\n• Pair: ${pair}\n• Size: ${p?.sizeStr||usd30ToStr(sizeDelta)}\n• Collateral: ${p?.collStr||'—'}\n• Lev: ${p?.lev||'—'}\n• Entry: ${p?('$'+p.entry.toFixed(2)):'—'}\n• PnL: ${p?(p.pnlSign+p.pnlStr):'—'}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`
    );
  });

  // Decreases
  router.on("ExecuteDecreasePosition", async (account, path, indexToken, collDelta, sizeDelta, isLong, receiver, acceptablePrice, minOut, execFee, blockGap, timeGap, ev) => {
    const collToken = path[path.length-1];
    const p = await pullPosition(vault, account, collToken, indexToken, isLong);
    const side = isLong?"🟢 LONG":"🔴 SHORT", pair=sym(indexToken);
    send(
      `📉 <b>Decrease ${side}</b>\n• Trader: <code>${account}</code>\n• Pair: ${pair}\n• Size Δ: ${usd30ToStr(sizeDelta)}\n• Coll Out: ${usd30ToStr(collDelta)}\n• Lev: ${p?.lev||'—'}\n• Entry: ${p?('$'+p.entry.toFixed(2)):'—'}\n• PnL: ${p?(p.pnlSign+p.pnlStr):'—'}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`
    );
  });

  // Liquidations
  vault.on("LiquidatePosition", async (key, account, collToken, indexToken, isLong, size, collateral, reserveAmt, realisedPnl, markPrice, ev) => {
    send(
      `💥 <b>LIQUIDATION</b>\n• Trader: <code>${account}</code>\n• Pair: ${sym(indexToken)} — ${isLong?'LONG':'SHORT'}\n• Size: ${usd30ToStr(size)}\n• Collateral: ${usd30ToStr(collateral)}\n• Mark Price: $${from1e30(markPrice).toFixed(2)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`
    );
  });

  // --- raw ws reconnect (ethers v6 doesn’t emit "close") ---
  if (provider._ws) {
    provider._ws.on("close", () => {
      console.error("WS closed, reconnecting in 5s…");
      setTimeout(connect, 5000);
    });
    provider._ws.on("error", (err) => {
      console.error("WS error:", err.message);
    });
  }
}

connect();
