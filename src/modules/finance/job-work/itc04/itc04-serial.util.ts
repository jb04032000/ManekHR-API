/**
 * Assign collision-free sequential serial numbers (1..N) to flattened ITC-04
 * table rows.
 *
 * Replaces the previous `challanIdx * 100 + lineIdx` scheme, which collided
 * once any challan had more than 100 lines (Table 4A) or once a challan's
 * return lines overran the +50 wastage offset (Table 4B) — both producing
 * duplicate serial numbers in the filed return.
 */
export function assignSequentialSno<T>(rows: T[]): (T & { sno: number })[] {
  return rows.map((row, i) => ({ ...row, sno: i + 1 }));
}
