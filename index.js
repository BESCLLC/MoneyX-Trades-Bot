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
  SCALE_1E30 = 'true',
  MIN_SIZE_USD = '0',
  EXPLORER_TX_BASE = '',
  REDIS_URL,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL) {
  console.error('Missing required env: TG_BOT_TOKEN, TG_CHAT_ID, SUBGRAPH_URL');
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// ---------- State: Redis (preferred) or file fallback ----------
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
  if (useRedis) {
    const lastTs = Number(await redis.get('mx:lastTs')) || 0;
    return { lastTs };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastTs: 0 };
  }
}
async function saveState(state) {
  if (useRedis) {
    await redis.set('mx:lastTs', String(state.lastTs || 0));
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}
async function markSeen(ts, id) {
  if (useRedis) await redis.sadd(`mx:seen:${ts}`, id);
}
async function alreadySeen(ts, id) {
  if (useRedis) return (await redis.sismember(`mx:seen:${ts}`, id)) === 1;
  return false;
}
async function rotateSeen(oldTs, newTs) {
  if (useRedis && newTs > oldTs) await redis.del(`mx:seen:${oldTs}`);
}

// ---------- Helpers ----------
const FIRST = 50;
const scale = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return (SCALE_1E30 === 'true') ? n / 1e30 : n;
};
const short = (addr) => (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '');
const fmtUsd = (v) => (v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const fmtPrice = (p) => (p == null ? '—' : p.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const calcLev = (sizeUsd, collUsd) => (!sizeUsd || !collUsd ? '—' : (sizeUsd / collUsd).toFixed(1) + 'x');
const linkTx = (tx) => (!tx || !EXPLORER_TX_BASE ? '' : `\n🔗 tx: ${EXPLORER_TX_BASE}${tx}`);

// ---------- GraphQL queries (schema-aligned) ----------
const QUERIES = [
  {
    type: 'Increase',
    key: 'createIncreasePositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        createIncreasePositions(
          first: $first,
          orderBy: timestamp,
          orderDirection: asc,
          where: { timestamp_gt: $since }
        ) {
          id
          account
          indexToken
          collateralToken
          isLong
          sizeDelta
          amountIn
          acceptablePrice
          transaction
          timestamp
        }
      }
    `,
    map: (r) => {
      const size = scale(r.sizeDelta);
      const coll = scale(r.amountIn);
      const price = scale(r.acceptablePrice);
      return {
        id: r.id,
        account: r.account,
        indexToken: r.indexToken,
        isLong: r.isLong,
        size,
        collateral: coll,
        leverage: calcLev(size, coll),
        price,
        tx: r.transaction,
        timestamp: Number(r.timestamp),
      };
    },
  },
  {
    type: 'Decrease',
    key: 'createDecreasePositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        createDecreasePositions(
          first: $first,
          orderBy: timestamp,
          orderDirection: asc,
          where: { timestamp_gt: $since }
        ) {
          id
          account
          indexToken
          collateralToken
          isLong
          sizeDelta
          acceptablePrice
          executionFee
          transaction
          timestamp
        }
      }
    `,
    map: (r) => {
      const size = scale(r.sizeDelta);
      const price = scale(r.acceptablePrice);
      return {
        id: r.id,
        account: r.account,
        indexToken: r.indexToken,
        isLong: r.isLong,
        size,
        collateral: null,
        leverage: '—',
        price,
        tx: r.transaction,
        timestamp: Number(r.timestamp),
      };
    },
  },
  {
    type: 'Liquidation',
    key: 'liquidatedPositions',
    query: `
      query ($since: BigInt!, $first: Int!) {
        liquidatedPositions(
          first: $first,
          orderBy: timestamp,
          orderDirection: asc,
          where: { timestamp_gt: $since }
        ) {
          id
          key
          account
          indexToken
          isLong
          size
          collateral
          markPrice
          averagePrice
          loss
          timestamp
        }
      }
    `,
    map: (r) => {
      const size = scale(r.size);
      const coll = scale(r.collateral);
      const price = scale(r.markPrice);
      const lev = calcLev(size, coll);
      return {
        id: r.id,
        account: r.account,
        indexToken: r.indexToken,
        isLong: r.isLong,
        size,
        collateral: coll,
        leverage: lev,
        price,
        avgPrice: scale(r.averagePrice),
        loss: scale(r.loss),
        tx: null,
        timestamp: Number(r.timestamp),
      };
    },
  },
];

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

async function fetchBlock(q, sinceTs) {
  const res = await axios.post(
    SUBGRAPH_URL,
    { query: q.query, variables: { since: String(sinceTs), first: FIRST } },
    { timeout: 20000 }
  );
  if (res.data.errors) return [];
  const items = res.data.data?.[q.key] ?? [];
  if (!items.length) return [];
  items.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return items.map(q.map);
}

async function runOnce(state) {
  const minSize = Number(MIN_SIZE_USD) || 0;
  let newestTs = state.lastTs || 0;

  for (const q of QUERIES) {
    try {
      const items = await fetchBlock(q, state.lastTs || 0);
      if (!items.length) continue;

      for (const rec of items) {
        const ts = rec.timestamp;
        if (ts < (state.lastTs || 0)) continue;
        if (await alreadySeen(ts, rec.id)) continue;

        if ((rec.size || 0) < minSize) {
          await markSeen(ts, rec.id);
          continue;
        }

        const msg = renderMessage(q.type, rec);
        await bot.sendMessage(TG_CHAT_ID, msg, { disable_web_page_preview: true });

        await markSeen(ts, rec.id);
        if (ts > newestTs) newestTs = ts;
      }
    } catch (e) {
      console.error(`[${q.type}] query failed:`, e?.response?.data || e.message);
    }
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

  // On first boot, dump last 5 increase trades as a sanity check
  try {
    const res = await axios.post(SUBGRAPH_URL, {
      query: `
        {
          createIncreasePositions(first: 5, orderBy: timestamp, orderDirection: desc) {
            id
            account
            indexToken
            isLong
            sizeDelta
            amountIn
            acceptablePrice
            transaction
            timestamp
          }
        }
      `
    });
    const recs = res.data.data.createIncreasePositions;
    if (recs && recs.length) {
      recs.reverse().forEach(r => {
        const size = scale(r.sizeDelta);
        const coll = scale(r.amountIn);
        const lev  = calcLev(size, coll);
        const price = scale(r.acceptablePrice);
        const msg =
`🧪 STARTUP TEST
• Wallet: ${short(r.account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(coll)}
• Leverage: ${lev}
• Price: ${fmtPrice(price)}`;
        bot.sendMessage(TG_CHAT_ID, msg);
      });
    }
  } catch (e) {
    console.error('Startup dump failed', e.message);
  }

  // Begin normal polling loop
  setInterval(async () => {
    state = await runOnce(state);
  }, Number(POLL_INTERVAL_MS));
})();
