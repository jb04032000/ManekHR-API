/* eslint-disable */
/**
 * CrewRoster Connect global-search load test (launch gate — Search Verification).
 *
 * Proves the two latency SLOs from CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §2
 * under concurrent load at expected launch traffic by holding a fixed REQUEST RATE
 * (open model) and failing the run (k6 exits non-zero) if either SLO is breached —
 * so this doubles as a CI/pre-deploy gate, not just a report.
 *
 * Two tagged scenarios:
 *   - typeahead   GET /connect/search?q=<prefix>&type=all&limit=5
 *                 SLO: http_req_duration{scenario:typeahead}  p(95) < 300ms
 *   - fullResults GET /connect/search?q=<term>&type=<vertical>&limit=25
 *                 SLO: http_req_duration{scenario:fullResults} p(95) < 1000ms
 *
 * PER-USER RATE LIMIT (SRCH-PERF-1): GET /connect/search is rate-limited per
 * authenticated USER (120 req/min/user), not per IP. A single token driven at
 * the launch arrival rates below would self-429 — the limit correctly blocks one
 * user from flooding the engine — and the 429s would both fail the error-rate
 * threshold and pollute the latency SLO with throttled responses. So for a
 * realistic multi-user load that measures latency cleanly, supply a POOL of
 * tokens via ACCESS_TOKENS (comma-separated, ideally >= ceil(TA_RATE/2) distinct
 * users); the script rotates them per VU so no single user crosses the cap. A
 * single ACCESS_TOKEN still works for a no-rate-limit smoke or a low-rate run
 * (keep the per-token rate under ~2 req/s).
 *
 * RUN COMMAND (against STAGING — never production; this test only reads, but it
 * exercises Meilisearch + Mongo concurrently):
 *
 *   k6 run \
 *     -e API_BASE=https://staging-api.crewroster.app/api \
 *     -e ACCESS_TOKENS=<jwt-user-1>,<jwt-user-2>,...,<jwt-user-N> \
 *     -e TA_RATE=80 \
 *     -e FR_RATE=30 \
 *     -e DURATION_RAMP=1m \
 *     -e DURATION_HOLD=5m \
 *     load-test/k6-connect-search.js
 *
 * Environment variables (all optional — defaults favour a PR smoke run):
 *   API_BASE         REST base URL including /api (no trailing slash)
 *   ACCESS_TOKENS    Comma-separated pool of valid Connect-user JWTs (rotated
 *                    per VU so the per-user 120/min cap is never hit). PREFERRED
 *                    for any real-rate run. Falls back to ACCESS_TOKEN.
 *   ACCESS_TOKEN     A single valid JWT (smoke / low-rate runs only — see the
 *                    PER-USER RATE LIMIT note above).
 *   TA_RATE          Typeahead target requests/second  (default 40)
 *   FR_RATE          Full-results target requests/second (default 15)
 *   DURATION_RAMP    Ramp-up stage duration (default '30s')
 *   DURATION_HOLD    Steady-state hold duration (default '2m')
 *   TA_QUERIES       Comma-separated typeahead prefix strings (default built-in list)
 *   FR_QUERIES       Comma-separated full-search terms  (default built-in list)
 *   FR_TYPES         Comma-separated ConnectSearchType values to rotate (default all)
 *
 * Two-tier strategy:
 *   PR smoke   — low rates (TA_RATE=10, FR_RATE=5, DURATION_HOLD=1m) — quick gate.
 *   Pre-deploy — the rates above (~5–8m) — the real SLO proof.
 *
 * NOTE ON ROUTES: The endpoint defaults match the routes mapped at
 * `search.controller.ts` GET /connect/search. Override via env if your build differs.
 * Verify path shape before a real run (the default `?q=&type=&limit=` param names
 * mirror the SearchQueryDto in `src/modules/connect/search/dto/search-query.dto.ts`).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = (__ENV.API_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
// Token POOL (SRCH-PERF-1): rotate distinct users so the per-user 120/min cap is
// never hit at launch arrival rates. ACCESS_TOKENS (comma-separated) is preferred;
// a single ACCESS_TOKEN is the smoke / low-rate fallback.
const TOKENS = (function () {
  const pool = (__ENV.ACCESS_TOKENS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (pool.length > 0) return pool;
  const single = __ENV.ACCESS_TOKEN || '';
  return single ? [single] : [];
})();
const SEARCH_PATH = __ENV.SEARCH_PATH || '/connect/search';

const TA_RATE = Number(__ENV.TA_RATE || 40);
const FR_RATE = Number(__ENV.FR_RATE || 15);
const RAMP = __ENV.DURATION_RAMP || '30s';
const HOLD = __ENV.DURATION_HOLD || '2m';

// Representative typeahead prefixes (textile / textile-industry vocabulary in the
// target locale — short prefixes that simulate letter-by-letter search-as-you-type).
const TA_QUERIES_DEFAULT = [
  'zar',
  'sa',
  'su',
  'kar',
  'emb',
  'wea',
  'stu',
  'fab',
  'bro',
  'han',
  'aar',
  'kan',
  'bat',
  'ban',
  'jac',
  'chi',
  'gaj',
  'res',
  'tai',
  'pri',
];

// Representative full-result queries (mix of verticals and real textile vocabulary).
const FR_QUERIES_DEFAULT = [
  'zari saree',
  'embroidery karigar surat',
  'handloom weaving',
  'job karigar wanted',
  'saree designer',
  'zardozi',
  'bandhani fabric',
  'kanjivaram silk',
  'block print',
  'open to work surat',
  'tailor job',
  'embroidery machine',
  'gota work',
  'resham zari',
];

const FR_TYPES_DEFAULT = ['all', 'people', 'listings', 'jobs', 'posts'];

function parseList(env, defaults) {
  if (!env) return defaults;
  const parsed = env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : defaults;
}

const taQueries = parseList(__ENV.TA_QUERIES, TA_QUERIES_DEFAULT);
const frQueries = parseList(__ENV.FR_QUERIES, FR_QUERIES_DEFAULT);
const frTypes = parseList(__ENV.FR_TYPES, FR_TYPES_DEFAULT);

// ── Per-scenario metrics ──────────────────────────────────────────────────────

const tTypeahead = new Trend('cs_typeahead_ms', true);
const tFullResults = new Trend('cs_full_results_ms', true);
const taErrors = new Rate('cs_typeahead_errors');
const frErrors = new Rate('cs_full_results_errors');
const taRequests = new Counter('cs_typeahead_requests');
const frRequests = new Counter('cs_full_results_requests');

// ── Scenarios ─────────────────────────────────────────────────────────────────

function buildScenarios() {
  const stages = (target) => [
    { target: Math.max(1, Math.round(target / 4)), duration: RAMP },
    { target, duration: HOLD },
    { target: 0, duration: '15s' },
  ];

  const arrival = (rate, exec, vusFactor = 0.5) => ({
    executor: 'ramping-arrival-rate',
    exec,
    startRate: Math.max(1, Math.round(rate / 4)),
    timeUnit: '1s',
    preAllocatedVUs: Math.max(10, Math.round(rate * vusFactor)),
    maxVUs: Math.max(40, rate * 3),
    stages: stages(rate),
  });

  return {
    typeahead: arrival(TA_RATE, 'typeaheadJourney', 0.5),
    fullResults: arrival(FR_RATE, 'fullResultsJourney', 1),
  };
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: {
    // THE pass/fail contract — k6 exits non-zero on breach (the CI gate).
    // Typeahead SLO: p95 < 300ms (CONNECT-SEARCH-VERIFICATION-CHECKLIST.md §2).
    'http_req_duration{scenario:typeahead}': ['p(95)<300'],
    // Full-results SLO: p95 < 1000ms (checklist §2).
    'http_req_duration{scenario:fullResults}': ['p(95)<1000'],
    // Global safety net — catches regressions not in the tagged scenarios.
    http_req_duration: ['p(99)<2000'],
    // Error-rate guard: if the endpoint returns 5xx at >2% the scenario is broken.
    http_req_failed: ['rate<0.02'],
    cs_typeahead_errors: ['rate<0.02'],
    cs_full_results_errors: ['rate<0.02'],
  },
};

// ── Validation ────────────────────────────────────────────────────────────────

export function setup() {
  if (TOKENS.length === 0) {
    throw new Error(
      'Set -e ACCESS_TOKENS=<jwt1,jwt2,...> (preferred) or -e ACCESS_TOKEN=<jwt>. ' +
        'The search endpoint requires authentication.',
    );
  }
  // Smoke-validate the endpoint is reachable with a single cheap probe.
  const probe = http.get(`${API_BASE}${SEARCH_PATH}?q=zari&type=all&limit=5`, {
    headers: authHeaders(TOKENS[0]),
    tags: { scenario: 'setup-probe' },
  });
  if (probe.status === 0) {
    throw new Error(
      `Search endpoint unreachable at ${API_BASE}${SEARCH_PATH} — is the server running?`,
    );
  }
  if (probe.status === 401) {
    throw new Error('ACCESS_TOKEN rejected (401). Provide a valid, unexpired JWT.');
  }
}

// ── Journey functions ─────────────────────────────────────────────────────────

export function typeaheadJourney() {
  // Rotate through the representative prefix list deterministically so the
  // distribution is stable across VUs (not random — deterministic ensures the
  // same query set is covered in both smoke and full runs).
  const q = taQueries[(__VU + __ITER) % taQueries.length];
  const url = `${API_BASE}${SEARCH_PATH}?q=${encodeURIComponent(q)}&type=all&limit=5`;

  const res = http.get(url, {
    headers: authHeaders(pickToken()),
    tags: { scenario: 'typeahead', q_len: String(q.length) },
  });

  tTypeahead.add(res.timings.duration);
  taRequests.add(1);

  const ok = check(res, {
    'typeahead 2xx': (r) => r.status >= 200 && r.status < 300,
    'typeahead has results key': (r) => {
      try {
        const body = JSON.parse(r.body);
        // The search envelope always returns a `groups` or `results` key,
        // even for a blank result (CONNECT-SEARCH-EXPANSION-PLAN.md §4).
        return 'results' in body || 'groups' in body;
      } catch {
        return false;
      }
    },
  });

  taErrors.add(!ok || res.status >= 400);
}

export function fullResultsJourney() {
  const q = frQueries[(__VU + __ITER) % frQueries.length];
  const type = frTypes[(__VU + __ITER) % frTypes.length];
  const url = `${API_BASE}${SEARCH_PATH}?q=${encodeURIComponent(q)}&type=${type}&limit=25`;

  const res = http.get(url, {
    headers: authHeaders(pickToken()),
    tags: { scenario: 'fullResults', type, q_len: String(q.length) },
  });

  tFullResults.add(res.timings.duration);
  frRequests.add(1);

  const ok = check(res, {
    'full-results 2xx': (r) => r.status >= 200 && r.status < 300,
    'full-results has type field': (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.type === 'string';
      } catch {
        return false;
      }
    },
  });

  frErrors.add(!ok || res.status >= 400);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Rotate through the token pool deterministically (per VU + iteration) so load
// is spread across distinct users and no single user trips the 120/min/user cap.
function pickToken() {
  return TOKENS[(__VU + __ITER) % TOKENS.length];
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// Machine-readable summary for CI artefacts + human summary on stdout.
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'search-summary.json': JSON.stringify(data, null, 2),
  };
}
