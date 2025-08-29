require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { WebSocketProvider, Contract } = require('ethers');

// ===== ENV =====
const ALCHEMY_WSS   = 'wss://bnb-mainnet.g.alchemy.com/v2/4Vvah0kUdr9X91EP08ZRZ';
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error('❌ Missing TG_BOT_TOKEN or TG_CHAT_ID in .env');
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
const sym = (addr) => TOKENS[(addr||'').toLowerCase()] || (addr ? addr.slice(0,6)+'…'+addr.slice(-4) : '—');

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

// ===== GLOBALS =====
let provider, vault, router;
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });
const send = (msg) => bot.sendMessage(TG_CHAT_ID, msg, { parse_mode:'HTML' }).catch(()=>{});

// ===== FORMATTERS =====
const usd30ToStr = (x) => `$${(Number(x)/1e30).toLocaleString(undefined,{maximumFractionDigits:2})}`;
const from1e30   = (x) => Number(x)/1e30;
const levStr     = (s,c) => (!c||c==0n)?'—':(Number(s)/Number(c)).toFixed(1)+'x';

// ===== POSITION PULL =====
async function pullPosition(account, collToken, indexToken, isLong) {
  try {
    const res   = await vault.getPosition(account, collToken, indexToken, isLong);
    const delta = await vault.getPositionDelta(account, collToken, indexToken, isLong);
    const [size, collateral, avgPrice] = [res[0], res[1], res[2]];
    const [hasProfit, pnl]             = [delta[0], delta[1]];
    if (size === 0n) return null;
    return {
      sizeStr: usd30ToStr(size),
      collStr: usd30ToStr(collateral),
      lev:     levStr(size, collateral),
      entry:   from1e30(avgPrice),
      pnlSign: hasProfit?'🟢 +':'🔴 -',
      pnlStr:  `$${Math.abs(from1e30(pnl)).toLocaleString(undefined,{maximumFractionDigits:2})}`
    };
  } catch { return null; }
}

// ===== EVENT HANDLERS =====
function attachHandlers() {
  // Increase
  router.on('ExecuteIncreasePosition', async (account,path,indexToken,amountIn,minOut,sizeDelta,isLong,acceptablePrice,executionFee,blockGap,timeGap,ev)=>{
    const coll = path[path.length-1];
    const pos  = await pullPosition(account, coll, indexToken, isLong);
    const side = isLong?'🟢 LONG':'🔴 SHORT';
    const pair = sym(indexToken);
    if (!pos) return send(`📈 <b>Increase ${side}</b>\nTrader: <code>${account}</code>\nPair: ${pair}\nSize Δ: ${usd30ToStr(sizeDelta)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`);
    send(`📈 <b>Increase ${side}</b>\nTrader: <code>${account}</code>\nPair: ${pair}\nSize: ${pos.sizeStr}\nCollateral: ${pos.collStr}\nLev: ${pos.lev}\nEntry: $${pos.entry.toFixed(2)}\nPnL: ${pos.pnlSign}${pos.pnlStr}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`);
  });

  // Decrease
  router.on('ExecuteDecreasePosition', async (account,path,indexToken,collDelta,sizeDelta,isLong,receiver,acceptablePrice,minOut,executionFee,blockGap,timeGap,ev)=>{
    const coll = path[path.length-1];
    const pos  = await pullPosition(account, coll, indexToken, isLong);
    const side = isLong?'🟢 LONG':'🔴 SHORT';
    const pair = sym(indexToken);
    const sΔ   = usd30ToStr(sizeDelta);
    const cΔ   = usd30ToStr(collDelta);
    if (!pos) return send(`📉 <b>Decrease ${side}</b>\nTrader: <code>${account}</code>\nPair: ${pair}\nSize Δ: ${sΔ}\nCollateral Out: ${cΔ}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`);
    send(`📉 <b>Decrease ${side}</b>\nTrader: <code>${account}</code>\nPair: ${pair}\nSize: ${pos.sizeStr} (Δ ${sΔ})\nCollateral: ${pos.collStr} (out ${cΔ})\nLev: ${pos.lev}\nEntry: $${pos.entry.toFixed(2)}\nPnL: ${pos.pnlSign}${pos.pnlStr}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`);
  });

  // Liquidation
  vault.on('LiquidatePosition', async (key,account,coll,indexToken,isLong,size,collateral,reserve,realisedPnl,markPrice,ev)=>{
    const pair = sym(indexToken);
    const side = isLong?'LONG':'SHORT';
    send(`💥 <b>LIQUIDATION</b>\nTrader: <code>${account}</code>\nPair: ${pair} — ${side}\nSize: ${usd30ToStr(size)}\nCollateral: ${usd30ToStr(collateral)}\nMark: $${from1e30(markPrice).toFixed(2)}\n🔗 <a href="https://bscscan.com/tx/${ev.transactionHash}">tx</a>`);
  });
}

// ===== RECONNECTABLE PROVIDER =====
function connect() {
  provider = new WebSocketProvider(ALCHEMY_WSS);
  vault    = new Contract(ADDR.Vault, ABI_VAULT, provider);
  router   = new Contract(ADDR.PositionRouter, ABI_ROUTER, provider);

  attachHandlers();

  provider._websocket.on('close', () => {
    console.error('⚠️ WS closed, reconnecting in 5s…');
    setTimeout(connect, 5000);
  });
  provider._websocket.on('error', (err) => {
    console.error('⚠️ WS error:', err.message);
    try { provider._websocket.terminate(); } catch {}
  });
}

// ===== HEARTBEAT (keepalive ping) =====
setInterval(()=> {
  if (provider?._websocket?.readyState === 1) {
    provider._websocket.ping();
  }
}, 30000); // every 30s

// ===== START =====
connect();
console.log('🚀 MoneyX TG bot live — Router + Vault with reconnect');
send('✅ MoneyX bot online — live feed w/ reconnect & heartbeat…').catch(()=>{});
