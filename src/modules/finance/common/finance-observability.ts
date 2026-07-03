import { type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';

/**
 * Finance OpenTelemetry span helper. Mirrors `TeamService.withTeamSpan`
 * (Phase 5 W6) and `WorkspacesService.withWorkspaceSpan`: wraps a finance
 * service operation in an active span, tags attributes, sets OK on success,
 * and on error records the exception + sets ERROR status before rethrowing.
 *
 * Empty `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op (the SDK
 * starts with no exporter registered), so this never throws when telemetry is
 * unconfigured (same contract as the Team helper).
 *
 * Span naming convention: `finance.<verbNoun>` (e.g. `finance.postInvoice`).
 * Attribute convention: `userId` / `workspaceId` / `firmId` / `result`, never
 * raw PII (no full GSTIN / PAN / bank; use ids, last4, or amounts only).
 *
 * Provided as a standalone function (not a per-service method) so every finance
 * service (sale-invoice, credit-notes, and the Phase 2 consumers) shares one
 * implementation. Each service passes its own `trace.getTracer('finance')`.
 */
export async function withFinanceSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      span.setAttributes(attributes);
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
