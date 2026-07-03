/**
 * GSTR-2B reconciliation - PURE core (no Nest / Mongo deps, fully unit-testable).
 *
 * What it does: parses a GSTN GSTR-2B JSON download into normalized rows, then matches
 * those rows against the firm's posted purchase bills and buckets each into:
 *   matched | partial (key matches, amounts differ) | missing_in_books (in 2B, no bill)
 *   | missing_in_2b (bill recorded, supplier did not report it).
 *
 * Cross-links: consumed by Gstr2bService (gstr2b.service.ts) which loads PurchaseBill
 * rows (purchase-bill.schema: partySnapshot.gstin, vendorBillNumber, vendorBillDate,
 * taxableValuePaise, cgst/sgst/igstPaise) and the uploaded 2B JSON. Scoring heuristic
 * mirrors bank-reconciliation/match-engine.ts (amount + date + invoice-no) but is a
 * parallel 2B-specific matcher (unsigned amounts, GSTIN+invoice primary key) - kept
 * separate on purpose until a 3rd matching domain justifies a shared util.
 * Watch: all money is paise (integers). Keep field names in sync with the bill loader.
 */

export interface Gstr2bRow {
  /** Supplier GSTIN (ctin). */
  gstin: string;
  /** Supplier invoice number (invno), as reported. */
  invNo: string;
  /** Invoice date ISO (idt), as reported. */
  invDate: string;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  /** ITC available flag (itcavl === 'Y'). */
  itcAvailable: boolean;
  /** Which 2B section it came from. b2ba = amendment, imp = import. */
  source: 'b2b' | 'b2ba' | 'imp';
}

export interface BillRow {
  billId: string;
  voucherNumber?: string;
  /** Supplier display name (from partySnapshot) - passed through for the recon UI. */
  partyName?: string;
  gstin?: string;
  vendorBillNumber?: string;
  vendorBillDate?: string;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export type ReconStatus = 'matched' | 'partial' | 'missing_in_books' | 'missing_in_2b';

export interface ReconRow {
  status: ReconStatus;
  /** 0-100 confidence (100 = exact key + amounts). */
  score: number;
  twoB?: Gstr2bRow;
  bill?: BillRow;
  /** Signed paise deltas (2B minus books) when both sides present. */
  deltas?: { taxablePaise: number; taxPaise: number };
}

export interface ReconResult {
  rows: ReconRow[];
  summary: {
    matched: number;
    partial: number;
    missingInBooks: number;
    missingIn2b: number;
    /** Net ITC at risk = sum of |tax delta| on partial + full tax of missing-in-books. */
    itcAtRiskPaise: number;
  };
}

/** Default amount tolerance (paise) for calling amounts "equal" - Rs1 on taxable + tax. */
const DEFAULT_TOL_PAISE = 100;

/** Normalize an invoice number for matching: uppercase, strip non-alphanumerics. */
export function normInvNo(s: string | undefined | null): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalize a GSTIN: uppercase, strip spaces. */
export function normGstin(s: string | undefined | null): string {
  return (s ?? '').toUpperCase().replace(/\s/g, '');
}

const tax = (r: { igstPaise: number; cgstPaise: number; sgstPaise: number }): number =>
  r.igstPaise + r.cgstPaise + r.sgstPaise;

/**
 * Parse a GSTN GSTR-2B JSON download into normalized rows. Tolerant of missing sections;
 * reads docdata.b2b / b2ba / imp. Rupee decimal amounts in the JSON -> integer paise.
 */
export function parseGstr2b(json: unknown): Gstr2bRow[] {
  const rows: Gstr2bRow[] = [];
  const root =
    (json as { docdata?: Record<string, unknown> })?.docdata ??
    (json as Record<string, unknown>) ??
    {};
  const toPaise = (n: unknown): number => {
    const v = typeof n === 'number' ? n : typeof n === 'string' ? parseFloat(n) : 0;
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  };
  const pushSection = (arr: unknown, source: Gstr2bRow['source']) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr as Record<string, unknown>[]) {
      // A supplier block may carry an `inv[]` array (real GSTN shape) or be flat.
      const ctin = String(e.ctin ?? e.gstin ?? '');
      const invList = Array.isArray(e.inv) ? (e.inv as Record<string, unknown>[]) : [e];
      for (const inv of invList) {
        if (inv.invno == null && inv.inum == null && e === inv) continue;
        rows.push({
          gstin: ctin,
          invNo: String(inv.invno ?? inv.inum ?? ''),
          invDate: String(inv.idt ?? inv.dt ?? ''),
          taxablePaise: toPaise(inv.txval),
          igstPaise: toPaise(inv.iamt),
          cgstPaise: toPaise(inv.camt),
          sgstPaise: toPaise(inv.samt),
          itcAvailable: String(inv.itcavl ?? 'Y').toUpperCase() !== 'N',
          source,
        });
      }
    }
  };
  pushSection(root.b2b, 'b2b');
  pushSection(root.b2ba, 'b2ba');
  pushSection(root.imp, 'imp');
  return rows;
}

/**
 * Reconcile 2B rows against posted purchase bills. Primary key = (GSTIN, normalized
 * invoice no). Same key + amounts within tolerance => matched; same key + amount drift
 * => partial; 2B row with no bill => missing_in_books; bill with no 2B row => missing_in_2b.
 */
export function reconcileGstr2b(
  twoBRows: Gstr2bRow[],
  bills: BillRow[],
  opts: { tolPaise?: number } = {},
): ReconResult {
  const tol = opts.tolPaise ?? DEFAULT_TOL_PAISE;
  const rows: ReconRow[] = [];

  // Index bills by (gstin, invno); a key may have >1 bill (rare) - keep a queue.
  const billIndex = new Map<string, BillRow[]>();
  for (const b of bills) {
    const key = `${normGstin(b.gstin)}|${normInvNo(b.vendorBillNumber)}`;
    const list = billIndex.get(key);
    if (list) list.push(b);
    else billIndex.set(key, [b]);
  }
  const consumedBillIds = new Set<string>();

  for (const t of twoBRows) {
    const key = `${normGstin(t.gstin)}|${normInvNo(t.invNo)}`;
    const candidates = billIndex.get(key);
    const bill = candidates?.find((b) => !consumedBillIds.has(b.billId));
    if (!bill) {
      // Supplier reported it but we have no matching bill.
      rows.push({ status: 'missing_in_books', score: 0, twoB: t });
      continue;
    }
    consumedBillIds.add(bill.billId);
    const taxableDelta = t.taxablePaise - bill.taxablePaise;
    const taxDelta = tax(t) - tax(bill);
    const amountsEqual = Math.abs(taxableDelta) <= tol && Math.abs(taxDelta) <= tol;
    rows.push({
      status: amountsEqual ? 'matched' : 'partial',
      score: amountsEqual ? 100 : 70,
      twoB: t,
      bill,
      deltas: { taxablePaise: taxableDelta, taxPaise: taxDelta },
    });
  }

  // Bills never consumed by a 2B row -> we recorded it, supplier did not report it.
  for (const b of bills) {
    if (!consumedBillIds.has(b.billId)) {
      rows.push({ status: 'missing_in_2b', score: 0, bill: b });
    }
  }

  const summary = { matched: 0, partial: 0, missingInBooks: 0, missingIn2b: 0, itcAtRiskPaise: 0 };
  for (const r of rows) {
    if (r.status === 'matched') summary.matched++;
    else if (r.status === 'partial') {
      summary.partial++;
      summary.itcAtRiskPaise += Math.abs(r.deltas?.taxPaise ?? 0);
    } else if (r.status === 'missing_in_books') {
      summary.missingInBooks++;
      summary.itcAtRiskPaise += r.twoB ? tax(r.twoB) : 0;
    } else {
      summary.missingIn2b++;
    }
  }
  return { rows, summary };
}
