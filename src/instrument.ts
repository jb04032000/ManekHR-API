/**
 * Sentry instrumentation entry-point.
 *
 * MUST be imported as the very first line of `main.ts` so the Sentry SDK
 * patches HTTP / DB clients before any application code runs. The `env`
 * import below also triggers `dotenv/config`, ensuring SENTRY_DSN is
 * populated before this file evaluates.
 *
 * Empty `SENTRY_DSN` → SDK initialises in disabled state. All
 * `Sentry.captureException(...)` / `Sentry.startSpan(...)` calls become
 * safe no-ops, so existing code paths do not need conditional checks.
 */

import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { env } from './config/env';
import { redactPii } from './common/observability/scrub-pii';

Sentry.init({
  dsn: env.sentry.dsn,
  environment: env.sentry.environment,
  // Deterministic release (SENTRY_RELEASE -> npm_package_version). Empty -> omit.
  release: env.sentry.release || undefined,
  enabled: Boolean(env.sentry.dsn),
  integrations: [nodeProfilingIntegration()],
  // Env-overridable sample rate (default 0.1 prod / 1.0 dev). Lower as traffic ramps.
  tracesSampleRate: env.sentry.tracesSampleRate,
  profilesSampleRate: env.nodeEnv === 'production' ? 0.1 : 1.0,
  // Never attach default PII (IP, cookies, request bodies) automatically.
  sendDefaultPii: false,
  // Defence in depth: scrub PAN/Aadhaar/bank/secret-shaped data from EVERY event
  // and transaction before it leaves the process (payroll data + DPDP). See
  // common/observability/scrub-pii.ts. Empty DSN already no-ops the whole SDK.
  beforeSend(event) {
    return redactPii(event) as typeof event;
  },
  beforeSendTransaction(event) {
    return redactPii(event) as typeof event;
  },
});
