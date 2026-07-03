import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import {
  emitRequestLog,
  extractAppCode,
  extractUserId,
  extractWorkspaceId,
  routeTemplate,
} from '../logging/request-log';

/**
 * Structured per-request logger (Connect startup audit — Finding 2).
 *
 * Replaces the old success-only interceptor: now logs on BOTH success and
 * error with a uniform line (method, route TEMPLATE, status, durationMs, reqId,
 * userId/workspaceId, and on failure the app error `code`). warn for 4xx, error
 * for 5xx, log for success.
 *
 * Note on coverage: interceptors run AFTER guards, so guard-thrown errors
 * (auth/permission/throttle/validation) never reach here — those are logged by
 * `HttpExceptionFilter`. This interceptor covers successes plus errors thrown
 * inside the handler/pipes (including raw non-HttpException 500s that the
 * `@Catch(HttpException)` filter does not catch). The shared `emitRequestLog`
 * is idempotent per request, so the one error case both observe (a
 * handler-thrown HttpException) is logged exactly once.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // Prefer the middleware's start stamp so durationMs matches the filter's
    // measure; fall back to now if the middleware somehow did not run.
    const start = req.requestStartedAt ?? Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          emitRequestLog(this.logger, req, {
            method: req.method,
            route: routeTemplate(req),
            status: res.statusCode,
            durationMs: Date.now() - start,
            reqId: req.requestId,
            userId: extractUserId(req),
            workspaceId: extractWorkspaceId(req),
          });
        },
        error: (err: unknown) => {
          const status = err instanceof HttpException ? err.getStatus() : 500;
          emitRequestLog(this.logger, req, {
            method: req.method,
            route: routeTemplate(req),
            status,
            durationMs: Date.now() - start,
            reqId: req.requestId,
            userId: extractUserId(req),
            workspaceId: extractWorkspaceId(req),
            code: extractAppCode(err),
          });
        },
      }),
    );
  }
}
