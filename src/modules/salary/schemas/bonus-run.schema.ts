/**
 * BonusRun schema - Phase 3A (Bonus Module).
 *
 * SINGLE-LEDGER GUARANTEE:
 *   This schema stores the COMPUTATION and SUMMARY of a bonus run (statutory
 *   or festival/discretionary). It does NOT store money. The actual paid bonus
 *   money is always stored as a SalaryAdjustment row with category='bonus'.
 *   adjustmentRefs on this doc are back-references to those adjustment rows.
 *
 *   This mirrors the CommissionSchedule pattern exactly:
 *     CommissionSchedule -> schedule rule (no money)
 *     BonusRun          -> run metadata + per-member computation (no money)
 *     SalaryAdjustment  -> the actual paid amount (single ledger for both)
 *
 * BonusType vocabulary (binding - phase-3-clarity-and-overview.md):
 *   'statutory'      = Payment of Bonus Act; engine applies eligibility + calc wage + percent
 *   'discretionary'  = Festival/Diwali or other employer-chosen grant; free-form amount
 *
 * countsAsStatutory (on discretionary runs):
 *   When true, the statutory compliance run for the same member + FY should treat
 *   this festival bonus as satisfying the statutory obligation (up to the statutory
 *   amount). The BonusService.runStatutoryBonus checks for existing discretionary
 *   adjustments with countsAsStatutory=true and skips or reduces statutory amount
 *   accordingly, preventing double obligation. See BonusService for details.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export const BONUS_RUN_TYPES = ['statutory', 'discretionary'] as const;
export type BonusRunType = (typeof BONUS_RUN_TYPES)[number];

export const BONUS_RUN_STATUSES = ['pending', 'completed'] as const;
export type BonusRunStatus = (typeof BONUS_RUN_STATUSES)[number];

/** Per-member computation row stored inside a BonusRun document. */
export class BonusRunMemberRow {
  teamMemberId: Types.ObjectId;
  memberName?: string;
  eligible: boolean;
  ineligibilityReason?: string;
  lastMonthlyWage?: number;
  calcWage?: number;
  monthsWorked?: number;
  applicablePercent?: number;
  computedAmount?: number;
  /** Final amount disbursed (may differ from computedAmount for discretionary). */
  finalAmount: number;
  /** SalaryAdjustment._id created when disbursed. Null until disbursal. */
  adjustmentId?: Types.ObjectId;
  /** Month+year the bonus was disbursed into. */
  disbursedMonth?: number;
  disbursedYear?: number;
}

@Schema({ timestamps: true })
export class BonusRun extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  /**
   * Indian financial year start year.
   * E.g. 2025 = FY 2025-26 (April 2025 - March 2026).
   * Used for statutory bonus computation and idempotency.
   */
  @Prop({ type: Number, required: true })
  financialYear: number;

  @Prop({ type: String, enum: BONUS_RUN_TYPES, required: true })
  bonusType: BonusRunType;

  /**
   * Sub-type label for discretionary runs.
   * E.g. 'festival_diwali', 'performance', 'referral', or any free text.
   * Null for statutory runs.
   */
  @Prop({ type: String })
  subType?: string;

  /**
   * When true (discretionary runs only), this festival bonus also satisfies
   * the statutory obligation for each member it covers. The statutory run
   * checks for existing discretionary adjustments with countsAsStatutory=true
   * and does not double-post beyond the statutory amount.
   *
   * See BonusService.runStatutoryBonus for the double-obligation guard.
   */
  @Prop({ type: Boolean, default: false })
  countsAsStatutory: boolean;

  /**
   * Workspace-level bonus config snapshot at run time (for auditability).
   * Stored so the run is reproducible even if admin later changes the policy.
   */
  @Prop({
    type: {
      eligibilityWageCeiling: { type: Number },
      calculationWageFloor: { type: Number },
      minimumWageMonthly: { type: Number, default: null },
      allocableSurplusPercent: { type: Number },
      minPercent: { type: Number },
      maxPercent: { type: Number },
      newEstablishment: { type: Boolean },
    },
    _id: false,
  })
  configSnapshot?: {
    eligibilityWageCeiling: number;
    calculationWageFloor: number;
    minimumWageMonthly: number | null;
    allocableSurplusPercent: number;
    minPercent: number;
    maxPercent: number;
    newEstablishment: boolean;
  };

  /**
   * Per-member computation rows.
   * The computedAmount / finalAmount here is a reference figure.
   * The authoritative paid amount is always the SalaryAdjustment.amount.
   */
  @Prop({
    type: [
      {
        teamMemberId: { type: Types.ObjectId, ref: 'TeamMember', required: true },
        memberName: { type: String },
        eligible: { type: Boolean, required: true },
        ineligibilityReason: { type: String },
        lastMonthlyWage: { type: Number },
        calcWage: { type: Number },
        monthsWorked: { type: Number },
        applicablePercent: { type: Number },
        computedAmount: { type: Number },
        finalAmount: { type: Number, required: true },
        adjustmentId: { type: Types.ObjectId, ref: 'SalaryAdjustment' },
        disbursedMonth: { type: Number },
        disbursedYear: { type: Number },
        _id: false,
      },
    ],
    default: [],
  })
  memberRows: BonusRunMemberRow[];

  /** Summary totals for the run (derived from memberRows, stored for quick queries). */
  @Prop({ type: Number, default: 0 })
  totalEligibleMembers: number;

  @Prop({ type: Number, default: 0 })
  totalDisbursedAmount: number;

  @Prop({ type: Number, default: 0 })
  totalDisbursedMembers: number;

  @Prop({ type: String, enum: BONUS_RUN_STATUSES, default: 'pending' })
  status: BonusRunStatus;

  /** Optional note for the run (e.g. "FY 2025-26 statutory bonus disbursed 15 Nov 2026"). */
  @Prop({ type: String, trim: true })
  note?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BonusRunSchema = SchemaFactory.createForClass(BonusRun);

// Primary query: list runs for a workspace + FY
BonusRunSchema.index({ workspaceId: 1, financialYear: 1, bonusType: 1 });

// Idempotency guard: one statutory run per workspace+FY (partial, only for statutory)
// Enforced in application logic (not unique index) because we allow multiple festival runs.
BonusRunSchema.index({ workspaceId: 1, financialYear: 1, status: 1 });

// Clawback sweep: find runs where adjustment IDs need clawback checks at F&F
BonusRunSchema.index({ workspaceId: 1, bonusType: 1, 'memberRows.teamMemberId': 1 });
