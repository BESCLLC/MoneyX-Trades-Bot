// ---------- Provider with auto-reconnect ----------
let provider = null;
let vault = null;
let router = null;
let pingTimer = null;

function makeProvider() {
  console.log('🔌 Opening WS…');
  const p = new WebSocketProvider(ALCHEMY_WSS);

  // listen for provider-level events
  p.on('error', (err) => {
    console.error('WS provider error:', err?.message || String(err));
  });

  p.on('close', () => {
    console.error('WS provider closed — reconnecting in 5s…');
    cleanupProvider();
    setTimeout(reconnect, 5000);
  });

  // simple heartbeat: call getBlockNumber every 15s
  pingTimer = setInterval(() => {
    p.getBlockNumber().catch(() => {});
  }, 15000);

  return p;
}

function cleanupProvider() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  try { router?.removeAllListeners(); } catch {}
  try { vault?.removeAllListeners(); } catch {}
  router = null;
  vault = null;
}

function reconnect() {
  provider = makeProvider();
  attachContracts();
  backfill().catch(()=>{});
  send('♻️ Reconnected — listening again…').catch(()=>{});
}
