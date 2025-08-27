// MoneyX Trades TG Bot — Full with CoinMarketCap Pricing

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  SUBGRAPH_URL,
  POLL_INTERVAL_MS = '15000',
  MIN_SIZE_USD = '0',
  EXPLORER_TX_BASE = 'https://bscscan.com/tx/',
  CMC_API_KEY,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL || !CMC_API_KEY) {
  console.error('Missing env vars: TG_BOT_TOKEN, TG_CHAT_ID, SUBGRAPH_URL, CMC_API_KEY');
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// ---------- State ----------
const STATE_FILE = path.join(__dirname, 'state.json');
let state = loadStateSync();
function loadStateSync() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastTs: 0, seen: {} }; }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Helpers ----------
const short = (addr) => addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
const fmtUsd = (v) => v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtPrice = (v) => v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const calcLev = (size, coll) => (!size || !coll) ? '—' : (size / coll).toFixed(1) + 'x';

const scale1e30 = (v) => Number(v) / 1e30;
const scale1e18 = (v) => Number(v) / 1e18;

// Map collateral token addresses → CMC symbols
const TOKEN_SYMBOLS = {
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "BNB",   // WBNB
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": "ETH",   // ETH
  "0xba2ae424d960c26247dd6c32edc70b295c744c43": "DOGE",  // DOGE
  "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe": "XRP",   // XRP
};

// Cache prices for 1 minute
const PRICE_CACHE = {};
async function getTokenPriceUsd(tokenAddr) {
  const sym = TOKEN_SYMBOLS[tokenAddr.toLowerCase()];
  if (!sym) return null;

  if (PRICE_CACHE[sym] && Date.now() - PRICE_CACHE[sym].ts < 60_000) {
    return PRICE_CACHE[sym].usd;
  }

  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest",
      {
        params: { symbol: sym, convert: "USD" },
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
      }
    );
    const usd = res.data.data[sym].quote.USD.price;
    PRICE_CACHE[sym] = { usd, ts: Date.now() };
    return usd;
  } catch (e) {
    console.error("CMC price fetch failed:", e.message);
    return null;
  }
}

// ---------- Renderer ----------
function renderMessage(type, rec) {
  const isLiq = type === 'Liquidation';
  const direction = rec.isLong ? '🟢 LONG' : '🔴 SHORT';
  const title = isLiq ? '💥 LIQUIDATION' : `📈 ${type} ${direction}`;

  let lines = [
    `${title}`,
    `• Pair: ${rec.indexToken}`,
    `• Wallet: ${short(rec.account)}`,
    `• Size: ${fmtUsd(rec.size)}`,
  ];
  if (rec.collateral != null) lines.push(`• Collateral: ${fmtUsd(rec.collateral)}`);
  lines.push(`• Leverage: ${rec.leverage}`);
  lines.push(`• Price: ${fmtPrice(rec.price)}`);

  if (isLiq) {
    if (rec.avgPrice) lines.push(`• Avg Entry: ${fmtPrice(rec.avgPrice)}`);
    if (rec.loss) lines.push(`• Loss: ${fmtUsd(rec.loss)}`);
  }
  return lines.join('\n') + (rec.tx ? `\n🔗 tx: ${EXPLORER_TX_BASE}${rec.tx}` : '');
}

// ---------- Queries ----------
async function fetchIncrease(since) {
  const q = `
    {
      createIncreasePositions(first: 50, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
        id account indexToken collateralToken isLong sizeDelta amountIn acceptablePrice transaction timestamp
      }
    }
  `;
  const res = await axios.post(SUBGRAPH_URL, { query: q });
  return res.data.data.createIncreasePositions || [];
}
async function fetchDecrease(since) {
  const q = `
    {
      createDecreasePositions(first: 50, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
        id account indexToken collateralToken isLong sizeDelta acceptablePrice transaction timestamp
      }
    }
  `;
  const res = await axios.post(SUBGRAPH_URL, { query: q });
  return res.data.data.createDecreasePositions || [];
}
async function fetchLiquidations(since) {
  const q = `
    {
      liquidatedPositions(first: 50, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
        id account indexToken collateralToken isLong size collateral markPrice averagePrice loss timestamp
      }
    }
  `;
  const res = await axios.post(SUBGRAPH_URL, { query: q });
  return res.data.data.liquidatedPositions || [];
}

// ---------- Handlers ----------
async function handleIncrease(r) {
  const size = scale1e30(r.sizeDelta);
  const collAmount = scale1e18(r.amountIn);
  const price = await getTokenPriceUsd(r.collateralToken);
  const collUsd = price ? collAmount * price : 0;
  return {
    id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
    size, collateral: collUsd, leverage: calcLev(size, collUsd),
    price: scale1e30(r.acceptablePrice),
    tx: r.transaction, timestamp: Number(r.timestamp),
  };
}
async function handleDecrease(r) {
  const size = scale1e30(r.sizeDelta);
  return {
    id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
    size, collateral: null, leverage: '—',
    price: scale1e30(r.acceptablePrice),
    tx: r.transaction, timestamp: Number(r.timestamp),
  };
}
async function handleLiquidation(r) {
  const size = scale1e30(r.size);
  const collAmount = scale1e18(r.collateral);
  const price = await getTokenPriceUsd(r.collateralToken);
  const collUsd = price ? collAmount * price : 0;
  return {
    id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
    size, collateral: collUsd, leverage: calcLev(size, collUsd),
    price: scale1e30(r.markPrice), avgPrice: scale1e30(r.averagePrice),
    loss: scale1e30(r.loss), tx: null, timestamp: Number(r.timestamp),
  };
}

// ---------- Main Loop ----------
async function runOnce() {
  const since = state.lastTs || 0;
  let newest = since;

  for (const r of await fetchIncrease(since)) {
    if (state.seen[r.id]) continue;
    const rec = await handleIncrease(r);
    await bot.sendMessage(TG_CHAT_ID, renderMessage('Increase', rec));
    state.seen[r.id] = true;
    if (rec.timestamp > newest) newest = rec.timestamp;
  }
  for (const r of await fetchDecrease(since)) {
    if (state.seen[r.id]) continue;
    const rec = await handleDecrease(r);
    await bot.sendMessage(TG_CHAT_ID, renderMessage('Decrease', rec));
    state.seen[r.id] = true;
    if (rec.timestamp > newest) newest = rec.timestamp;
  }
  for (const r of await fetchLiquidations(since)) {
    if (state.seen[r.id]) continue;
    const rec = await handleLiquidation(r);
    await bot.sendMessage(TG_CHAT_ID, renderMessage('Liquidation', rec));
    state.seen[r.id] = true;
    if (rec.timestamp > newest) newest = rec.timestamp;
  }

  state.lastTs = newest;
  saveState();
}

// ---------- Startup ----------
(async function main() {
  console.log('🚀 MoneyX TG bot started. Polling:', SUBGRAPH_URL);

  // dump last 5 increases as sanity check
  const recent = await fetchIncrease(state.lastTs - 3600);
  for (const r of recent.slice(-5)) {
    const rec = await handleIncrease(r);
    await bot.sendMessage(TG_CHAT_ID,
`🧪 STARTUP 
• Wallet: ${short(rec.account)}
• Size: ${fmtUsd(rec.size)}
• Collateral: ${fmtUsd(rec.collateral)}
• Leverage: ${rec.leverage}
• Price: ${fmtPrice(rec.price)}`);
  }

  setInterval(runOnce, Number(POLL_INTERVAL_MS));
})();
