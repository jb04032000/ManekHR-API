/**
 * Per-request ambient context backed by Node's AsyncLocalStorage.
 *
 * Set once by `common/middleware/request-context.middleware.ts` at the very
 * start of every request and read by anything that wants the correlation id
 * WITHOUT threading it through call signatures — e.g. a service-layer
 * `Logger` line can call `getRequestId()` to tag itself.
 *
 * The id is ALSO attached directly to the Express request (`req.requestId`) by
 * the middleware, so the request logger + exception filter (which always hold
 * `req`) read it from there and never depend on this store being intact. This
 * store is the convenience path for code that does not have `req` in hand.
 *
 * Links to: request-context.middleware.ts (writer), request-log.ts (the
 * structured logger that stamps `reqId`).
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  /** Correlation id for the in-flight request (inbound X-Request-Id or generated). */
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` (and everything it awaits) inside a request context. The middleware
 * wraps `next()` with this so the whole downstream chain — guards,
 * interceptors, handler, exception filters — shares the same correlation id.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request context, or undefined when called outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The active correlation id, or undefined when called outside a request. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
