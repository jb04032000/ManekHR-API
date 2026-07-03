import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestId, getRequestContext } from '../request-context';

describe('request-context (AsyncLocalStorage)', () => {
  it('exposes the request id within the context', () => {
    runWithRequestContext({ requestId: 'abc' }, () => {
      expect(getRequestId()).toBe('abc');
      expect(getRequestContext()).toEqual({ requestId: 'abc' });
    });
  });

  it('returns undefined outside any context', () => {
    expect(getRequestId()).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });

  it('preserves the context across async boundaries', async () => {
    await runWithRequestContext({ requestId: 'xyz' }, async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe('xyz');
    });
  });
});
