import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LeaveLedgerEntryType =
  | 'opening'
  | 'accrual'
  | 'usage'
  | 'usage_reversal'
  | 'adjustment'
  | 'carry_forward'
  | 'lapse'
  | 'encashment'
  | 'comp_off_credit'
  | 'comp_off_expiry';

export type LeaveLedgerSourceKind = 'leave_request' | 'comp_off_request' | 'manual' | 'cron';

/**
 * LeaveLedger — immutable, append-only record of every balance movement and
 * the authoritative source of truth; `LeaveBalance` is a projection of it.
 *
 * `seq` is monotonic per (workspace, member, leaveType, year) — allocation +
 * fold-forward live in the L2 engine. `lotRemaining` is the one mutable field:
 * FIFO comp-off consumption decrements the originating `comp_off_credit` lot.
 */
@Schema({ timestamps: true, collection: 'leaveledgers' })
export class LeaveLedger extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  year: number;

  /** Monotonic per (workspace, member, leaveType, year). */
  @Prop({ type: Number, required: true })
  seq: number;

  @Prop({
    type: String,
    enum: [
      'opening',
      'accrual',
      'usage',
      'usage_reversal',
      'adjustment',
      'carry_forward',
      'lapse',
      'encashment',
      'comp_off_credit',
      'comp_off_expiry',
    ],
    required: true,
  })
  entryType: LeaveLedgerEntryType;

  /** Signed: credits positive, debits negative. */
  @Prop({ type: Number, required: true })
  quantity: number;

  @Prop({ type: Date, required: true })
  effectiveDate: Date;

  @Prop({
    type: {
      kind: {
        type: String,
        enum: ['leave_request', 'comp_off_request', 'manual', 'cron'],
        required: true,
      },
      id: { type: Types.ObjectId, default: null },
    },
    required: true,
    _id: false,
  })
  sourceRef: { kind: LeaveLedgerSourceKind; id: Types.ObjectId | null };

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  actorUserId: Types.ObjectId | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  reason: string | null;

  // ── Comp-off lot fields — set only on `comp_off_credit` entries ──
  /** When this comp-off lot expires (earnedOn + `LeaveType.compOff.validityDays`). */
  @Prop({ type: Date, default: null })
  lotExpiresOn: Date | null;

  /** Remaining unconsumed days in this comp-off lot (FIFO drawdown decrements it). */
  @Prop({ type: Number, default: null })
  lotRemaining: number | null;

  /** The holiday/week-off worked that earned this comp-off lot. */
  @Prop({ type: Date, default: null })
  sourceWorkDate: Date | null;
}

export const LeaveLedgerSchema = SchemaFactory.createForClass(LeaveLedger);

// Projection fold-forward + per-bucket ordering; also enforces seq uniqueness.
LeaveLedgerSchema.index(
  { workspaceId: 1, teamMemberId: 1, leaveTypeId: 1, year: 1, seq: 1 },
  { unique: true },
);
// FIFO comp-off lot lookup (oldest non-expired lot with remaining days first).
LeaveLedgerSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  leaveTypeId: 1,
  entryType: 1,
  lotExpiresOn: 1,
});
