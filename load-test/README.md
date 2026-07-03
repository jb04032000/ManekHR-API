# Zari360 Connect — load-test harness

## Search SLO gate (`k6-connect-search.js`)

Proves the two search latency SLOs from `CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §2` under concurrent load. Two tagged scenarios — **typeahead** (p95 < 300ms) and **full-results** (p95 < 1s) — against `GET /connect/search`. Run against STAGING only (read-only; never production).

```bash
k6 run \
  -e API_BASE=https://staging-api.crewroster.app/api \
  -e ACCESS_TOKEN=<valid-connect-user-jwt> \
  -e TA_RATE=80 -e FR_RATE=30 \
  -e DURATION_RAMP=1m -e DURATION_HOLD=5m \
  load-test/k6-connect-search.js
```

PR smoke (quick): `TA_RATE=10 FR_RATE=5 DURATION_HOLD=1m` — ~2m total, same thresholds.

---

# Zari360 Connect Inbox — load-test harness (I6 launch gate)

The inbox is engineered to hold **100,000+ concurrent connected users**. This
folder is the harness that PROVES it before launch. It is the launch gate from
the milestone plan, run against a **deployed, scaled** environment — never
localhost (one machine cannot open 100k sockets; the OS runs out of ephemeral
ports near ~28k per source IP).

Two dimensions, two tools:

| Script               | Tool                      | Dimension it stresses                                            |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| `socketio-storm.mjs` | Node + `socket.io-client` | **Concurrent connections** + reconnect storm (the headline 100k) |
| `k6-inbox-send.js`   | [k6](https://k6.io)       | **Message-send throughput** (the Mongo write hot path)           |

> These are NOT run by the assistant — a real 100k test needs a fleet of
> load-generator machines against a deployed backend. The assistant has only
> smoke-validated `socketio-storm.mjs` locally (a few hundred connections
> against a throwaway in-process server). Treat the numbers below as the gate
> YOU run on real infrastructure.

---

## Capacity targets (from the plan — confirm with this test)

- ~15k sockets / Node instance -> ~10 instances for 100k + headroom.
- Busy-hour write load ~= 2,000 message-sends/sec ~= 4,000 Mongo write-ops/sec.
- Design headroom ~15-20k write-ops/sec (the trigger to shard `connect_messages`
  on `{ threadId: "hashed" }`).

## Pass / fail thresholds (tune to your SLOs)

- Socket handshake (ticket mint + connect): **p50 < 300 ms, p99 < 1.5 s** at target load.
- Connect success rate **>= 99.5%** during steady state; **>= 98%** through a reconnect storm.
- Message send (HTTP): **p95 < 400 ms** at 2,000 req/s.
- **Zero `seq` gaps** in the catch-up replay (correctness, not just speed).
- Gateway `getStats()` (see below) `droppedEmits` stays ~0; `rejectedConnections`
  only from the deliberate per-user cap, not from healthy clients.

---

## Prerequisites

1. **A deployed, scaled target** (multiple Node instances behind the L4
   sticky-session LB + RedisIoAdapter + a production-grade Mongo). Set
   `NEXT_PUBLIC_CONNECT_PHASE=7` is irrelevant here — this hits the API directly.
2. **A fleet of load-gen machines.** One box caps near ~25-28k sockets. For
   100k, run `socketio-storm.mjs` on **M machines × N connections** (e.g. 5 × 20k).
   Raise the OS fd limit on each: `ulimit -n 200000`.
3. **Test users + access tokens.** Pre-create N throwaway Connect users (the
   `seed:connect` personas are a start) and capture a JWT **access token** per
   user. The harness mints a short-lived socket ticket per (re)connect from that
   token, exactly like the web client.
4. **k6 installed** for the send test: https://k6.io/docs/get-started/installation/

## Observability during the run

The `/inbox` gateway exposes counters via `InboxGateway.getStats()`
(`activeConnections`, `distinctUsers`, `droppedEmits`, `rejectedConnections`).
Expose them on a tiny admin/health route, or read them per-instance, and watch
them alongside: Redis pub/sub CPU, Node event-loop lag, Mongo write-ops/sec, and
LB connection counts. There is no OTel metrics backend wired yet — these
counters + structured logs are the surface.

---

## Setup

```bash
cd load-test
npm i            # installs socket.io + socket.io-client (declared in package.json)
```

The command examples below use bash-style `VAR=value cmd`. On **Windows
PowerShell** that syntax is not valid — set the vars first with `$env:`:

```powershell
cd load-test
npm i
# smoke:
$env:SMOKE='1'; $env:CONNECTIONS='500'; node socketio-storm.mjs
# real run (vars then command on one line, separated by ;):
$env:API_BASE='https://api.your-host.com/api'; $env:ACCESS_TOKENS_FILE='.\tokens.txt'; $env:CONNECTIONS='20000'; node socketio-storm.mjs
# clear them after:  Remove-Item Env:SMOKE, Env:CONNECTIONS, Env:API_BASE, Env:ACCESS_TOKENS_FILE -ErrorAction SilentlyContinue
```

---

## Run: connection + reconnect storm

```bash
# Real run (per load-gen machine):
API_BASE=https://api.your-host.com/api \
ACCESS_TOKENS_FILE=./tokens.txt \
CONNECTIONS=20000 RAMP_MS=120000 HOLD_MS=300000 \
node load-test/socketio-storm.mjs

# Local smoke (no backend needed — boots a throwaway socket.io server):
SMOKE=1 CONNECTIONS=500 node load-test/socketio-storm.mjs
```

- `ACCESS_TOKENS_FILE` — one JWT access token per line; connections round-robin
  them. Falls back to a single `ACCESS_TOKEN` env if no file.
- `API_BASE` — the REST base (with `/api`); the socket origin is derived by
  stripping a trailing `/api` (mirrors the web client).
- `RECONNECT_STORM=0` to skip the mid-test mass disconnect/reconnect.

## Run: message-send throughput (k6)

```bash
k6 run \
  -e API_BASE=https://api.your-host.com/api \
  -e ACCESS_TOKEN=<jwt> \
  -e THREAD_ID=<an existing thread id the user is in> \
  -e RATE=2000 -e DURATION=5m \
  load-test/k6-inbox-send.js
```

`RATE` is target sends/sec (the busy-hour write load). The script also mints a
ticket per iteration to stress the mint endpoint. Use a tokens/threads CSV via
k6 `SharedArray` for multi-user realism (see comments in the script).

---

## What to do with the result

- **All green** -> flip `NEXT_PUBLIC_CONNECT_PHASE=7` and launch.
- **Handshake p99 climbs with connections** -> add Node instances (you are near
  the ~15k/instance ceiling) and/or flip the RedisIoAdapter to **Redis 7 sharded
  pub/sub** (one change in `redis-io.adapter.ts`, inherited by all gateways).
- **Mongo write-ops near headroom** -> enable sharding on `connect_messages`
  (`{ threadId: "hashed" }`, already shard-ready).
- **Event-loop lag on the socket nodes** -> split the gateways into a dedicated
  `realtime-main.ts` tier behind the sticky LB.

Re-run after each change; the harness is the gate, not a one-shot.
