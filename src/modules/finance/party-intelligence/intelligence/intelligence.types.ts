/**
 * Phase 17 / FIN-16-01 — Party Intelligence types.
 *
 * Embedded sub-doc shape on Party.intelligence (D-05). Contracts other Wave-1
 * plans (RFM cron, GSTIN monitor, manual blacklist) write against.
 *
 * IMPORTANT: do NOT default Party.intelligence to `{}` — research §Pattern 4
 * mandates `default: undefined` to avoid silent overwrites on save.
 */

import { Types } from 'mongoose';
import type { GstinFilingPeriod } from '../gstin-monitor/filing-status.types';

/** RFM segment values (D-03). */
export type PartySegment =
  | 'NEW'
  | 'REGULAR'
  | 'VIP'
  | 'DORMANT'
  | 'CHURNED'
  | 'BLACKLIST';

/** GSTIN filing-status risk levels (D-12). */
export type GstinRiskLevel = 'OK' | 'WATCH' | 'RISK' | 'CRITICAL';

/** RFM individual-dimension score (1..5, ties-aware quintile per D-02). */
export type RfmScore = 1 | 2 | 3 | 4 | 5;

/**
 * PartyIntelligenceSubdoc — embedded under Party.intelligence (D-05 + Pattern 4).
 *
 * All fields optional — populated lazily by RFM cron's first run on a workspace
 * (CONTEXT canonical-refs "schemas are additive"). Existing parties read
 * `undefined` until then.
 */
export interface PartyIntelligenceSubdoc {
  // RFM dimension scores (1..5)
  rfmR?: RfmScore;
  rfmF?: RfmScore;
  rfmM?: RfmScore;

  // Segmentation
  segment?: PartySegment;
  recencyDays?: number;
  frequency?: number;
  monetaryPaise?: number;
  lastInvoiceDate?: Date;
  ltv12mPaise?: number;
  txCount12m?: number;
  segmentUpdatedAt?: Date;

  // Manual override (clears after one cycle EXCEPT for BLACKLIST per D-07)
  manualSegment?: PartySegment | null;

  // BLACKLIST flags (D-04 — manual + sticky)
  blacklisted?: boolean;
  blacklistedReason?: string;
  blacklistedAt?: Date;
  blacklistedBy?: Types.ObjectId;

  // GSTIN filing-status cache (D-11..D-13)
  gstinFilings?: GstinFilingPeriod[];
  gstinRiskLevel?: GstinRiskLevel;
  gstinFilingsCheckedAt?: Date;
  gstinFilingsLastError?: { at: Date; message: string };
}
