/* eslint-disable */
/**
 * Zari360 Connect Inbox -- socket connection + reconnect-storm load harness.
 *
 * Opens N concurrent socket.io connections to the `/inbox` namespace exactly as
 * the web client does (a fresh ticket minted per (re)connect from a JWT access
 * token), holds them, optionally runs a reconnect storm, and reports handshake
 * latency percentiles + connect success / failure counts.
 *
 * One machine caps near ~25-28k sockets (ephemeral-port limit). For the 100k
 * gate, run this on M machines x N connections (e.g. 5 x 20k) and aggregate.
 * Raise the fd limit first: `ulimit -n 200000`.
 *
 *   Real:  API_BASE=https://api.host/api ACCESS_TOKENS_FILE=./tokens.txt \
 *          CONNECTIONS=20000 RAMP_MS=120000 HOLD_MS=300000 node socketio-storm.mjs
 *   Smoke: SMOKE=1 CONNECTIONS=500 node socketio-storm.mjs   (no backend needed)
 *
 * Requires `socket.io-client` (and, for SMOKE, `socket.io`) resolvable from the
 * run directory. See README.md.
 */
import http from 'node:http';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { io } from 'socket.io-client';

const SMOKE = process.env.SMOKE === '1';
const CONNECTIONS = Number(process.env.CONNECTIONS || (SMOKE ? 200 : 5000));
const RAMP_MS = Number(process.env.RAMP_MS || (SMOKE ? 1500 : 60000));
const HOLD_MS = Number(process.env.HOLD_MS || (SMOKE ? 3000 : 60000));
const RECONNECT_STORM = process.env.RECONNECT_STORM !== '0';
const NAMESPACE = '/inbox';

const API_BASE = (process.env.API_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
const SOCKET_ORIGIN = API_BASE.replace(/\/api$/, '');
const TOKENS = loadTokens();

/** Round-robin access tokens (one per line in ACCESS_TOKENS_FILE, or ACCESS_TOKEN). */
function loadTokens() {
  const file = process.env.ACCESS_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return process.env.ACCESS_TOKEN ? [process.env.ACCESS_TOKEN] : [];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

/** Mint a short-lived inbox socket ticket from a JWT access token (real mode). */
async function mintTicket(token) {
  const res = await fetch(`${API_BASE}/connect/inbox/realtime/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ticket mint failed: ${res.status}`);
  const body = await res.json();
  // Tolerate a `{ data: { ticket } }` response envelope or a bare `{ ticket }`.
  return body?.data?.ticket ?? body?.ticket;
}

const stats = {
  attempted: 0,
  connected: 0,
  failed: 0,
  handshakeMs: [],
  reconnects: 0,
  messages: 0,
};

/**
 * Open one socket. In real mode the `auth` callback mints a fresh ticket on
 * every (re)connect (mirrors the web client + stresses the mint endpoint). In
 * smoke mode it connects to the local throwaway server with no auth.
 */
function openSocket(origin, token) {
  const startedAt = performance.now();
  stats.attempted += 1;
  const socket = io(origin + NAMESPACE, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    forceNew: true,
    ...(SMOKE
      ? {}
      : {
          auth: (cb) => {
            mintTicket(token)
              .then((ticket) => cb({ ticket }))
              .catch(() => cb({ ticket: '' }));
          },
        }),
  });
  let firstConnect = true;
  socket.on('connect', () => {
    if (firstConnect) {
      firstConnect = false;
      stats.connected += 1;
      stats.handshakeMs.push(performance.now() - startedAt);
    } else {
      stats.reconnects += 1;
    }
  });
  socket.on('connect_error', () => {
    if (firstConnect) stats.failed += 1;
  });
  socket.on('inbox:message', () => {
    stats.messages += 1;
  });
  return socket;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSmokeServer() {
  const { Server } = await import('socket.io');
  const httpServer = http.createServer();
  const ioServer = new Server(httpServer, { cors: { origin: true } });
  // Accept any connection on /inbox; emit a message to everyone periodically so
  // the harness exercises the receive path too.
  ioServer.of(NAMESPACE).on('connection', () => {});
  const timer = setInterval(() => {
    ioServer.of(NAMESPACE).emit('inbox:message', { threadId: 't', seq: 1, body: 'ping' });
  }, 500);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  return {
    origin: `http://localhost:${port}`,
    stop: () => {
      clearInterval(timer);
      ioServer.close();
      httpServer.close();
    },
  };
}

async function main() {
  if (!SMOKE && TOKENS.length === 0) {
    console.error(
      'No access tokens. Set ACCESS_TOKENS_FILE (one JWT per line) or ACCESS_TOKEN, or use SMOKE=1.',
    );
    process.exit(1);
  }

  const mode = SMOKE ? 'SMOKE (local throwaway server)' : `REAL -> ${SOCKET_ORIGIN}${NAMESPACE}`;
  console.log(
    `[storm] ${mode} | connections=${CONNECTIONS} ramp=${RAMP_MS}ms hold=${HOLD_MS}ms reconnectStorm=${RECONNECT_STORM}`,
  );

  let smoke = null;
  let origin = SOCKET_ORIGIN;
  if (SMOKE) {
    smoke = await startSmokeServer();
    origin = smoke.origin;
  }

  // Ramp connections in evenly over RAMP_MS so we measure a realistic climb.
  const sockets = [];
  const gap = CONNECTIONS > 0 ? RAMP_MS / CONNECTIONS : 0;
  for (let i = 0; i < CONNECTIONS; i += 1) {
    sockets.push(openSocket(origin, TOKENS[i % Math.max(1, TOKENS.length)]));
    if (gap >= 1) await sleep(gap);
  }

  await sleep(HOLD_MS);

  if (RECONNECT_STORM) {
    console.log('[storm] reconnect storm: dropping all sockets at once...');
    sockets.forEach((s) => s.io.engine?.close()); // hard transport close -> client auto-reconnects
    await sleep(Math.max(5000, HOLD_MS / 2));
  }

  const sorted = [...stats.handshakeMs].sort((a, b) => a - b);
  console.log('\n[storm] results');
  console.log(`  attempted        ${stats.attempted}`);
  console.log(
    `  connected        ${stats.connected} (${((stats.connected / stats.attempted) * 100).toFixed(2)}%)`,
  );
  console.log(`  failed           ${stats.failed}`);
  console.log(`  reconnects       ${stats.reconnects}`);
  console.log(`  msgs received    ${stats.messages}`);
  console.log(`  handshake p50    ${percentile(sorted, 50)} ms`);
  console.log(`  handshake p95    ${percentile(sorted, 95)} ms`);
  console.log(`  handshake p99    ${percentile(sorted, 99)} ms`);

  sockets.forEach((s) => s.close());
  if (smoke) smoke.stop();
  // Give sockets a tick to close, then exit.
  await sleep(250);
  process.exit(0);
}

main().catch((err) => {
  console.error('[storm] fatal:', err);
  process.exit(1);
});
