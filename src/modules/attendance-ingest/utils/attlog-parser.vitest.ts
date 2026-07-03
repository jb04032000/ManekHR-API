import { describe, it, expect } from 'vitest';
import { parseAttlog } from './attlog-parser';

describe('parseAttlog', () => {
  it('parses a single tab-separated ATTLOG line', () => {
    const line = '1001\t2026-04-18 09:01:23\t0\t1\t0\t0\t0\t';
    const result = parseAttlog(line);
    expect(result).toHaveLength(1);
    expect(result[0].deviceUserId).toBe('1001');
    expect(result[0].statusCode).toBe(0);
    expect(result[0].verifyCode).toBe(1);
    expect(result[0].timestamp).toBeInstanceOf(Date);
    expect(result[0].timestamp.getFullYear()).toBe(2026);
  });

  it('parses multiple \\n-separated lines', () => {
    const body =
      '1001\t2026-04-18 09:01:23\t0\t1\t0\t0\t0\t\n1002\t2026-04-18 09:03:47\t0\t1\t0\t0\t0\t';
    expect(parseAttlog(body)).toHaveLength(2);
  });

  it('parses \\r\\n (Windows CRLF) line endings', () => {
    const body =
      '1001\t2026-04-18 09:01:23\t0\t1\r\n1002\t2026-04-18 09:03:47\t0\t4\r\n';
    expect(parseAttlog(body)).toHaveLength(2);
  });

  it('skips empty lines', () => {
    const body =
      '1001\t2026-04-18 09:01:23\t0\t1\n\n1002\t2026-04-18 09:03:47\t0\t1\n';
    expect(parseAttlog(body)).toHaveLength(2);
  });

  it('parses timestamp into a Date object', () => {
    const result = parseAttlog('1001\t2026-04-18 09:01:23\t0\t1');
    expect(result[0].timestamp).toBeInstanceOf(Date);
    expect(isNaN(result[0].timestamp.getTime())).toBe(false);
  });

  it('parses statusCode as integer', () => {
    const result = parseAttlog('1001\t2026-04-18 09:01:23\t1\t1');
    expect(result[0].statusCode).toBe(1);
    expect(typeof result[0].statusCode).toBe('number');
  });

  it('parses verifyCode as integer', () => {
    const result = parseAttlog('1001\t2026-04-18 09:01:23\t0\t15');
    expect(result[0].verifyCode).toBe(15);
  });

  it('returns empty array for empty string body', () => {
    expect(parseAttlog('')).toEqual([]);
    expect(parseAttlog('   \n   ')).toEqual([]);
  });
});
