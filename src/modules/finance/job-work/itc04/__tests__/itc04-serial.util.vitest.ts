import { describe, it, expect } from 'vitest';
import { assignSequentialSno } from '../itc04-serial.util';

describe('assignSequentialSno (ITC-04 collision-free row numbering)', () => {
  it('numbers rows 1..N in order', () => {
    const out = assignSequentialSno([{ a: 'x' }, { a: 'y' }, { a: 'z' }]);
    expect(out.map((r) => r.sno)).toEqual([1, 2, 3]);
  });

  it('preserves the original row fields', () => {
    const out = assignSequentialSno([{ challanNo: 'C1', qty: 5 }]);
    expect(out[0]).toEqual({ challanNo: 'C1', qty: 5, sno: 1 });
  });

  it('returns no rows for an empty input', () => {
    expect(assignSequentialSno([])).toEqual([]);
  });

  it('stays collision-free past 100 rows (the bug: challanIdx*100+lineIdx collided)', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ n: i }));
    const snos = assignSequentialSno(rows).map((r) => r.sno);
    expect(new Set(snos).size).toBe(250); // all unique
    expect(snos[0]).toBe(1);
    expect(snos[249]).toBe(250);
  });
});
