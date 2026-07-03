/**
 * CommissionSchedule schema (Phase 3B - Commission/Incentive Module).
 *
 * This schema stores the RULE for recurring commission payouts. It does NOT
 * store the money itself. When a scheduled commission is disbursed, a
 * SalaryAdjustment row with category='commission' or category='incentive' is
 * created. That adjustment row is the single ledger entry. The
 * disbursementLog on this schema is a back-reference for auditing "which
 * schedule produced which adjustment", not a second money store.
 *
 * Ad-hoc commissions (one-offs, CSV import, Record Payment modal quick-add)
 * also write plain SalaryAdjustment rows with category='commission'/'incentive'
 * and do NOT create a CommissionSchedule. This keeps one ledger regardless of
 * entry point.
 *
 * Single-ledger guarantee:
 *   All commission/incentive money lives in SalaryAdjustment. The
 *   getCommissionYtd aggregation queries only that collection. No parallel
 *   totals are maintained here.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';

export const COMMISSION_TYPES = [
  'sales',
  'production_piece',
  'attendance',
  'referral',
  'other',
] as const;

export type CommissionType = (typeof COMMISSION_TYPES)[number];

export const COMMISSION_CALC_BASES = [
  'flat',
  'percent_of_revenue',
  'per_unit',
  'formula_result',
] as const;

export type CommissionCalcBasis = (typeof COMMISSION_CALC_BASES)[number];

export const COMMISSION_FREQUENCIES = ['monthly', 'quarterly', 'annual'] as const;

export type CommissionFrequency = (typeof COMMISSION_FREQUENCIES)[number];

export const COMMISSION_SCHEDULE_STATUSES = ['active', 'paused', 'completed'] as const;

export type CommissionScheduleStatus = (typeof COMMISSION_SCHEDULE_STATUSES)[number];

/** One entry in the disbursement log: proof that a schedule triggered a specific adjustment. */
export class DisbursementLogEntry {
  month: number;
  year: number;
  adjustmentId: Types.ObjectId;
  amount: number;
  disbursedAt: Date;
  disbursedBy: Types.ObjectId;
}

@Schema({ timestamps: true })
export class CommissionSchedule extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  /**
   * Structured type label for this commission. Stored on the SalaryAdjustment
   * as part of reasonTitle so the type is visible in the single ledger.
   */
  @Prop({ type: String, enum: COMMISSION_TYPES, required: true })
  commissionType: CommissionType;

  /** How the amount was derived. Informational - the final amount is always stored. */
  @Prop({ type: String, enum: COMMISSION_CALC_BASES, required: true })
  calcBasis: CommissionCalcBasis;

  /**
   * The amount to be posted per pay cycle. For 'flat': rupee amount. For
   * 'per_unit' / 'percent_of_revenue' / 'formula_result': the already-
   * computed rupee result entered by HR. The engine does not re-derive from
   * a formula; HR enters the result each time or sets a recurring flat amount.
   */
  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({ type: String, enum: COMMISSION_FREQUENCIES, required: true })
  frequency: CommissionFrequency;

  @Prop({ type: Number, required: true, min: 1, max: 12 })
  startMonth: number;

  @Prop({ type: Number, required: true, min: 2000 })
  startYear: number;

  @Prop({ type: Number, min: 1, max: 12 })
  endMonth?: number;

  @Prop({ type: Number, min: 2000 })
  endYear?: number;

  @Prop({ type: String, trim: true })
  note?: string;

  @Prop({ type: String, enum: COMMISSION_SCHEDULE_STATUSES, default: 'active' })
  status: CommissionScheduleStatus;

  /** The month/year the cron should dispatch next. Advances after each dispatch. */
  @Prop({ type: Number, required: true, min: 1, max: 12 })
  nextDueMonth: number;

  @Prop({ type: Number, required: true, min: 2000 })
  nextDueYear: number;

  /**
   * Back-references to the SalaryAdjustment rows this schedule produced.
   * Each entry links one disbursement event to a specific adjustment row in
   * the single ledger. Contains a unique-per-schedule (month+year) guarantee
   * enforced by the disbursement logic.
   */
  @Prop({
    type: [
      {
        month: { type: Number, required: true },
        year: { type: Number, required: true },
        adjustmentId: { type: Types.ObjectId, ref: 'SalaryAdjustment', required: true },
        amount: { type: Number, required: true },
        disbursedAt: { type: Date, required: true },
        disbursedBy: { type: Types.ObjectId, ref: 'User', required: true },
        _id: false,
      },
    ],
    default: [],
  })
  disbursementLog: DisbursementLogEntry[];

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: User | Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CommissionScheduleSchema = SchemaFactory.createForClass(CommissionSchedule);

// Index for listing schedules by member/status
CommissionScheduleSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });

// Index for the cron dispatch sweep: find overdue active schedules efficiently
CommissionScheduleSchema.index({
  workspaceId: 1,
  nextDueMonth: 1,
  nextDueYear: 1,
  status: 1,
});

// Index for per-member history (newest first)
CommissionScheduleSchema.index({ workspaceId: 1, teamMemberId: 1, createdAt: -1 });
