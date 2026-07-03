/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from '../http-exception.filter';

const host = (req: any, res: any) =>
  ({ switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) }) as any;

const mockRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = vi.fn((s: number) => {
    res.statusCode = s;
    return res;
  });
  res.json = vi.fn((b: any) => {
    res.body = b;
    return res;
  });
  return res;
};

describe('HttpExceptionFilter (structured failure logging + response shape)', () => {
  let filter: HttpExceptionFilter;
  let warnSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    const logger = (filter as any).logger;
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('logs a structured 4xx line before responding and preserves the response body', () => {
    const req: any = { method: 'POST', route: { path: '/api/auth/login' }, requestId: 'r1' };
    const res = mockRes();

    filter.catch(new ForbiddenException('Forbidden'), host(req, res));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0];
    expect(line).toContain('POST');
    expect(line).toContain('/api/auth/login');
    expect(line).toContain('403');
    // existing response contract unchanged
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 403 } });
  });

  it('promotes the app code into the log line and the response extra', () => {
    const req: any = { method: 'POST', route: { path: '/api/sessions' }, requestId: 'r2' };
    const res = mockRes();

    filter.catch(
      new HttpException({ message: 'too many', code: 'SESSION_LIMIT_REACHED' }, 409),
      host(req, res),
    );

    expect(warnSpy.mock.calls[0][0]).toContain('SESSION_LIMIT_REACHED');
    expect(res.body).toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
  });

  it('preserves the pre-shaped {success:false} short-circuit body', () => {
    const req: any = { method: 'GET', route: { path: '/api/x' }, requestId: 'r3' };
    const res = mockRes();
    const preShaped = { success: false, error: { code: 400, message: 'custom' } };

    filter.catch(new HttpException(preShaped, 400), host(req, res));

    expect(res.body).toEqual(preShaped);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs 5xx HttpExceptions at error level', () => {
    const req: any = { method: 'GET', route: { path: '/api/x' }, requestId: 'r4' };
    const res = mockRes();

    filter.catch(new HttpException('boom', 500), host(req, res));

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not double-log a request already logged for this request id', () => {
    const req: any = { method: 'GET', route: { path: '/api/x' }, requestId: 'r5' };
    const res = mockRes();

    filter.catch(new ForbiddenException('a'), host(req, res));
    filter.catch(new ForbiddenException('b'), host(req, res));

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
