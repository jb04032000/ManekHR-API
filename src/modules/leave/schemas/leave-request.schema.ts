import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HalfDaySession = 'none' | 'first_half' | 'second_half';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'withdrawn';

/**
 * One day of a leave request after apply-time decomposition. A multi-day
 * request that overruns the paid balance splits across leave types here
 * (e.g. CL for the paid days, LWP for the overflow).
 */
@Schema({ _id: false })
export class LeaveDaySegment {
  @Prop({ type: Date, required: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  leaveTypeId: Types.ObjectId;

  /** 1 = full day, 0.5 = half day. */
  @Prop({ type: Number, required: true })
  quantity: number;
}
export const LeaveDaySegmentSchema = SchemaFactory.createForClass(LeaveDaySegment);

/**
 * One comp-off lot drawn by an approved comp-off leave request. Recorded so a
 * later withdrawal can re-credit the exact lots FIFO consumption decremented.
 */
@Schema({ _id: false })
export class CompOffLotConsumption {
  /** The `comp_off_credit` ledger entry (lot) this draw came from. */
  @Prop({ type: Types.ObjectId, ref: 'LeaveLedger', required: true })
  lotLedgerEntryId: Types.ObjectId;

  /** The lot's earn-year ledger bucket — a draw may span years. */
  @Prop({ type: Number, required: true })
  year: number;

  @Prop({ type: Number, required: true })
  consumed: number;
}
export const CompOffLotConsumptionSchema = SchemaFactory.createForClass(CompOffLotConsumption);

/**
 * One step in a leave request's approval chain. Snapshotted at request create
 * time (mirrors the regularization snapshot-at-create pattern).
 */
@Schema({ _id: false })
export class LeaveApprovalStep {
  @Prop({ type: Number, required: true })
  level: number;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  approverUserId: Types.ObjectId;

  @Prop({ type: String, enum: ['approved', 'rejected', null], default: null })
  decision: 'approved' | 'rejected' | null;

  @Prop({ type: Date, default: null })
  decidedAt: Date | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  note: string | null;
}
export const LeaveApprovalStepSchema = SchemaFactory.createForClass(LeaveApprovalStep);

/**
 * LeaveRequest — a member's multi-day leave application. `dayBreakdown` holds
 * the apply-time paid/LWP decomposition; `ledgerEntryIds` records the usage
 * ledger entries written on approval so a cancellation can reverse them.
 */
@Schema({ timestamps: true, collection: 'leaverequests' })
export class LeaveRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  appliedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeaveType', required: true })
  primaryLeaveTypeId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  fromDate: Date;

  @Prop({ type: Date, required: true })
  toDate: Date;

  @Prop({
    type: String,
    enum: ['none', 'first_half', 'second_half'],
    default: 'none',
  })
  firstDayHalf: HalfDaySession;

  @Prop({
    type: String,
    enum: ['none', 'first_half', 'second_half'],
    default: 'none',
  })
  lastDayHalf: HalfDaySession;

  @Prop({ type: [LeaveDaySegmentSchema], default: [] })
  dayBreakdown: LeaveDaySegment[];

  @Prop({ type: Number, default: 0 })
  totalDays: number;

  @Prop({ type: Number, default: 0 })
  paidDays: number;

  @Prop({ type: Number, default: 0 })
  lwpDays: number;

  @Prop({ type: String, default: null, maxlength: 1000 })
  reason: string | null;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  @Prop({
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'],
    default: 'pending',
  })
  status: LeaveRequestStatus;

  @Prop({ type: [LeaveApprovalStepSchema], default: [] })
  approvalChain: LeaveApprovalStep[];

  @Prop({ type: Number, default: 1 })
  currentLevel: number;

  @Prop({ type: Date, default: null })
  finalDecisionAt: Date | null;

  /** True when `fromDate` is in the past — HR-routed if payroll is locked. */
  @Prop({ type: Boolean, default: false })
  isRetroactive: boolean;

  @Prop({ type: Boolean, default: false })
  salaryInvalidated: boolean;

  /** Accrual-type `usage` ledger entries written on approval — reversed on withdrawal. */
  @Prop({ type: [Types.ObjectId], ref: 'LeaveLedger', default: [] })
  ledgerEntryIds: Types.ObjectId[];

  /** Per-lot comp-off draw on approval — drives precise re-credit on withdrawal. */
  @Prop({ type: [CompOffLotConsumptionSchema], default: [] })
  compOffConsumption: CompOffLotConsumption[];

  /** `STATUS_SET` attendance events projected on approval — voided on withdrawal. */
  @Prop({ type: [Types.ObjectId], ref: 'AttendanceEvent', default: [] })
  attendanceEventIds: Types.ObjectId[];
}

export const LeaveRequestSchema = SchemaFactory.createForClass(LeaveRequest);

// "My requests" + status filters for a member.
LeaveRequestSchema.index({ workspaceId: 1, teamMemberId: 1, status: 1 });
// "Pending for me" queue ordered by the active approval level.
LeaveRequestSchema.index({ workspaceId: 1, status: 1, currentLevel: 1 });
// Approver-scoped pending lookup.
LeaveRequestSchema.index({
  workspaceId: 1,
  status: 1,
  'approvalChain.approverUserId': 1,
});
// Date-range overlap checks (team-conflict + calendar).
LeaveRequestSchema.index({ workspaceId: 1, teamMemberId: 1, fromDate: -1 });
