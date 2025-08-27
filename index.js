require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  SUBGRAPH_URL,
  POLL_INTERVAL_MS = "15000",
  SCALE_1E30 = "true",
  MIN_SIZE_USD = "0",
  EXPLORER_TX_BASE = "",
  REDIS_URL,
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL) {
  console.error("❌ Missing required env vars (TG_BOT_TOKEN, TG_CHAT_ID, SUBGRAPH_URL)");
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// ---------- State: Redis (preferred) or file fallback ----------
let useRedis = false;
let redis = null;
if (REDIS_URL) {
  try {
    const Redis = require("ioredis");
    redis = new Redis(REDIS_URL);
    useRedis = true;
    console.log("✅ Redis enabled for durable state.");
  } catch (e) {
    console.warn("⚠️ Redis not available, falling back to file state:", e.message);
  }
}

const STATE_FILE = path.join(__dirname, "state.json");

async function loadState() {
  if (useRedis) {
    const lastTs = Number(await redis.get("mx:lastTs")) || 0;
    return { lastTs };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastTs: 0 };
  }
}

async function saveState(state) {
  if (useRedis) {
    await redis.set("mx:lastTs", String(state.lastTs || 0));
    return;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function markSeen(ts, id) {
  if (useRedis) {
    await redis.sadd(`mx:seen:${ts}`, id);
  }
}
async function alreadySeen(ts, id) {
  if (useRedis) {
    return (await redis.sismember(`mx:seen:${ts}`, id)) === 1;
  }
  return false;
}
async function rotateSeen(oldTs, newTs) {
  if (useRedis && newTs > oldTs) {
    await redis.del(`mx:seen:${oldTs}`);
  }
}

// ---------- Helpers ----------
const FIRST = 50;
const scale = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return SCALE_1E30 === "true" ? n / 1e30 : n;
};
function short(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}
function fmtUsd(v) {
  if (v == null) return "—";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPrice(p) {
  if (p == null) return "—";
  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function calcLev(sizeUsd, collUsd) {
  if (!sizeUsd || !collUsd) return "—";
  return (sizeUsd / collUsd).toFixed(1) + "x";
}
function linkTx(tx) {
  if (!tx || !EXPLORER_TX_BASE) return "";
  const full = tx.startsWith("0x") ? EXPLORER_TX_BASE + tx : tx;
  return `\n🔗 tx: ${full}`;
}

// ---------- GraphQL queries (tailored to your schema) ----------
const QUERIES = [
  {
    type: "Increase",
    key: "createIncreasePositions",
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
  },
  {
    type: "Decrease",
    key: "createDecreasePositions",
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
          transaction
          timestamp
        }
      }
    `,
  },
  {
    type: "Liquidation",
    key: "liquidatedPositions",
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
  },
];

// ---------- Format messages ----------
function toMessages(type, records) {
  return records.map((r) => {
    if (type === "Increase") {
      const size = scale(r.sizeDelta);
      const coll = scale(r.amountIn);
      const lev = calcLev(size, coll);
      const price = scale(r.acceptablePrice);
      return (
`📈 Increase ${r.isLong ? "🟢 LONG" : "🔴 SHORT"}
• Pair: ${r.indexToken}
• Wallet: ${short(r.account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(coll)}
• Leverage: ${lev}
• Limit Price: ${fmtPrice(price)}${linkTx(r.transaction)}`
      );
    }

    if (type === "Decrease") {
      const size = scale(r.sizeDelta);
      const price = scale(r.acceptablePrice);
      return (
`📉 Decrease ${r.isLong ? "🟢 LONG" : "🔴 SHORT"}
• Pair: ${r.indexToken}
• Wallet: ${short(r.account)}
• Size Reduced: ${fmtUsd(size)}
• Limit Price: ${fmtPrice(price)}${linkTx(r.transaction)}`
      );
    }

    if (type === "Liquidation") {
      const size = scale(r.size);
      const coll = scale(r.collateral);
      const lev = calcLev(size, coll);
      const markPrice = scale(r.markPrice);
      const avg = scale(r.averagePrice);
      const loss = scale(r.loss);
      return (
`💥 LIQUIDATION ${r.isLong ? "🟢 LONG" : "🔴 SHORT"}
• Pair: ${r.indexToken}
• Wallet: ${short(r.account)}
• Size: ${fmtUsd(size)}
• Collateral: ${fmtUsd(coll)}
• Leverage: ${lev}
• Entry Price: ${fmtPrice(avg)}
• Liq Price: ${fmtPrice(markPrice)}
• Loss: ${fmtUsd(loss)}`
      );
    }

    return "";
  });
}

// ---------- Fetch + run ----------
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
  return items;
}

async function runOnce(state) {
  const minSize = Number(MIN_SIZE_USD) || 0;
  let newestTs = state.lastTs || 0;

  for (const q of QUERIES) {
    try {
      const items = await fetchBlock(q, state.lastTs || 0);
      if (!items.length) continue;

      for (const it of items) {
        const ts = Number(it.timestamp);
        if (ts < (state.lastTs || 0)) continue;
        if (await alreadySeen(ts, it.id)) continue;

        // Skip tiny trades
        let rawSize = it.sizeDelta ?? it.size ?? 0;
        if (scale(rawSize) < minSize) {
          await markSeen(ts, it.id);
          continue;
        }

        const msgs = toMessages(q.type, [it]);
        for (const msg of msgs) {
          if (msg) {
            await bot.sendMessage(TG_CHAT_ID, msg, { disable_web_page_preview: true });
          }
        }

        await markSeen(ts, it.id);
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
  console.log("🚀 MoneyX TG bot started. Polling:", SUBGRAPH_URL);
  let state = await loadState();

  // On first boot: look back 1 hour so you see something right away
  state.lastTs = Math.max(0, state.lastTs - 3600);

  state = await runOnce(state);
  setInterval(async () => {
    state = await runOnce(state);
  }, Number(POLL_INTERVAL_MS));
})();
