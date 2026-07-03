import { describe, it, expect } from 'vitest';
import { resolveLogLevels, parseLogLevels, ALL_LOG_LEVELS } from '../log-levels';

describe('parseLogLevels', () => {
  it('parses a csv of valid levels (trim + lowercase + dedupe, order preserved)', () => {
    expect(parseLogLevels(' Warn, error ,error')).toEqual(['warn', 'error']);
  });

  it('ignores unknown tokens but keeps the valid ones', () => {
    expect(parseLogLevels('warn,banana,error')).toEqual(['warn', 'error']);
  });

  it('returns undefined for empty / missing / all-invalid input', () => {
    expect(parseLogLevels('')).toBeUndefined();
    expect(parseLogLevels(undefined)).toBeUndefined();
    expect(parseLogLevels('banana,kiwi')).toBeUndefined();
  });
});

describe('resolveLogLevels', () => {
  it('production defaults to warn+error+fatal (drops the log-level boot chatter)', () => {
    const levels = resolveLogLevels(undefined, 'production');
    expect(levels).toEqual(['warn', 'error', 'fatal']);
    expect(levels).not.toContain('log');
    expect(levels).not.toContain('debug');
    expect(levels).not.toContain('verbose');
  });

  it('non-production defaults to all levels (full dev visibility)', () => {
    expect(resolveLogLevels(undefined, 'development')).toEqual(ALL_LOG_LEVELS);
  });

  it('an explicit LOG_LEVELS override wins over the NODE_ENV default', () => {
    expect(resolveLogLevels('log,warn,error,fatal', 'production')).toEqual([
      'log',
      'warn',
      'error',
      'fatal',
    ]);
    expect(resolveLogLevels('error', 'development')).toEqual(['error']);
  });

  it('falls back to the env default when the override is all-invalid', () => {
    expect(resolveLogLevels('banana', 'production')).toEqual(['warn', 'error', 'fatal']);
  });

  it('returns a fresh mutable array each call (safe to pass to Nest)', () => {
    const a = resolveLogLevels(undefined, 'production');
    const b = resolveLogLevels(undefined, 'production');
    expect(a).not.toBe(b);
    expect(Array.isArray(a)).toBe(true);
  });
});
