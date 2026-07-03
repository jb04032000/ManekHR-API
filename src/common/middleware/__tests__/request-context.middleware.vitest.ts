/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi } from 'vitest';
import { requestContextMiddleware } from '../request-context.middleware';
import { getRequestId } from '../../logging/request-context';

const mockRes = () => ({ setHeader: vi.fn() }) as any;

describe('requestContextMiddleware', () => {
  it('generates a request id when none is supplied and echoes it on the response', () => {
    const req: any = { headers: {} };
    const res = mockRes();
    requestContextMiddleware(req, res, () => undefined);

    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    expect(typeof req.requestStartedAt).toBe('number');
  });

  it('reuses a valid inbound X-Request-Id', () => {
    const req: any = { headers: { 'x-request-id': 'inbound-123' } };
    const res = mockRes();
    requestContextMiddleware(req, res, () => undefined);

    expect(req.requestId).toBe('inbound-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'inbound-123');
  });

  it('rejects a malformed / unsafe inbound id and generates a safe one', () => {
    const req: any = { headers: { 'x-request-id': 'bad id with spaces \n newline' } };
    const res = mockRes();
    requestContextMiddleware(req, res, () => undefined);

    expect(req.requestId).not.toContain(' ');
    expect(req.requestId).not.toContain('\n');
    expect(req.requestId.length).toBeGreaterThan(0);
  });

  it('rejects an over-long inbound id (log-injection guard)', () => {
    const req: any = { headers: { 'x-request-id': 'a'.repeat(500) } };
    const res = mockRes();
    requestContextMiddleware(req, res, () => undefined);

    expect(req.requestId.length).toBeLessThanOrEqual(200);
  });

  it('makes the id available via AsyncLocalStorage during next()', () => {
    const req: any = { headers: { 'x-request-id': 'ctx-1' } };
    const res = mockRes();
    let seen: string | undefined;
    requestContextMiddleware(req, res, () => {
      seen = getRequestId();
    });
    expect(seen).toBe('ctx-1');
  });

  it('calls next exactly once', () => {
    const req: any = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    requestContextMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
