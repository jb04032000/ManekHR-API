/**
 * OpenTelemetry instrumentation entry-point.
 *
 * MUST be imported as the very first line of `main.ts` (before
 * `./instrument` for Sentry) so the OTel auto-instrumentations patch
 * HTTP / Mongo / Redis clients before any application module is loaded.
 *
 * Empty `OTEL_EXPORTER_OTLP_ENDPOINT` → SDK initialises with no exporter
 * registered. Spans created via `trace.getTracer(...).startActiveSpan(...)`
 * still execute (callbacks run, attributes set) but are never exported,
 * so the call sites stay zero-cost in dev / tests when no collector is
 * configured. Mirrors the Sentry empty-DSN safe-no-op pattern.
 *
 * Phase 3.5 W4 — auth pilot. Phase 4 extends span emission to other
 * modules without touching this file.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { env } from '../config/env';

const enabled = Boolean(env.otel.endpoint);

const exporter = enabled
  ? new OTLPTraceExporter({
      url: env.otel.endpoint,
      headers: parseHeaders(env.otel.headers),
    })
  : undefined;

export const sdk = new NodeSDK({
  // `NodeSDK` builds the `service.name` resource attribute internally from
  // `serviceName` — using its own bundled, version-matched
  // `@opentelemetry/resources`. Avoids importing that package directly (it is
  // not a declared dependency, and its `resourceFromAttributes` factory only
  // exists in the 2.x line, while `sdk-node@0.55` pins `resources@1.27`).
  serviceName: env.otel.serviceName,
  traceExporter: exporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Filesystem auto-traces are noisy and not actionable for an HTTP
      // service. Keep them off by default; Phase 4 can enable selectively
      // when a perf investigation needs them.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

if (enabled) {
  sdk.start();
}

function parseHeaders(raw: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}
