// index.js
require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const {
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  SUBGRAPH_URL,
  POLL_INTERVAL_MS = '15000',
} = process.env;

if (!TG_BOT_TOKEN || !TG_CHAT_ID || !SUBGRAPH_URL) {
  console.error('Missing TG_BOT_TOKEN, TG_CHAT_ID, or SUBGRAPH_URL');
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// ---- Helpers ----
function short(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}
function fmtUsd(v) {
  if (v == null) return '—';
  const num = Number(v) / 1e30 || Number(v);
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPrice(p) {
  if (p == null) return '—';
  const num = Number(p) / 1e30 || Number(p);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function calcLev(sizeUsd, collUsd) {
  const s = Number(sizeUsd) / 1e30;
  const c = Number(collUsd) / 1e30;
  if (!s || !c) return '—';
  return (s / c).toFixed(1) + 'x';
}
function linkTx(tx) {
  if (!tx) return '';
  return `\n🔗 tx: https://bscscan.com/tx/${tx}`;
}

// ---- Queries ----
const QUERIES = [
  {
    type: 'Increase',
    key: 'positionIncreases',
    query: `
      query ($since: BigInt!, $first: Int!) {
        positionIncreases(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id
          account
          indexToken
          isLong
          sizeDeltaUsd
          collateralDeltaUsd
          price
          tx
          timestamp
        }
      }
    `,
  },
  {
    type: 'Decrease',
    key: 'positionDecreases',
    query: `
      query ($since: BigInt!, $first: Int!) {
        positionDecreases(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id
          account
          indexToken
          isLong
          sizeDeltaUsd
          collateralDeltaUsd
          price
          tx
          timestamp
        }
      }
    `,
  },
  {
    type: 'Liquidation',
    key: 'positionLiquidations',
    query: `
      query ($since: BigInt!, $first: Int!) {
        positionLiquidations(first: $first, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: $since }) {
          id
          account
          indexToken
          isLong
          sizeUsd
          collateralUsd
          price
          tx
          timestamp
        }
      }
    `,
  },
];

let lastTs = 0;
let seenIds = {};

function toMessages(type, records) {
  return records.map((r) => {
    const isLiq = type === 'Liquidation';
    const sizeUsd = r.sizeDeltaUsd ?? r.sizeUsd;
    const collUsd = r.collateralDeltaUsd ?? r.collateralUsd;

    const directionEmoji = r.isLong ? '🟢 LONG' : '🔴 SHORT';
    const title = isLiq ? '💥 LIQUIDATION' : `📈 ${type} ${directionEmoji}`;

    return (
`${title}
• Pair: ${r.indexToken || '—'}
• Wallet: ${short(r.account)}
• Size: ${fmtUsd(sizeUsd)}
• Collateral: ${fmtUsd(collUsd)}
• Leverage: ${calcLev(sizeUsd, collUsd)}
• Price: ${fmtPrice(r.price)}${linkTx(r.tx)}`
    );
  });
}

async function runOnce() {
  let newestTs = lastTs;
  const FIRST = 50;

  for (const q of QUERIES) {
    try {
      const res = await axios.post(SUBGRAPH_URL, {
        query: q.query,
        variables: { since: String(lastTs), first: FIRST },
      });

      const items = res.data.data?.[q.key] ?? [];
      if (!items.length) continue;

      items.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      const fresh = items.filter((it) => {
        const ts = Number(it.timestamp);
        if (ts < lastTs) return false;
        if (ts === lastTs && seenIds[it.id]) return false;
        return true;
      });

      if (fresh.length) {
        const msgs = toMessages(q.type, fresh);
        for (let i = 0; i < msgs.length; i++) {
          await bot.sendMessage(TG_CHAT_ID, msgs[i], { disable_web_page_preview: true });
          seenIds[fresh[i].id] = true;
          const ts = Number(fresh[i].timestamp);
          if (ts > newestTs) newestTs = ts;
        }
      }
    } catch (e) {
      console.error(`[${q.type}] query failed:`, e?.response?.data || e.message);
    }
  }

  if (newestTs > lastTs) {
    lastTs = newestTs;
    seenIds = {};
  }
}

async function main() {
  console.log('MoneyX TG bot started. Polling:', SUBGRAPH_URL);
  await runOnce();
  setInterval(runOnce, Number(POLL_INTERVAL_MS));
}
main();
