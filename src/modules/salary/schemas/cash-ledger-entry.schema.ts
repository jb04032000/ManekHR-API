/**
 * CashLedgerEntry schema - Phase 3C: Daily-Wage Running Ledger (baki/udhaar).
 *
 * CONCEPT - distinct from AdvanceRecoveryPlan:
 *   AdvanceRecoveryPlan is the FORMAL monthly-salary advance: it requires a
 *   salary record, carries an installment schedule, and is recovered from
 *   payroll over N months. It is suitable for salaried employees.
 *
 *   CashLedgerEntry is the INFORMAL daily-wage cash ledger: it does NOT
 *   require a salary record. A karigar can receive Rs 200 on a Tuesday
 *   (draw) before any monthly salary exists. The owner records what they
 *   EARNED (earning), what they DREW (draw), and periodic SETTLEMENTS.
 *   The running balance = total earned - total drawn - total settled.
 *
 *   Do NOT route daily-wage draws through AdvanceRecoveryPlan. Keep this
 *   lightweight and standalone. When a monthly salary is eventually generated
 *   for the worker, the outstanding ledger balance can optionally be converted
 *   to an AdvanceRecoveryPlan via the convert-to-plan endpoint.
 *
 * Running balance:
 *   balance = SUM(earning amounts) - SUM(draw amounts) - SUM(settlement amounts)
 *   A positive balance means the owner owes the worker (baki).
 *   A negative balance means the worker has overdrawn (udhaar).
 *   'adjustment' entries add (positive amount) or subtract (negative amount)
 *   to correct clerical errors.
 *
 * Settlement:
 *   A settlement entry records a cash payout to the worker (or a debt
 *   acknowledgment). On settlement, relevant earning/draw entries are marked
 *   with the settlement entry ID via settledInEntryId. The minimum-wage floor
 *   is checked on settle (Phase 1 compliance.minimumWageMonthly data) and
 *   surfaced as a flag - it is NOT a hard block here because this is informal
 *   cash flow, but the flag must be shown prominently in the UI.
 *
 * Spec: docs/superpowers/specs/advance-loan-epic/phase-3-bonus-commission-ledger.md
 *       section 4C (Gujarati Running Ledger)
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';

export const CASH_LEDGER_ENTRY_TYPES = ['earning', 'draw', 'settlement', 'adjustment'] as const;

export type CashLedgerEntryType = (typeof CASH_LEDGER_ENTRY_TYPES)[number];

@Schema({ timestamps: true })
export class CashLedgerEntry extends Document {
  /** Tenant scope - all queries must filter on this. */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  /** The karigar / daily-wage worker this entry belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  /**
   * The date the event occurred (not the createdAt timestamp).
   * earning: date the work was done or wages computed.
   * draw: date the cash was given.
   * settlement: date the net was paid out.
   * adjustment: date of the correction.
   */
  @Prop({ type: Date, required: true })
  date: Date;

  /**
   * Entry type:
   *   earning   - owner records wages owed to the worker (credit to worker)
   *   draw      - owner records cash given to worker (debit from worker's future wage)
   *   settlement - owner pays the net balance; resets the covered entries
   *   adjustment - positive or negative correction for clerical errors
   */
  @Prop({ type: String, enum: CASH_LEDGER_ENTRY_TYPES, required: true })
  type: CashLedgerEntryType;

  /**
   * Amount in rupees.
   *   earning: positive (increases balance owed to worker)
   *   draw: positive (increases how much worker has drawn; reduces net balance)
   *   settlement: positive (amount paid out; reduces balance owed to worker)
   *   adjustment: can be positive (add) or negative (subtract)
   */
  @Prop({ type: Number, required: true })
  amount: number;

  /** Optional note or description (piece count, work description, etc.). */
  @Prop({ type: String, trim: true })
  note?: string;

  /** User who created this entry. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: User | Types.ObjectId;

  /**
   * For earning and draw entries: set to the settlement entry's _id when this
   * entry is covered by a settlement event. Allows the UI to show which
   * entries have been cleared and which are still open.
   * Null = entry is open (not yet settled).
   */
  @Prop({ type: Types.ObjectId, ref: 'CashLedgerEntry' })
  settledInEntryId?: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CashLedgerEntrySchema = SchemaFactory.createForClass(CashLedgerEntry);

// Primary query: per-worker ledger view and running balance aggregation
CashLedgerEntrySchema.index({ workspaceId: 1, teamMemberId: 1, date: -1 });

// Workspace overview query: all members with non-zero balance
CashLedgerEntrySchema.index({ workspaceId: 1, type: 1 });

// Settlement sweep: find open (unsettled) entries for a member quickly
CashLedgerEntrySchema.index({ workspaceId: 1, teamMemberId: 1, settledInEntryId: 1 });
