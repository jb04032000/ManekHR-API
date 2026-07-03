import type { Request, Response } from 'express';
import { env } from '../../../config/env';

/**
 * Refresh-token cookie helpers (OQ-1, auth-hardening).
 *
 * The web client's long-lived refresh token is moved OUT of localStorage and
 * into an httpOnly + Secure + SameSite cookie so an XSS payload can no longer
 * read it (the most serious token-theft vector). The short-lived access token
 * may stay in localStorage (it expires in ~15 min, the FE forwards it as a
 * Bearer header). Only the WEB surface uses the cookie; the mobile client keeps
 * passing the refresh token in the request body (no cookie jar there).
 *
 * Set on: login / register / google / refresh (rotation). Cleared on: logout.
 *
 * Dependency note: read by AuthController.refresh (cookie wins over body for
 * web; body fallback keeps mobile working). The cookie attributes come from
 * `env.authCookie` (single source). maxAge is locked to the refresh-token
 * lifetime so the cookie can't outlive the token it carries.
 *
 * MIGRATION NOTE (deploy): existing logged-in web users have a refresh token in
 * localStorage but no cookie yet. Their next refresh sends the body token (the
 * FE keeps sending it until the cookie exists), and the BE response sets the
 * cookie — so they self-heal on the first refresh. Users whose access token is
 * already dead must log in once after deploy; that is the expected one-time
 * re-login the owner approved.
 */

/** Cookie name for the web refresh token. */
export const REFRESH_COOKIE_NAME = 'z360_refresh_token';

/** Parse the refresh-token expiry (e.g. `7d`, `168h`, `604800s`) into ms. */
function refreshExpiryMs(): number {
  const raw = (env.jwt.refreshExpiry || '7d').trim();
  const m = /^(\d+)\s*([smhd]?)$/.exec(raw);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const value = parseInt(m[1], 10);
  const unit = m[2] || 's';
  const mult = unit === 'd' ? 86400_000 : unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : 1000;
  const ms = value * mult;
  return Number.isFinite(ms) && ms > 0 ? ms : 7 * 24 * 60 * 60 * 1000;
}

/**
 * Write the httpOnly refresh-token cookie on a successful auth response.
 * `path: '/'` so it is sent on every request (the refresh endpoint reads it).
 */
export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    domain: env.authCookie.domain,
    path: '/',
    maxAge: refreshExpiryMs(),
  });
}

/**
 * Clear the refresh cookie on logout. The clear options (httpOnly/secure/
 * sameSite/domain/path) MUST match the set options or the browser keeps the
 * old cookie.
 */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    domain: env.authCookie.domain,
    path: '/',
  });
}

/**
 * Read the refresh token from the request cookie header (web) without needing
 * cookie-parser middleware. Returns undefined when absent (mobile / pre-deploy
 * web), so the caller falls back to the request body.
 */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === REFRESH_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
