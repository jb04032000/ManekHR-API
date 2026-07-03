/**
 * AUTH-H3 — a SameSite=None refresh-token cookie must also be Secure (browsers
 * silently drop SameSite=None without Secure). resolveAuthCookie forces
 * secure:true on that combination and warns. Safe defaults (lax + secure-in-prod)
 * are unchanged. Links: src/config/env.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { resolveAuthCookie } from '../env';

describe('resolveAuthCookie (AUTH-H3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forces secure:true when sameSite=none even if AUTH_COOKIE_SECURE is unset/false, and warns', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const undefSecure = resolveAuthCookie(undefined, 'none', 'development');
    expect(undefSecure.secure).toBe(true);
    expect(undefSecure.sameSite).toBe('none');

    const falseSecure = resolveAuthCookie('false', 'none', 'development');
    expect(falseSecure.secure).toBe(true);

    expect(warn).toHaveBeenCalled();
  });

  it('keeps the safe default: lax + secure=false in non-prod when nothing is set', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const cfg = resolveAuthCookie(undefined, undefined, 'development');
    expect(cfg.sameSite).toBe('lax');
    expect(cfg.secure).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the safe default: lax + secure=true in production', () => {
    const cfg = resolveAuthCookie(undefined, undefined, 'production');
    expect(cfg.sameSite).toBe('lax');
    expect(cfg.secure).toBe(true);
  });

  it('does not override secure for sameSite=lax or strict', () => {
    const lax = resolveAuthCookie('false', 'lax', 'development');
    expect(lax.secure).toBe(false);

    const strict = resolveAuthCookie(undefined, 'strict', 'development');
    expect(strict.sameSite).toBe('strict');
    expect(strict.secure).toBe(false);
  });

  it('falls back to lax for an invalid sameSite value', () => {
    const cfg = resolveAuthCookie('true', 'bogus', 'development');
    expect(cfg.sameSite).toBe('lax');
    expect(cfg.secure).toBe(true);
  });

  it('respects an explicit AUTH_COOKIE_SECURE=true with sameSite=none (no spurious warn)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const cfg = resolveAuthCookie('true', 'none', 'development');
    expect(cfg.secure).toBe(true);
    expect(cfg.sameSite).toBe('none');
    // Already secure -> no override warning.
    expect(warn).not.toHaveBeenCalled();
  });
});
