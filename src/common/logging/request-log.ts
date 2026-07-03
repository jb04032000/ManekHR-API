/**
 * Structured per-request logging — the shared core used by BOTH the request
 * logger interceptor (`common/interceptors/logging.interceptor.ts`) and the
 * HTTP exception filter (`common/filters/http-exception.filter.ts`) so success
 * AND failure lines have the same shape.
 *
 * Why two callers share one emitter: in NestJS, GUARDS run BEFORE interceptors,
 * so guard-thrown errors (auth 401, permission 403, throttle 429, validation
 * 400) never reach the interceptor — only the exception filter sees them. The
 * interceptor covers success + handler/pipe errors (incl. raw 500s the
 * `@Catch(HttpException)` filter does not catch). To avoid double-logging the
 * handler-thrown HttpExceptions that BOTH observe, `emitRequestLog` is
 * idempotent per request via a symbol flag on `req`.
 *
 * No PII: only `userId`/`workspaceId` ids (Mongo ObjectIds, the same values
 * used as PostHog distinct-id / OTel attributes per repo rules) and the app
 * error `code`. Never logs emails, phones, tokens, or bodies. Route is the
 * matched template (`/api/workspaces/:wsId/...`), never the raw URL with ids.
 *
 * Format (json vs pretty) is chosen by `env.logging.format` — see config/env.ts.
 */
import { HttpException, Logger } from '@nestjs/common';
import { env } from '../../config/env';

export interface RequestLogFields {
  method: string;
  /** Route template with :params — never a raw URL carrying concrete ids. */
  route: string;
  status: number;
  durationMs: number;
  reqId?: string;
  userId?: string;
  workspaceId?: string;
  /** App-level error code (e.g. SESSION_LIMIT_REACHED) — present on failures only. */
  code?: string;
}

// Per-request idempotency marker. Set after the first emit so the interceptor
// and the exception filter never both log the same request. Symbol (not a
// string key) so it can't collide with anything else hung off the request.
const LOG_EMITTED = Symbol('crRequestLogEmitted');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NUMERIC_RE = /^\d+$/;

/**
 * Collapse concrete id path segments to `:id` so the fallback route label never
 * leaks identifiers (used only when no matched route template is available).
 */
export function sanitizePath(path: string): string {
  if (!path) return path;
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (OBJECT_ID_RE.test(seg) || UUID_RE.test(seg) || NUMERIC_RE.test(seg)) {
        return ':id';
      }
      return seg;
    })
    .join('/');
}

/**
 * The route template for a request. Express populates `req.route.path` (the
 * registered pattern with :params) once the router matches; we prefer that.
 * Falls back to a sanitized url for unmatched routes (e.g. 404s) so we still
 * avoid emitting raw ids.
 */
export function routeTemplate(req: any): string {
  const routePath = req?.route?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    const base = typeof req?.baseUrl === 'string' ? req.baseUrl : '';
    return `${base}${routePath}`;
  }
  const raw = String(req?.originalUrl ?? req?.url ?? '').split('?')[0];
  return sanitizePath(raw);
}

/** The app-level string `code` carried on an HttpException payload, if any. */
export function extractAppCode(exception: unknown): string | undefined {
  if (exception instanceof HttpException) {
    const resp = exception.getResponse();
    if (resp && typeof resp === 'object' && 'code' in resp) {
      const code = (resp as Record<string, unknown>).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/** Authenticated user id (JwtStrategy puts the Mongo id on `req.user.sub`). */
export function extractUserId(req: any): string | undefined {
  const sub = req?.user?.sub;
  return typeof sub === 'string' ? sub : undefined;
}

/** Tenant id from the canonical `:wsId` route param (or `:workspaceId`). */
export function extractWorkspaceId(req: any): string | undefined {
  const ws = req?.params?.wsId ?? req?.params?.workspaceId;
  return typeof ws === 'string' ? ws : undefined;
}

/** log for <400, warn for 4xx, error for 5xx (and anything >=500). */
export function levelForStatus(status: number): 'log' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'log';
}

/** Render one structured log line in the requested format. */
export function formatRequestLog(fields: RequestLogFields, pretty: boolean): string {
  if (pretty) {
    const parts = [
      `${fields.method} ${fields.route} ${fields.status} ${fields.durationMs}ms`,
      `reqId=${fields.reqId ?? '-'}`,
      `user=${fields.userId ?? '-'}`,
      `ws=${fields.workspaceId ?? '-'}`,
    ];
    if (fields.code) parts.push(`code=${fields.code}`);
    return parts.join(' ');
  }

  // JSON: drop undefined optionals so lines stay compact and only carry signal.
  const obj: Record<string, unknown> = {
    reqId: fields.reqId,
    method: fields.method,
    route: fields.route,
    status: fields.status,
    durationMs: fields.durationMs,
  };
  if (fields.userId !== undefined) obj.userId = fields.userId;
  if (fields.workspaceId !== undefined) obj.workspaceId = fields.workspaceId;
  if (fields.code !== undefined) obj.code = fields.code;
  if (fields.reqId === undefined) delete obj.reqId;
  return JSON.stringify(obj);
}

/**
 * Emit one structured request line at the level matching the status. Idempotent
 * per request: the first call for a given `req` logs and flags it; later calls
 * (the other of interceptor/filter for the same error) are no-ops. Pass
 * `req = undefined` only for contexts with no request object (then no dedup).
 */
export function emitRequestLog(logger: Logger, req: any, fields: RequestLogFields): void {
  if (req) {
    if (req[LOG_EMITTED]) return;
    req[LOG_EMITTED] = true;
  }
  const line = formatRequestLog(fields, env.logging.format === 'pretty');
  logger[levelForStatus(fields.status)](line);
}
