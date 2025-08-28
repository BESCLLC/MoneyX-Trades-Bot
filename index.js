
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  SUBGRAPH_URL,
  POLL_INTERVAL_MS = '60000', // default 1 min
  EXPLORER_TX_BASE = 'https://bscscan.com/tx/',
  CMC_API_KEY,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL || !CMC_API_KEY) {
  console.error('❌ Missing env vars: TG_BOT_TOKEN, TG_CHAT_ID, SUBGRAPH_URL, CMC_API_KEY');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (addr) => (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '');
const fmtUsd = (v) => (v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const calcLev = (size, coll) => (!size || !coll ? '—' : (size / coll).toFixed(1) + 'x');

const scale1e30 = (v) => Number(v) / 1e30;
const scale1e18 = (v) => Number(v) / 1e18;

// Supported tokens
const SYMBOLS = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0xba2ae424d960c26247dd6c32edc70b295c744c43': 'DOGE',
  '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe': 'XRP',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'BTC',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
};
const sym = (addr) => SYMBOLS[addr?.toLowerCase()] || short(addr);

// ---------- Price Fetch (CMC) ----------
const PRICE_CACHE = {};
async function getPrice(symbol) {
  if (PRICE_CACHE[symbol] && Date.now() - PRICE_CACHE[symbol].ts < 60000) {
    return PRICE_CACHE[symbol].usd;
  }
  const res = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
    params: { symbol, convert: 'USD' },
    headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
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

// ---------- Trader Stats ----------
async function fetchUserStat(account) {
  const q = `{ userStat(id: "${account.toLowerCase()}") {
    actionCount
    actionMarginCount
    actionSwapCount
  } }`;
  try {
    const res = await axios.post(SUBGRAPH_URL, { query: q });
    return res.data?.data?.userStat || null;
  } catch {
    return null;
  }
}
function renderUserStats(stats) {
  if (!stats) return '';
  return `\n📊 Trader Stats
• Total Actions: ${stats.actionCount}
• Margin Trades: ${stats.actionMarginCount}
• Swaps: ${stats.actionSwapCount}`;
}

// ---------- Renderers ----------
function renderIncrease(rec, stats) {
  const whale = rec.size > 10000 ? ' 🐳' : '';
  return `${whale} 📈 Increase ${rec.isLong ? '🟢 LONG' : '🔴 SHORT'}
• Pair: ${sym(rec.indexToken)}-USD
• Wallet: ${short(rec.account)}
• Size: ${fmtUsd(rec.size)}
• Collateral: ${fmtUsd(rec.collateral)} (${sym(rec.collateralToken)})
• Leverage: ${rec.leverage}
• Price: ${fmtPrice(rec.price)}${
    rec.tx ? `\n🔗 tx: ${EXPLORER_TX_BASE}${rec.tx}` : ''
  }${renderUserStats(stats)}`;
}
function renderDecrease(rec, stats) {
  return rec.pnlUsd > 0
    ? `💰 Close 🟢 PROFIT
• ${fmtUsd(rec.pnlUsd)} (+${rec.pnlPct.toFixed(1)}%)
• Pair: ${sym(rec.indexToken)}-USD
• Wallet: ${short(rec.account)}${renderUserStats(stats)}`
    : `🔻 Close 🔴 LOSS
• ${fmtUsd(rec.pnlUsd)} (${rec.pnlPct.toFixed(1)}%)
• Pair: ${sym(rec.indexToken)}-USD
• Wallet: ${short(rec.account)}${renderUserStats(stats)}`;
}
function renderLiquidation(rec, stats) {
  return `💥 LIQUIDATION ALERT 💥
• Wallet REKT: ${short(rec.account)}
• Pair: ${sym(rec.indexToken)}-USD
• Loss: ${fmtUsd(rec.loss)}
• Size: ${fmtUsd(rec.size)} at ${rec.leverage}
🚑 Better luck next time...${renderUserStats(stats)}`;
}

// ---------- Query (batched with retry) ----------
async function fetchEvents(since) {
  const q = `{
    createIncreasePositions(first: 100, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
      id account indexToken collateralToken isLong sizeDelta amountIn acceptablePrice transaction timestamp
    }
    createDecreasePositions(first: 100, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
      id account indexToken collateralToken isLong sizeDelta acceptablePrice transaction timestamp
    }
    liquidatedPositions(first: 100, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${since} }) {
      id account indexToken collateralToken isLong size collateral markPrice averagePrice loss timestamp
    }
  }`;

  let retries = 0;
  while (true) {
    try {
      const res = await axios.post(SUBGRAPH_URL, { query: q });
      if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
      return res.data.data;
    } catch (e) {
      retries++;
      if (e.response && e.response.status === 429) {
        const retry = e.response.headers['retry-after']
          ? parseInt(e.response.headers['retry-after'], 10) * 1000
          : 60000; // default 60s
        console.warn(`⏳ Rate limited. Waiting ${retry / 1000}s before retry...`);
        await sleep(retry);
        continue;
      }
      console.error('fetchEvents error:', e.message);
      return { createIncreasePositions: [], createDecreasePositions: [], liquidatedPositions: [] };
    }
  }
}

// ---------- Handlers ----------
async function handleIncrease(r) {
  const size = scale1e30(r.sizeDelta);
  const collAmount = scale1e18(r.amountIn);
  const price = await getTokenPriceUsd(r.collateralToken);
  const collUsd = price ? collAmount * price : 0;
  return {
    id: r.id, account: r.account, indexToken: r.indexToken, collateralToken: r.collateralToken, isLong: r.isLong,
    size, collateral: collUsd, leverage: calcLev(size, collUsd),
    price: scale1e30(r.acceptablePrice), tx: r.transaction, timestamp: Number(r.timestamp),
  };
}
async function handleDecrease(r) {
  const size = scale1e30(r.sizeDelta);
  const current = await getTokenPriceUsd(r.indexToken);
  if (!current) return null;
  const entry = scale1e30(r.acceptablePrice);
  const delta = r.isLong ? current - entry : entry - current;
  const pnlUsd = (delta / entry) * size;
  const pnlPct = (pnlUsd / size) * 100;
  return { id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
    pnlUsd, pnlPct, size, timestamp: Number(r.timestamp) };
}
async function handleLiquidation(r) {
  const size = scale1e30(r.size);
  const collAmount = scale1e18(r.collateral);
  const price = await getTokenPriceUsd(r.collateralToken);
  const collUsd = price ? collAmount * price : 0;
  return { id: r.id, account: r.account, indexToken: r.indexToken, collateralToken: r.collateralToken, isLong: r.isLong,
    size, collateral: collUsd, leverage: calcLev(size, collUsd),
    price: scale1e30(r.markPrice), avgPrice: scale1e30(r.averagePrice),
    loss: scale1e30(r.loss), timestamp: Number(r.timestamp) };
}

// ---------- Main Loop ----------
async function runOnce() {
  const since = state.lastTs || 0;
  let newest = since;
  const data = await fetchEvents(since);

  for (const r of data.createIncreasePositions) {
    if (state.seen[r.id]) continue;
    const rec = await handleIncrease(r);
    const stats = await fetchUserStat(r.account);
    await bot.sendMessage(TG_CHAT_ID, renderIncrease(rec, stats));
    state.seen[r.id] = true;
    newest = Math.max(newest, rec.timestamp);
  }

  for (const r of data.createDecreasePositions) {
    if (state.seen[r.id]) continue;
    const rec = await handleDecrease(r);
    if (rec) {
      const stats = await fetchUserStat(r.account);
      await bot.sendMessage(TG_CHAT_ID, renderDecrease(rec, stats));
      state.seen[r.id] = true;
      newest = Math.max(newest, rec.timestamp);
    }
  }

  for (const r of data.liquidatedPositions) {
    if (state.seen[r.id]) continue;
    const rec = await handleLiquidation(r);
    const stats = await fetchUserStat(r.account);
    await bot.sendMessage(TG_CHAT_ID, renderLiquidation(rec, stats));
    state.seen[r.id] = true;
    newest = Math.max(newest, rec.timestamp);
  }

  state.lastTs = Math.max(newest, since) + 1;
  saveState();
}

// ---------- Startup ----------
(async function main() {
  console.log('🚀 MoneyX TG bot stable started. Polling:', SUBGRAPH_URL);
  setInterval(runOnce, Number(POLL_INTERVAL_MS));
})();
