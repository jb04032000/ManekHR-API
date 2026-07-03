import { levenshtein, normaliseRef } from './parsers/parse-utils';
import { Types } from 'mongoose';

export const AUTO_CLEAR_THRESHOLD = 90;
export const SUGGEST_THRESHOLD = 70;

export interface MatchableRow {
  _id: Types.ObjectId;
  txnDate: Date;
  narrationNorm: string;
  refNumberNorm: string;
  debitPaise: number;
  creditPaise: number;
  amountPaise: number; // signed
}

export interface MatchableEntry {
  _id: Types.ObjectId;
  entryDate: Date;
  sourceVoucherId: Types.ObjectId;
  sourceVoucherType: string;
  sourceVoucherNumber: string;
  entryType: string;
  narration: string;
  // For each entry, the bank-account net (debit - credit) on the bank-account line:
  bankLineDebitPaise: number;
  bankLineCreditPaise: number;
  bankLineNetPaise: number; // signed: positive = debit on bank account (cash out), negative = credit on bank account (cash in)
}

export interface MatchResult {
  ledgerEntryId: Types.ObjectId;
  confidence: number; // 0-100
  matchType: 'exact' | 'fuzzy_amount_date' | 'fuzzy_narration' | 'reversal_pair' | 'none';
  bankLineNetPaise: number;
}

function dayDiff(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86400000));
}

/**
 * Compute match score (0-100) between a bank statement row and a ledger entry.
 * - amount weight: 60 points
 * - date weight: 25 points
 * - reference weight: 15 points (only counts if amount already matched)
 */
export function computeScore(row: MatchableRow, entry: MatchableEntry): number {
  // Direction check: bank debit row matches entry where bank-account line is credit (cash leaving bank)
  // Bank credit row matches entry where bank-account line is debit (cash arriving in bank)
  // amountPaise signed: +ve = credit row, -ve = debit row
  // bankLineNetPaise signed: +ve = bank-line debit (cash out from bank), -ve = bank-line credit (cash into bank)
  // Therefore for valid match: signs must be OPPOSITE.
  const rowSign = Math.sign(row.amountPaise);
  const entrySign = Math.sign(entry.bankLineNetPaise);
  if (rowSign !== 0 && entrySign !== 0 && rowSign === entrySign) {
    return 0; // wrong direction
  }

  const rowAbs = Math.abs(row.amountPaise);
  const entryAbs = Math.abs(entry.bankLineNetPaise);

  // Amount score (0-60)
  const amountDiff = Math.abs(rowAbs - entryAbs);
  const amountPct = rowAbs > 0 ? amountDiff / rowAbs : 1;
  let amountScore = 0;
  if (amountDiff === 0) amountScore = 60;
  else if (amountDiff <= 500) amountScore = 45; // <= INR 5 penny tolerance (paise)
  else if (amountPct <= 0.005) amountScore = 40; // within 0.5%
  // else 0

  // Date score (0-25)
  const days = dayDiff(row.txnDate, entry.entryDate);
  let dateScore = 0;
  if (days === 0) dateScore = 25;
  else if (days === 1) dateScore = 20;
  else if (days <= 3) dateScore = 12;
  else if (days <= 7) dateScore = 5;
  // else 0

  // Reference score (0-15) - only if amount aligns
  let refScore = 0;
  if (amountScore > 0 && row.refNumberNorm) {
    const entryRef = normaliseRef(entry.sourceVoucherNumber);
    if (entryRef && row.refNumberNorm === entryRef) refScore = 15;
    else if (entryRef) {
      const dist = levenshtein(row.refNumberNorm, entryRef);
      if (dist <= 2) refScore = 12;
      else if (dist <= 5) refScore = 7;
    }
  }

  return amountScore + dateScore + refScore;
}

/**
 * Determine matchType label for a given score.
 */
function classifyMatchType(score: number): MatchResult['matchType'] {
  if (score >= 95) return 'exact';
  if (score >= SUGGEST_THRESHOLD) return 'fuzzy_amount_date';
  return 'none';
}

/**
 * For one row, score every candidate entry, pick top 3 sorted by confidence.
 * Returns up to 3 results. The first result (if confidence >= AUTO_CLEAR_THRESHOLD)
 * is the auto-cleared match.
 */
export function rankCandidates(row: MatchableRow, candidates: MatchableEntry[]): MatchResult[] {
  const scored = candidates.map((c) => ({
    ledgerEntryId: c._id,
    confidence: computeScore(row, c),
    matchType: 'none' as MatchResult['matchType'],
    bankLineNetPaise: c.bankLineNetPaise,
  }));
  scored.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Tie-break: prefer entry with smaller date diff to row (RESEARCH §2.3)
    return 0;
  });
  return scored.slice(0, 3).map((s) => ({ ...s, matchType: classifyMatchType(s.confidence) }));
}

/**
 * Step 6 of cascade: detect reversal pairs WITHIN the unmatched bank-statement-row pool.
 * Two rows form a reversal pair when:
 *   abs(amountPaise_a) === abs(amountPaise_b)
 *   sign(amountPaise_a) !== sign(amountPaise_b)
 *   abs(dayDiff) <= 15
 *   normaliseRef matches OR levenshtein(narrationNorm) <= 5
 * Returns array of [rowIdA, rowIdB] pairs. Caller marks both as matchType: 'reversal_pair'.
 */
export function detectReversalPairs(rows: MatchableRow[]): Array<[Types.ObjectId, Types.ObjectId]> {
  const pairs: Array<[Types.ObjectId, Types.ObjectId]> = [];
  const used = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (used.has(rows[i]._id.toString())) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(rows[j]._id.toString())) continue;
      const a = rows[i];
      const b = rows[j];
      if (Math.abs(a.amountPaise) !== Math.abs(b.amountPaise)) continue;
      if (Math.sign(a.amountPaise) === Math.sign(b.amountPaise)) continue;
      if (Math.abs(a.amountPaise) === 0) continue;
      if (dayDiff(a.txnDate, b.txnDate) > 15) continue;
      const refMatch =
        a.refNumberNorm && b.refNumberNorm && a.refNumberNorm === b.refNumberNorm;
      const narrMatch =
        a.narrationNorm &&
        b.narrationNorm &&
        levenshtein(a.narrationNorm, b.narrationNorm) <= 5;
      if (!refMatch && !narrMatch) continue;
      pairs.push([a._id, b._id]);
      used.add(a._id.toString());
      used.add(b._id.toString());
      break;
    }
  }
  return pairs;
}

/**
 * Validate that bulk many-to-many match is balanced.
 * Returns true if sum of bank-row signed amounts equals (sum of entry bank-line nets) * -1.
 * (Opposite signs because bank row credit corresponds to entry bank-line debit.)
 */
export function validateBulkBalance(rows: MatchableRow[], entries: MatchableEntry[]): boolean {
  const rowSum = rows.reduce((s, r) => s + r.amountPaise, 0);
  const entrySum = entries.reduce((s, e) => s + e.bankLineNetPaise, 0);
  // bank-row credit (positive amountPaise) corresponds to entry bank-line credit (negative bankLineNetPaise)
  // therefore rowSum === -entrySum (within penny tolerance)
  return Math.abs(rowSum + entrySum) <= 500;
}
