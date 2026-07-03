/**
 * OQ-1 (auth-hardening) refresh-cookie helpers: set / clear / read the httpOnly
 * refresh-token cookie. Proves the cookie is httpOnly (XSS-safe), parses back
 * from the raw Cookie header, and clears with matching attributes.
 * Links: refresh-cookie.ts, auth.controller.ts (login/refresh/logout cookie wiring).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '../refresh-cookie';

function mockRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

describe('refresh-cookie helpers (OQ-1)', () => {
  it('setRefreshCookie writes an httpOnly cookie under the canonical name', () => {
    const res = mockRes();
    setRefreshCookie(res, 'refresh-token-value');

    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, value, opts] = res.cookie.mock.calls[0];
    expect(name).toBe(REFRESH_COOKIE_NAME);
    expect(value).toBe('refresh-token-value');
    // httpOnly is the whole point — JS (XSS) can never read it.
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/');
    // maxAge is locked to the refresh-token lifetime (positive, ~days).
    expect(typeof opts.maxAge).toBe('number');
    expect(opts.maxAge).toBeGreaterThan(0);
  });

  it('clearRefreshCookie clears with httpOnly + same path so the browser drops it', () => {
    const res = mockRes();
    clearRefreshCookie(res);

    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    const [name, opts] = res.clearCookie.mock.calls[0];
    expect(name).toBe(REFRESH_COOKIE_NAME);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/');
  });

  it('readRefreshCookie parses the token from the raw Cookie header', () => {
    const req = {
      headers: { cookie: `other=1; ${REFRESH_COOKIE_NAME}=abc%2Bdef; third=2` },
    } as unknown as Request;
    // URL-decoded value (%2B -> +).
    expect(readRefreshCookie(req)).toBe('abc+def');
  });

  it('readRefreshCookie returns undefined when the cookie is absent (mobile / pre-deploy)', () => {
    expect(readRefreshCookie({ headers: {} } as unknown as Request)).toBeUndefined();
    expect(
      readRefreshCookie({ headers: { cookie: 'foo=bar' } } as unknown as Request),
    ).toBeUndefined();
  });
});
