/**
 * ADMS ingest load test — manual benchmark only (H6-CONTEXT D-07, D-08).
 *
 * Simulates 10 concurrent biometric devices pushing ATTLOG batches to the ADMS
 * ingest endpoint for 10 seconds. Reports req/s, latency percentiles, and error
 * counts. Verifies PERF-03: the endpoint handles 10 concurrent pushes without
 * 5xx errors and that dedup holds under concurrency.
 *
 * PRE-CONDITIONS
 *   1. Backend running locally (npm run start:dev) on http://localhost:3000
 *      (or set BASE_URL env var).
 *   2. A real workspace exists with attendanceIngestToken set — pass it via
 *      WS_TOKEN env var. If you use a bogus token the endpoint will still
 *      return 200 (ADMS protocol requires 200 regardless) but events will be
 *      silently discarded (see H6-RESEARCH Pitfall 4). The load test would
 *      complete with 0 errors but 0 new AttendanceEvent documents.
 *   3. autocannon@^8 installed as devDependency (see Plan H6-03 Task 1).
 *
 * USAGE
 *   cd zari360-backend
 *   WS_TOKEN=<real-token> node test/load/adms-ingest.js
 *
 *   Optional:
 *   BASE_URL=http://staging.example.com WS_TOKEN=<token> node test/load/adms-ingest.js
 *
 * SUCCESS CRITERIA
 *   - non2xx count == 0
 *   - errors count == 0
 *   - latency p99 < 1000 ms on a developer laptop (informational; tune as needed)
 *   - Post-run: db.attendanceevents.countDocuments({ wsId: <ws> }) increased by
 *     the dedup-resolved unique (deviceUserId, timestamp) pairs (one per line
 *     in `body`, not connections * duration * rate — dedup is the test).
 */

const autocannon = require('autocannon');

const WS_TOKEN = process.env.WS_TOKEN || 'test-token';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ATTLOG batch body: 3 punches from 3 distinct device users.
// Tab-separated: deviceUserId \t "YYYY-MM-DD HH:MM:SS" \t statusCode \t verifyCode
// Dedup key in the backend is (wsId, deviceSerial, deviceUserId, timestamp).
// Since this body repeats on every request, the backend MUST dedup under
// concurrency — verifying that is part of PERF-03's intent.
const body = [
  '1\t2024-01-15 09:00:00\t0\t1',
  '2\t2024-01-15 09:01:00\t0\t1',
  '3\t2024-01-15 09:02:00\t0\t1',
].join('\n');

const url = `${BASE_URL}/iclock/${WS_TOKEN}/cdata?table=ATTLOG`;

console.log(`[adms-ingest-load] POST ${url}`);
console.log(`[adms-ingest-load] 10 connections x 10s, body = ${body.length} bytes`);
console.log(`[adms-ingest-load] WS_TOKEN=${WS_TOKEN === 'test-token' ? '<default>' : '<custom>'}`);

autocannon(
  {
    url,
    connections: 10,
    duration: 10,
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  },
  (err, result) => {
    if (err) {
      console.error('[adms-ingest-load] autocannon error:', err);
      process.exit(1);
    }
    console.log(autocannon.printResult(result));
    if (result.non2xx > 0) {
      console.error(`[adms-ingest-load] FAIL: ${result.non2xx} non-2xx responses`);
      process.exit(2);
    }
    if (result.errors > 0) {
      console.error(`[adms-ingest-load] FAIL: ${result.errors} connection errors`);
      process.exit(3);
    }
    console.log('[adms-ingest-load] PASS: 0 non-2xx, 0 errors');
  },
);
