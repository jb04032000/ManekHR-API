import { describe, it, expect } from 'vitest';
import { mapStatusCode, mapVerifyCode } from './zk-code-mapper';

describe('mapStatusCode', () => {
  it('maps 0 → CHECK_IN', () => expect(mapStatusCode(0)).toBe('CHECK_IN'));
  it('maps 1 → CHECK_OUT', () => expect(mapStatusCode(1)).toBe('CHECK_OUT'));
  it('maps 2 → BREAK_OUT', () => expect(mapStatusCode(2)).toBe('BREAK_OUT'));
  it('maps 3 → BREAK_IN', () => expect(mapStatusCode(3)).toBe('BREAK_IN'));
  it('maps 4 → OT_IN', () => expect(mapStatusCode(4)).toBe('OT_IN'));
  it('maps 5 → OT_OUT', () => expect(mapStatusCode(5)).toBe('OT_OUT'));
  it('maps unknown code to CHECK_IN (default)', () =>
    expect(mapStatusCode(99)).toBe('CHECK_IN'));
});

describe('mapVerifyCode', () => {
  it('maps 1 → "fp"', () => expect(mapVerifyCode(1)).toBe('fp'));
  it('maps 4 → "card"', () => expect(mapVerifyCode(4)).toBe('card'));
  it('maps 15 → "face"', () => expect(mapVerifyCode(15)).toBe('face'));
  it('maps 25 → "palm"', () => expect(mapVerifyCode(25)).toBe('palm'));
  it('maps unknown code → null', () => expect(mapVerifyCode(99)).toBeNull());
});
