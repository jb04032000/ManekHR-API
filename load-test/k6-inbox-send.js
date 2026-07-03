/* eslint-disable */
/**
 * Zari360 Connect Inbox -- message-send throughput load test (k6).
 *
 * Stresses the durable write hot path: mint a socket ticket, then POST a message
 * into a thread with a unique clientMsgId (the atomic seq-alloc + recipient
 * unread $inc + idempotent insert). Targets the busy-hour ~2,000 sends/sec to
 * confirm Mongo write headroom before the shard trigger.
 *
 *   k6 run -e API_BASE=https://api.host/api -e ACCESS_TOKEN=<jwt> \
 *          -e THREAD_ID=<thread the user is in> -e RATE=2000 -e DURATION=5m \
 *          load-test/k6-inbox-send.js
 *
 * Multi-user realism: replace the single ACCESS_TOKEN / THREAD_ID with a CSV
 * loaded via k6 SharedArray and pick a row per-iteration (see the commented
 * block below) so you are not hammering one thread / one user.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const API_BASE = (__ENV.API_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || '';
const THREAD_ID = __ENV.THREAD_ID || '';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '1m';

const ticketLatency = new Trend('inbox_ticket_ms', true);
const sendLatency = new Trend('inbox_send_ms', true);
const sendOk = new Rate('inbox_send_ok');
const sent = new Counter('inbox_sent');

export const options = {
  scenarios: {
    steady_send: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Pre-allocate generously; raise if k6 warns it is short of VUs.
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 2)),
      maxVUs: Math.max(200, RATE * 2),
    },
  },
  thresholds: {
    inbox_send_ms: ['p(95)<400'],
    inbox_send_ok: ['rate>0.995'],
    inbox_ticket_ms: ['p(95)<500'],
  },
};

function authHeaders() {
  return { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
}

export function setup() {
  if (!ACCESS_TOKEN || !THREAD_ID) {
    throw new Error('Set -e ACCESS_TOKEN=<jwt> and -e THREAD_ID=<thread id>.');
  }
}

export default function () {
  // 1) Mint a socket ticket (also part of the hot path the web client hits).
  const ticketRes = http.post(`${API_BASE}/connect/inbox/realtime/ticket`, null, {
    headers: authHeaders(),
  });
  ticketLatency.add(ticketRes.timings.duration);

  // 2) Send a message with a unique clientMsgId (idempotency key).
  const clientMsgId = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const body = JSON.stringify({ clientMsgId, body: `load test ${clientMsgId}` });
  const res = http.post(`${API_BASE}/connect/inbox/threads/${THREAD_ID}/messages`, body, {
    headers: authHeaders(),
  });

  sendLatency.add(res.timings.duration);
  const ok = check(res, { 'send 2xx': (r) => r.status >= 200 && r.status < 300 });
  sendOk.add(ok);
  if (ok) sent.add(1);

  // A 429 here is the rate limiter / quarantine doing its job, not a failure of
  // the send path -- exclude it from the success-rate SLO by checking explicitly.
  check(res, { 'not rate-limited': (r) => r.status !== 429 });

  sleep(0.1);
}

/*
// ---- Multi-user variant (recommended for a true gate) ----
// import { SharedArray } from 'k6/data';
// const rows = new SharedArray('users', () => JSON.parse(open('./users.json')));
//   // users.json: [{ "token": "<jwt>", "threadId": "<id>" }, ...]
// then per-iteration: const u = rows[(__VU + __ITER) % rows.length];
//   ... use u.token / u.threadId ...
*/
