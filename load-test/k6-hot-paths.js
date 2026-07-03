/* eslint-disable */
/**
 * CrewRoster hot-path load test (launch readiness — Workstream F).
 *
 * Proves p95 < 400ms on the read hot paths at expected launch load (~50 companies
 * / a few hundred users) by holding a fixed REQUEST RATE (open model) and failing
 * the run (k6 exits non-zero) if any threshold is breached — so this doubles as a
 * CI/pre-deploy gate, not just a report.
 *
 * Covered hot paths (each its own tagged scenario; a scenario auto-disables if its
 * required id env is missing, so you can run a subset):
 *   - login            POST /auth/login                                  (auth)
 *   - dashboard        GET  /workspaces/:ws/statistics/dashboard         (read)
 *   - salary list      GET  /workspaces/:ws/salary?month&year            (read)
 *   - finance list     GET  /workspaces/:ws/finance/firms/:firm/sales/invoices (read)
 *   - attendance punch POST /me/attendance/punch                         (write)
 *
 * RUN (against STAGING — the punch + login scenarios WRITE data; never point this
 * at production):
 *
 *   k6 run \
 *     -e API_BASE=https://staging-api.crewroster.app/api \
 *     -e ACCESS_TOKEN=<owner/manager jwt> \
 *     -e WS_ID=<workspaceId> \
 *     -e FIRM_ID=<finance firmId> \
 *     -e MONTH=6 -e YEAR=2026 \
 *     -e READ_RATE=120 -e WRITE_RATE=15 -e DURATION_RAMP=2m -e DURATION_HOLD=5m \
 *     -e LT_EMAIL=loadtest@crewroster.app -e LT_PASSWORD=... \
 *     load-test/k6-hot-paths.js
 *
 * Two-tier strategy: a fast PR smoke (low rate, ~1-2m) and a full pre-deploy SLO
 * run (the rates above, ~10m). Use the same thresholds for both. See README.md.
 *
 * NOTE ON ROUTES/BODIES: paths + the punch body are env-overridable because the
 * exact shape can differ per build — verify against your API before a real run
 * (the defaults match the routes mapped in the launch perf analysis).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const API_BASE = (__ENV.API_BASE || 'http://localhost:3000/api').replace(/\/+$/, '');
const TOKEN = __ENV.ACCESS_TOKEN || '';
const WS_ID = __ENV.WS_ID || '';
const FIRM_ID = __ENV.FIRM_ID || '';
const MONTH = __ENV.MONTH || String(new Date().getMonth() + 1);
const YEAR = __ENV.YEAR || String(new Date().getFullYear());

const READ_RATE = Number(__ENV.READ_RATE || 60);
const WRITE_RATE = Number(__ENV.WRITE_RATE || 8);
const AUTH_RATE = Number(__ENV.AUTH_RATE || 5);
const RAMP = __ENV.DURATION_RAMP || '1m';
const HOLD = __ENV.DURATION_HOLD || '3m';

// Optional credentials for the login scenario (writes a session each call).
const LT_EMAIL = __ENV.LT_EMAIL || '';
const LT_PASSWORD = __ENV.LT_PASSWORD || '';

// Route templates (override via env if your build differs).
const PATHS = {
  login: __ENV.LOGIN_PATH || '/auth/login',
  dashboard: __ENV.DASHBOARD_PATH || `/workspaces/${WS_ID}/statistics/dashboard`,
  salary: __ENV.SALARY_PATH || `/workspaces/${WS_ID}/salary?month=${MONTH}&year=${YEAR}`,
  finance:
    __ENV.FINANCE_PATH || `/workspaces/${WS_ID}/finance/firms/${FIRM_ID}/sales/invoices?limit=20`,
  punch: __ENV.PUNCH_PATH || '/me/attendance/punch',
};

// Per-path latency trends (clearer than the global aggregate when one path drags).
const tDashboard = new Trend('hp_dashboard_ms', true);
const tSalary = new Trend('hp_salary_ms', true);
const tFinance = new Trend('hp_finance_ms', true);
const tPunch = new Trend('hp_punch_ms', true);
const tLogin = new Trend('hp_login_ms', true);
const readErr = new Rate('hp_read_errors');
const writeErr = new Rate('hp_write_errors');

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

// Build scenarios only for the paths whose ids are present.
function buildScenarios() {
  const s = {};
  const rampHold = (target) => [
    { target: Math.max(1, Math.round(target / 4)), duration: RAMP },
    { target, duration: HOLD },
    { target: 0, duration: '30s' },
  ];
  const arrival = (rate, exec, cls, vusFactor = 0.5) => ({
    executor: 'ramping-arrival-rate',
    exec,
    startRate: Math.max(1, Math.round(rate / 4)),
    timeUnit: '1s',
    preAllocatedVUs: Math.max(20, Math.round(rate * vusFactor)),
    maxVUs: Math.max(60, rate * 3),
    stages: rampHold(rate),
    tags: { class: cls },
  });

  if (WS_ID) {
    s.dashboard = arrival(READ_RATE, 'dashboardJourney', 'read');
    s.salary = arrival(Math.round(READ_RATE / 2), 'salaryJourney', 'read');
  }
  if (WS_ID && FIRM_ID) {
    s.finance = arrival(Math.round(READ_RATE / 2), 'financeJourney', 'read');
  }
  // Punch WRITES — only enable when explicitly opted in (PUNCH=1) to avoid
  // accidentally generating attendance data on a shared staging env.
  if (__ENV.PUNCH === '1') {
    s.punch = arrival(WRITE_RATE, 'punchJourney', 'write', 1);
  }
  if (LT_EMAIL && LT_PASSWORD) {
    s.login = arrival(AUTH_RATE, 'loginJourney', 'auth', 1);
  }
  return s;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: {
    // THE pass/fail contract — a breach exits k6 non-zero (the CI gate).
    http_req_duration: ['p(95)<400', 'p(99)<800'],
    'http_req_duration{class:read}': ['p(95)<400'],
    'http_req_duration{class:write}': ['p(95)<700'],
    'http_req_duration{class:auth}': ['p(95)<600'],
    http_req_failed: ['rate<0.01'],
    hp_read_errors: ['rate<0.01'],
    hp_write_errors: ['rate<0.02'],
  },
};

export function setup() {
  if (!TOKEN && !(LT_EMAIL && LT_PASSWORD)) {
    throw new Error(
      'Provide -e ACCESS_TOKEN=<jwt> (and -e WS_ID=...) and/or -e LT_EMAIL/-e LT_PASSWORD.',
    );
  }
  if (TOKEN && !WS_ID) {
    throw new Error('Set -e WS_ID=<workspaceId> so the read scenarios have a tenant to hit.');
  }
}

export function dashboardJourney() {
  const res = http.get(`${API_BASE}${PATHS.dashboard}`, {
    headers: authHeaders(),
    tags: { type: 'read', path: 'dashboard' },
  });
  tDashboard.add(res.timings.duration);
  readErr.add(res.status >= 400);
  check(res, { 'dashboard 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function salaryJourney() {
  const res = http.get(`${API_BASE}${PATHS.salary}`, {
    headers: authHeaders(),
    tags: { type: 'read', path: 'salary' },
  });
  tSalary.add(res.timings.duration);
  readErr.add(res.status >= 400);
  check(res, { 'salary 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function financeJourney() {
  const res = http.get(`${API_BASE}${PATHS.finance}`, {
    headers: authHeaders(),
    tags: { type: 'read', path: 'finance' },
  });
  tFinance.add(res.timings.duration);
  readErr.add(res.status >= 400);
  check(res, { 'finance 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function punchJourney() {
  // Body is intentionally minimal/overridable — adjust PUNCH_BODY to your DTO.
  const body = __ENV.PUNCH_BODY || JSON.stringify({ source: 'load-test' });
  const res = http.post(`${API_BASE}${PATHS.punch}`, body, {
    headers: authHeaders(),
    tags: { type: 'write', path: 'punch' },
  });
  tPunch.add(res.timings.duration);
  // A 409/422 (already punched / policy) is a valid business response, not a perf failure.
  writeErr.add(res.status >= 500);
  check(res, { 'punch not 5xx': (r) => r.status < 500 });
}

export function loginJourney() {
  const body = JSON.stringify({ email: LT_EMAIL, password: LT_PASSWORD });
  const res = http.post(`${API_BASE}${PATHS.login}`, body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'auth', path: 'login' },
  });
  tLogin.add(res.timings.duration);
  check(res, { 'login 2xx': (r) => r.status >= 200 && r.status < 300 });
}

// Machine-readable summary for CI artifacts + a human summary on stdout.
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data, null, 2),
  };
}
