import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * LeaveBalance — a fast-read projection of a member's balance for one leave
 * type in one year. The authoritative source is `LeaveLedger`; this row is a
 * rebuildable cache folded forward by the L2 engine (`lastLedgerSeq` tracks how
 * far it has been folded). `available` is derived + persisted for cheap reads.
 */
@Schema({ timestamps: true, collection: 'leavebalances' })
export class LeaveBalance extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  year: number;

  @Prop({ type: Number, default: 0 })
  opening: number;

  @Prop({ type: Number, default: 0 })
  credited: number;

  @Prop({ type: Number, default: 0 })
  used: number;

  /** Days locked by pending (not-yet-approved) requests. */
  @Prop({ type: Number, default: 0 })
  pending: number;

  @Prop({ type: Number, default: 0 })
  lapsed: number;

  @Prop({ type: Number, default: 0 })
  encashed: number;

  /** Derived: opening + credited − used − pending − lapsed − encashed. */
  @Prop({ type: Number, default: 0 })
  available: number;

  /** Highest `LeaveLedger.seq` folded into this projection. */
  @Prop({ type: Number, default: 0 })
  lastLedgerSeq: number;
}

export const LeaveBalanceSchema = SchemaFactory.createForClass(LeaveBalance);

// One balance row per member × leave type × year.
LeaveBalanceSchema.index(
  { workspaceId: 1, teamMemberId: 1, leaveTypeId: 1, year: 1 },
  { unique: true },
);
// Workspace-wide balance listing for a year.
LeaveBalanceSchema.index({ workspaceId: 1, year: 1, teamMemberId: 1 });
