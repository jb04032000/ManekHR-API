/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError, lastValueFrom } from 'rxjs';
import { ForbiddenException } from '@nestjs/common';
import { LoggingInterceptor } from '../logging.interceptor';

const ctx = (req: any, res: any) =>
  ({
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  }) as any;

describe('LoggingInterceptor (structured request logger)', () => {
  let interceptor: LoggingInterceptor;
  let logSpy: any;
  let warnSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    const logger = (interceptor as any).logger;
    logSpy = vi.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('logs a success line at log level with method, route template and status', async () => {
    const req: any = {
      method: 'GET',
      route: { path: '/api/workspaces/:wsId/team' },
      requestId: 'r1',
      requestStartedAt: Date.now(),
      user: { sub: 'u1' },
      params: { wsId: 'w1' },
    };
    const res: any = { statusCode: 200 };
    const next = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(ctx(req, res), next as any));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0];
    expect(line).toContain('GET');
    expect(line).toContain('/api/workspaces/:wsId/team');
    expect(line).toContain('r1');
  });

  it('logs an error line at warn level for a 4xx and captures the app code', async () => {
    const req: any = {
      method: 'POST',
      route: { path: '/api/x' },
      requestId: 'r2',
      requestStartedAt: Date.now(),
    };
    const res: any = { statusCode: 200 };
    const err = new ForbiddenException({ message: 'no', code: 'NO_PERMISSION' });
    const next = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx(req, res), next as any))).rejects.toBe(
      err,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('NO_PERMISSION');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs at error level for a non-HttpException (treated as 500) and re-throws', async () => {
    const req: any = {
      method: 'GET',
      route: { path: '/api/x' },
      requestStartedAt: Date.now(),
    };
    const res: any = { statusCode: 200 };
    const err = new Error('boom');
    const next = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx(req, res), next as any))).rejects.toBe(
      err,
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
