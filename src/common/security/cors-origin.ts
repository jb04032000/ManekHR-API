/**
 * Resolve the CORS `origin` setting (launch security — Workstream F, prompt §6).
 *
 * Production must NOT run wide-open (`origin: true`). This locks prod CORS to a
 * real allowlist while preserving the open, no-config dev experience:
 *   - non-production            -> true  (reflect any origin; dev convenience)
 *   - prod + CORS_ALLOWED_ORIGINS set -> that explicit allowlist
 *   - prod + no explicit list   -> the app's configured web URLs (WEB_APP_URL /
 *                                   PUBLIC_WEB_URL / NEXT_PUBLIC_APP_URL) as a
 *                                   sensible default so a same-origin/known-web
 *                                   deploy works without extra config
 *   - prod + nothing configured -> false (fail closed: no cross-origin until the
 *                                   operator sets an origin — never silently open)
 *
 * Pure + side-effect-free so it is unit-testable; main.ts feeds it env values and
 * passes the result to app.enableCors({ origin }). The cors middleware reflects a
 * matching allowlisted origin, which is what `credentials: true` requires (a bare
 * `*` is not allowed with credentials).
 */

export interface CorsOriginInput {
  nodeEnv: string;
  /** From CORS_ALLOWED_ORIGINS (csv). */
  allowedOrigins: string[];
  /** App-configured web URLs used as the prod fallback. */
  knownWebUrls: string[];
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, '').trim();

function normalize(list: string[]): string[] {
  const cleaned = list.map((s) => stripTrailingSlash(s || '')).filter(Boolean);
  return Array.from(new Set(cleaned));
}

export function resolveCorsOrigin(input: CorsOriginInput): boolean | string[] {
  if (input.nodeEnv !== 'production') return true;

  const explicit = normalize(input.allowedOrigins);
  if (explicit.length) return explicit;

  const known = normalize(input.knownWebUrls);
  if (known.length) return known;

  return false; // fail closed
}
