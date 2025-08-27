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
  EXPLORER_TX_BASE = '',
  REDIS_URL,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL) {
  console.error('Missing required env: TG_BOT_TOKEN, TG_CHAT_ID, SUBGRAPH_URL');
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// ---------- State ----------
let useRedis = false;
let redis = null;
if (REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(REDIS_URL);
    useRedis = true;
    console.log('Redis enabled for durable state.');
  } catch (e) {
    console.warn('Redis not available, falling back to file state:', e.message);
  }
}
const STATE_FILE = path.join(__dirname, 'state.json');
async function loadState() {
  if (useRedis) return { lastTs: Number(await redis.get('mx:lastTs')) || 0 };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastTs: 0 }; }
}
async function saveState(state) {
  if (useRedis) await redis.set('mx:lastTs', String(state.lastTs || 0));
  else fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
async function markSeen(ts, id) { if (useRedis) await redis.sadd(`mx:seen:${ts}`, id); }
async function alreadySeen(ts, id) { return useRedis ? (await redis.sismember(`mx:seen:${ts}`, id)) === 1 : false; }
async function rotateSeen(oldTs, newTs) { if (useRedis && newTs > oldTs) await redis.del(`mx:seen:${oldTs}`); }

// ---------- Helpers ----------
const FIRST = 50;
const scale1e30 = (v) => Number(v) / 1e30;
const scale1e18 = (v) => Number(v) / 1e18;
const short = (addr) => (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '');
const fmtUsd = (v) => (v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const fmtPrice = (p) => (p == null ? '—' : p.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const calcLev = (sizeUsd, collUsd) => (!sizeUsd || !collUsd ? '—' : (sizeUsd / collUsd).toFixed(1) + 'x');
const linkTx = (tx) => (!tx || !EXPLORER_TX_BASE ? '' : `\n🔗 tx: ${EXPLORER_TX_BASE}${tx}`);

// ---------- Chainlink price fetch ----------
async function getTokenPriceUsd(tokenAddr) {
  try {
    const q = `
      query {
        chainlinkPrices(first:1, orderBy:timestamp, orderDirection:desc, where:{token:"${tokenAddr.toLowerCase()}"}) {
          value
        }
      }`;
    const res = await axios.post(SUBGRAPH_URL, { query: q });
    const val = res.data.data?.chainlinkPrices?.[0]?.value;
    if (!val) return null;
    return scale1e30(val); // USD price
  } catch (e) {
    console.error("Price fetch failed:", e.message);
    return null;
  }
}

// ---------- GraphQL queries ----------
const QUERIES = [
  {
    type: 'Increase',
    key: 'createIncreasePositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        createIncreasePositions(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id account indexToken collateralToken isLong sizeDelta amountIn acceptablePrice transaction timestamp
        }
      }`,
    map: async (r) => {
      const sizeUsd = scale1e30(r.sizeDelta);
      const tokenPrice = await getTokenPriceUsd(r.collateralToken);
      const amount = scale1e18(r.amountIn);
      const collUsd = tokenPrice ? amount * tokenPrice : 0;
      return {
        id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
        size: sizeUsd, collateral: collUsd,
        leverage: calcLev(sizeUsd, collUsd),
        price: scale1e30(r.acceptablePrice),
        tx: r.transaction, timestamp: Number(r.timestamp),
      };
    },
  },
  {
    type: 'Decrease',
    key: 'createDecreasePositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        createDecreasePositions(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id account indexToken collateralToken isLong sizeDelta acceptablePrice executionFee transaction timestamp
        }
      }`,
    map: async (r) => ({
      id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
      size: scale1e30(r.sizeDelta), collateral: null,
      leverage: '—',
      price: scale1e30(r.acceptablePrice),
      tx: r.transaction, timestamp: Number(r.timestamp),
    }),
  },
  {
    type: 'Liquidation',
    key: 'liquidatedPositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        liquidatedPositions(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id account indexToken isLong size collateral markPrice averagePrice loss timestamp collateralToken
        }
      }`,
    map: async (r) => {
      const sizeUsd = scale1e30(r.size);
      const tokenPrice = await getTokenPriceUsd(r.collateralToken);
      const coll = scale1e18(r.collateral);
      const collUsd = tokenPrice ? coll * tokenPrice : 0;
      return {
        id: r.id, account: r.account, indexToken: r.indexToken, isLong: r.isLong,
        size: sizeUsd, collateral: collUsd, leverage: calcLev(sizeUsd, collUsd),
        price: scale1e30(r.markPrice),
        avgPrice: scale1e30(r.averagePrice),
        loss: scale1e30(r.loss),
        tx: null, timestamp: Number(r.timestamp),
      };
    },
  },
];

// ---------- Renderer ----------
function renderMessage(type, rec) {
  const isLiq = type === 'Liquidation';
  const directionEmoji = rec.isLong ? '🟢 LONG' : '🔴 SHORT';
  const title = isLiq ? '💥 LIQUIDATION' : `📈 ${type} ${directionEmoji}`;

  let lines = [
    `${title}`,
    `• Pair: ${rec.indexToken || '—'}`,
    `• Wallet: ${short(rec.account)}`,
    `• Size: ${fmtUsd(rec.size)}`,
  ];
  if (rec.collateral != null) lines.push(`• Collateral: ${fmtUsd(rec.collateral)}`);
  lines.push(`• Leverage: ${rec.leverage}`);
  lines.push(`• Price: ${fmtPrice(rec.price)}`);

  if (isLiq) {
    if (rec.avgPrice != null) lines.push(`• Avg Entry: ${fmtPrice(rec.avgPrice)}`);
    if (rec.loss != null) lines.push(`• Loss: ${fmtUsd(rec.loss)}`);
  }
  return lines.join('\n') + (rec.tx ? linkTx(rec.tx) : '');
}

// ---------- Runner ----------
async function fetchBlock(q, sinceTs) {
  const res = await axios.post(SUBGRAPH_URL, { query: q.query, variables: { since: String(sinceTs), first: FIRST } });
  if (res.data.errors) return [];
  const items = res.data.data?.[q.key] ?? [];
  items.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const mapped = [];
  for (const it of items) mapped.push(await q.map(it));
  return mapped;
}

async function runOnce(state) {
  const minSize = Number(MIN_SIZE_USD) || 0;
  let newestTs = state.lastTs || 0;
  for (const q of QUERIES) {
    try {
      const items = await fetchBlock(q, state.lastTs || 0);
      for (const rec of items) {
        const ts = rec.timestamp;
        if (ts < (state.lastTs || 0)) continue;
        if (await alreadySeen(ts, rec.id)) continue;
        if ((rec.size || 0) < minSize) { await markSeen(ts, rec.id); continue; }

        await bot.sendMessage(TG_CHAT_ID, renderMessage(q.type, rec), { disable_web_page_preview: true });
        await markSeen(ts, rec.id);
        if (ts > newestTs) newestTs = ts;
      }
    } catch (e) { console.error(`[${q.type}]`, e?.response?.data || e.message); }
  }
  if (newestTs > (state.lastTs || 0)) {
    const old = state.lastTs || 0;
    state.lastTs = newestTs;
    await saveState(state);
    await rotateSeen(old, newestTs);
  }
  return state;
}

(async function main() {
  console.log('🚀 MoneyX TG bot started. Polling:', SUBGRAPH_URL);
  let state = await loadState();

  // Startup sanity check: last 5 increases
  try {
    const res = await axios.post(SUBGRAPH_URL, {
      query: `{ createIncreasePositions(first:5, orderBy:timestamp, orderDirection:desc) {
        id account indexToken isLong sizeDelta amountIn acceptablePrice transaction timestamp collateralToken } }`
    });
    for (const r of res.data.data.createIncreasePositions.reverse()) {
      const size = scale1e30(r.sizeDelta);
      const tokenPrice = await getTokenPriceUsd(r.collateralToken);
      const coll = scale1e18(r.amountIn);
      const collUsd = tokenPrice ? coll * tokenPrice : 0;
      const lev = calcLev(size, collUsd);
      const price = scale1e30(r.acceptablePrice);
      await bot.sendMessage(TG_CHAT_ID,
`🧪 STARTUP LAST 5 TRADES
• Wallet: ${short(r.account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(collUsd)}
• Leverage: ${lev}
• Price: ${fmtPrice(price)}`);
    }
  } catch (e) { console.error('Startup dump failed', e.message); }

  setInterval(async () => { state = await runOnce(state); }, Number(POLL_INTERVAL_MS));
})();
