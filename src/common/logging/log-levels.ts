/**
 * Env-driven Nest log-level selection (Connect startup audit — Finding 1).
 *
 * Nest's default logger emits EVERYTHING at the `log` level, so a boot prints
 * ~1,300+ framework lines (InstanceLoader "dependencies initialized" +
 * RouterExplorer/RoutesResolver "Mapped {route}"). Passing an explicit
 * `logger: LogLevel[]` to `NestFactory.create` enables only those levels and
 * drops the rest. Production therefore keeps warnings + errors (including the
 * structured failed-request lines from Finding 2, which are warn/error) and the
 * per-request SUCCESS lines (emitted at `log`) fall out of the prod stream
 * automatically — no change to the Finding 2 logger required.
 *
 * Pure helpers (no env/IO) so they unit-test cleanly; `config/env.ts` calls
 * `resolveLogLevels(process.env.LOG_LEVELS, NODE_ENV)` and `main.ts` feeds the
 * result to `NestFactory.create({ logger })`.
 */
import type { LogLevel } from '@nestjs/common';

/** All Nest levels, low→high severity. Dev default = the full set. */
export const ALL_LOG_LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

// Production keeps only the actionable levels. This is what silences the boot
// chatter (all at `log`) while preserving warn/error — and an operator can
// re-enable info logs with LOG_LEVELS=log,warn,error,fatal if they want them.
const PROD_DEFAULT: LogLevel[] = ['warn', 'error', 'fatal'];

const VALID = new Set<string>(ALL_LOG_LEVELS);

/**
 * Parse a csv of level names into a validated, de-duped LogLevel[] (order
 * preserved). Returns undefined when the input is missing / empty / has no
 * recognizable level, so callers can fall back to a default.
 */
export function parseLogLevels(raw: string | undefined): LogLevel[] | undefined {
  if (!raw) return undefined;
  const seen = new Set<string>();
  const out: LogLevel[] = [];
  for (const token of raw.split(',')) {
    const level = token.trim().toLowerCase();
    if (VALID.has(level) && !seen.has(level)) {
      seen.add(level);
      out.push(level as LogLevel);
    }
  }
  return out.length ? out : undefined;
}

/**
 * The Nest log levels to enable: an explicit LOG_LEVELS override if valid,
 * else the NODE_ENV default (prod = warn+error+fatal, otherwise all levels).
 * Always returns a fresh mutable array (Nest's `logger` option wants LogLevel[]).
 */
export function resolveLogLevels(raw: string | undefined, nodeEnv: string): LogLevel[] {
  const explicit = parseLogLevels(raw);
  if (explicit) return explicit;
  return nodeEnv === 'production' ? [...PROD_DEFAULT] : [...ALL_LOG_LEVELS];
}
