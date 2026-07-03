import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import {
  emitRequestLog,
  extractAppCode,
  extractUserId,
  extractWorkspaceId,
  routeTemplate,
} from '../logging/request-log';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  // Same context tag as the request-logging interceptor so success + failure
  // lines read as one stream.
  private readonly logger = new Logger('HTTP');

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    // Structured failure line BEFORE responding (Connect startup audit —
    // Finding 2). This is the line that captures guard-thrown 4xx
    // (auth/permission/throttle/validation) which never reach the interceptor.
    // Idempotent: if the interceptor already logged this request (handler-thrown
    // errors), emitRequestLog is a no-op, so we never double-log. Sentry's
    // global filter still owns stack capture — this is the app-level audit line.
    emitRequestLog(this.logger, request, {
      method: request?.method,
      route: routeTemplate(request),
      status,
      durationMs: request?.requestStartedAt ? Date.now() - request.requestStartedAt : 0,
      reqId: request?.requestId,
      userId: extractUserId(request),
      workspaceId: extractWorkspaceId(request),
      code: extractAppCode(exception),
    });

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      if ('success' in exceptionResponse && (exceptionResponse as any).success === false) {
        response.status(status).json(exceptionResponse);
        return;
      }

      let message = exception.message;
      let details = undefined;

      if ('message' in exceptionResponse) {
        if (Array.isArray(exceptionResponse.message)) {
          details = exceptionResponse.message;
          message = details[0];
        } else {
          message = (exceptionResponse as any).message;
        }
      }

      // Preserve any extra fields the caller attached to the exception payload
      // (e.g. SESSION_LIMIT_REACHED's `code` + `activeSessions`, or
      // PLATFORM_RESTRICTED's `code`). Without this they get silently dropped
      // on serialization, breaking FE flows that branch on app-level codes.
      // Strip reserved fields then promote remaining keys to the response top
      // level, matching the convention used by FE consumers
      // (`errorData.code === 'PLATFORM_RESTRICTED'` etc.). `error.code` stays
      // the numeric HTTP status for backwards-compat.
      const {
        message: _omitMsg,
        statusCode: _omitStatus,
        error: _omitError,
        success: _omitSuccess,
        ...extra
      } = exceptionResponse as Record<string, unknown>;

      response.status(status).json({
        success: false,
        error: {
          code: status,
          message,
          details,
        },
        ...extra,
      });
    } else {
      response.status(status).json({
        success: false,
        error: {
          code: status,
          message: exception.message,
        },
      });
    }
  }
}
