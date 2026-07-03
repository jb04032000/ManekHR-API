/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi } from 'vitest';
import { HttpException, BadRequestException } from '@nestjs/common';
import {
  sanitizePath,
  routeTemplate,
  extractAppCode,
  extractUserId,
  extractWorkspaceId,
  formatRequestLog,
  levelForStatus,
  emitRequestLog,
} from '../request-log';

describe('sanitizePath', () => {
  it('replaces Mongo ObjectId segments with :id', () => {
    expect(sanitizePath('/api/workspaces/507f1f77bcf86cd799439011/team')).toBe(
      '/api/workspaces/:id/team',
    );
  });

  it('replaces numeric id segments with :id', () => {
    expect(sanitizePath('/api/invoices/12345')).toBe('/api/invoices/:id');
  });

  it('replaces UUID segments with :id', () => {
    expect(sanitizePath('/api/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/x/:id');
  });

  it('leaves normal path segments intact', () => {
    expect(sanitizePath('/api/auth/login')).toBe('/api/auth/login');
  });
});

describe('routeTemplate', () => {
  it('uses the matched route template (no concrete ids) when available', () => {
    const req = {
      route: { path: '/api/workspaces/:wsId/team' },
      originalUrl: '/api/workspaces/507f1f77bcf86cd799439011/team',
    };
    expect(routeTemplate(req)).toBe('/api/workspaces/:wsId/team');
  });

  it('prepends baseUrl when the route is mounted on a sub-router', () => {
    const req = { baseUrl: '/api', route: { path: '/health' } };
    expect(routeTemplate(req)).toBe('/api/health');
  });

  it('falls back to a sanitized url when no route matched (e.g. 404)', () => {
    const req = { originalUrl: '/api/unknown/507f1f77bcf86cd799439011?x=1' };
    expect(routeTemplate(req)).toBe('/api/unknown/:id');
  });
});

describe('extractAppCode', () => {
  it('returns the string code from an HttpException payload', () => {
    const ex = new HttpException({ message: 'no', code: 'SESSION_LIMIT_REACHED' }, 409);
    expect(extractAppCode(ex)).toBe('SESSION_LIMIT_REACHED');
  });

  it('returns undefined when the payload has no code', () => {
    expect(extractAppCode(new BadRequestException('bad'))).toBeUndefined();
  });

  it('returns undefined for a non-HttpException error', () => {
    expect(extractAppCode(new Error('boom'))).toBeUndefined();
  });
});

describe('extractUserId / extractWorkspaceId', () => {
  it('reads userId from req.user.sub', () => {
    expect(extractUserId({ user: { sub: 'u1' } })).toBe('u1');
  });

  it('reads workspaceId from req.params.wsId', () => {
    expect(extractWorkspaceId({ params: { wsId: 'w1' } })).toBe('w1');
  });

  it('falls back to req.params.workspaceId', () => {
    expect(extractWorkspaceId({ params: { workspaceId: 'w2' } })).toBe('w2');
  });

  it('returns undefined when absent', () => {
    expect(extractUserId({})).toBeUndefined();
    expect(extractWorkspaceId({})).toBeUndefined();
  });
});

describe('levelForStatus', () => {
  it('uses log for <400', () => expect(levelForStatus(200)).toBe('log'));
  it('uses warn for 4xx', () => expect(levelForStatus(404)).toBe('warn'));
  it('uses error for 5xx', () => expect(levelForStatus(500)).toBe('error'));
});

describe('formatRequestLog', () => {
  const fields = {
    method: 'GET',
    route: '/api/x',
    status: 200,
    durationMs: 5,
    reqId: 'r1',
    userId: 'u1',
    workspaceId: 'w1',
  };

  it('pretty mode renders a single human-readable line', () => {
    const line = formatRequestLog(fields, true);
    expect(line).toContain('GET /api/x 200 5ms');
    expect(line).toContain('reqId=r1');
    expect(line).toContain('user=u1');
    expect(line).toContain('ws=w1');
  });

  it('json mode renders a parseable object with the same fields', () => {
    const obj = JSON.parse(formatRequestLog(fields, false));
    expect(obj).toMatchObject({
      method: 'GET',
      route: '/api/x',
      status: 200,
      durationMs: 5,
      reqId: 'r1',
      userId: 'u1',
      workspaceId: 'w1',
    });
  });

  it('json mode omits undefined optionals and includes the app code on failure', () => {
    const obj = JSON.parse(
      formatRequestLog(
        {
          method: 'POST',
          route: '/api/auth/login',
          status: 401,
          durationMs: 2,
          reqId: 'r2',
          code: 'INVALID_CREDENTIALS',
        },
        false,
      ),
    );
    expect(obj).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect('userId' in obj).toBe(false);
    expect('workspaceId' in obj).toBe(false);
  });
});

describe('emitRequestLog', () => {
  const fakeLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

  it('dispatches to the level matching the status', () => {
    const ok = fakeLogger();
    emitRequestLog(ok, {}, { method: 'GET', route: '/x', status: 200, durationMs: 1 });
    expect(ok.log).toHaveBeenCalledTimes(1);

    const clientErr = fakeLogger();
    emitRequestLog(clientErr, {}, { method: 'GET', route: '/x', status: 404, durationMs: 1 });
    expect(clientErr.warn).toHaveBeenCalledTimes(1);

    const serverErr = fakeLogger();
    emitRequestLog(serverErr, {}, { method: 'GET', route: '/x', status: 500, durationMs: 1 });
    expect(serverErr.error).toHaveBeenCalledTimes(1);
  });

  it('is idempotent per request — logs once across repeated calls', () => {
    const logger = fakeLogger();
    const req: any = {};
    emitRequestLog(logger, req, { method: 'GET', route: '/x', status: 500, durationMs: 1 });
    emitRequestLog(logger, req, { method: 'GET', route: '/x', status: 500, durationMs: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('still logs when no request object is provided (no dedup target)', () => {
    const logger = fakeLogger();
    emitRequestLog(logger, undefined, { method: 'GET', route: '/x', status: 200, durationMs: 1 });
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
