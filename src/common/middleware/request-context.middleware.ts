/**
 * Correlation-id middleware (Connect startup audit — Finding 2).
 *
 * Runs first for EVERY request (registered via `app.use` in main.ts so it wraps
 * the entire chain, including the routes excluded from the /api prefix). It:
 *   1. reads an inbound `X-Request-Id` (validated) or generates a UUID,
 *   2. attaches it to `req.requestId` + stamps `req.requestStartedAt`,
 *   3. echoes it back on the `X-Request-Id` response header,
 *   4. runs the rest of the request inside an AsyncLocalStorage context so any
 *      downstream logger can read the id via `getRequestId()`.
 *
 * The id + start time feed the structured request logger
 * (`common/logging/request-log.ts`) used by the logging interceptor and the
 * HTTP exception filter, so every success/failure line is correlated and timed.
 */
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { runWithRequestContext } from '../logging/request-context';

const RESPONSE_HEADER = 'X-Request-Id';
// Accept only safe, bounded ids inbound. Rejecting spaces / control chars / very
// long values prevents log-injection and keeps the correlation id grep-friendly.
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request (inbound X-Request-Id or generated). */
      requestId?: string;
      /** Epoch ms when the request entered the app — used for durationMs. */
      requestStartedAt?: number;
    }
  }
}

function resolveRequestId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_ID_RE.test(trimmed) ? trimmed : randomUUID();
}

/**
 * Plain Express handler (no Nest DI needed) so it can be registered globally via
 * `app.use` and unit-tested as a pure function.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  req.requestId = requestId;
  req.requestStartedAt = Date.now();
  res.setHeader(RESPONSE_HEADER, requestId);
  runWithRequestContext({ requestId }, () => next());
}
