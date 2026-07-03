import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { TeamMember } from '../../team/schemas/team-member.schema';
import { User } from '../../users/schemas/user.schema';
import { SALARY_TYPES, SalaryType } from '../constants/salary-types';
import { PieceRateUnit } from '../../team/schemas/piece-rate-config.schema';

@Schema({ timestamps: true })
export class Salary extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: TeamMember | Types.ObjectId;

  @Prop({ type: Number, required: true }) month: number; // 1-12
  @Prop({ type: Number, required: true }) year: number;

  @Prop({ type: Number, required: true }) baseSalary: number;
  @Prop({ type: Number, required: true }) totalDays: number;
  @Prop({ type: Number, required: true }) presentDays: number;
  @Prop({ type: String, enum: SALARY_TYPES, default: 'monthly' })
  salaryType: SalaryType;
  @Prop({
    type: String,
    enum: ['fixed_month_days', 'calendar_month_days'],
    default: 'fixed_month_days',
  })
  salaryDayBasis: string;
  @Prop({ type: Number, default: null })
  fixedMonthDays?: number | null;
  @Prop({ type: String, enum: ['enabled', 'disabled'], default: 'enabled' })
  attendancePayModeApplied: string;
  @Prop({ type: Number, default: 0 }) deductions: number;
  @Prop({ type: Number, default: 0 }) additions: number;
  @Prop({ type: Number, required: true }) netSalary: number;

  // Phase 23 (D-05) — piece-rate snapshot. Safe defaults so existing monthly/hourly
  // records read with no migration.
  @Prop({ type: Number, default: 0 })
  pieceRateEarnings: number;

  @Prop({
    type: {
      unit: { type: String },
      defaultRate: { type: Number },
      basePortion: { type: Number },
      perMachineOverrides: [{
        machineId: { type: Types.ObjectId, ref: 'Machine' },
        rate: { type: Number },
        _id: false,
      }],
      // ME-03: persist effectiveFrom + includeStitchUnit so the salary doc
      // captures the complete config-of-record at compute time.
      effectiveFrom: { type: Date, default: null },
      includeStitchUnit: { type: Boolean, default: true },
    },
    default: null,
    _id: false,
  })
  pieceRateConfigSnapshot: {
    unit: PieceRateUnit;
    defaultRate: number;
    basePortion: number;
    perMachineOverrides: { machineId: Types.ObjectId; rate: number }[];
    effectiveFrom?: Date | null;
    includeStitchUnit?: boolean;
  } | null;

  @Prop({
    type: [{
      logId: { type: Types.ObjectId, ref: 'ProductionLog' },
      downtimeCode: { type: String },
      date: { type: String },
      machineId: { type: Types.ObjectId, ref: 'Machine' },
      machineCode: { type: String },
      metricLabel: { type: String },
      qty: { type: Number },
      rate: { type: Number },
      amount: { type: Number },
      _id: false,
    }],
    default: [],
  })
  pieceRateBreakdown: Array<{
    logId: Types.ObjectId;
    downtimeCode: string;
    date: string;
    machineId: Types.ObjectId;
    machineCode: string;
    metricLabel: string;
    qty: number;
    rate: number;
    amount: number;
  }>;

  @Prop({ type: Boolean, default: false, index: true })
  pieceRateStale: boolean;

  @Prop({ type: String, enum: ['pending', 'partial', 'paid', 'advance'], default: 'pending' })
  status: string;

  @Prop({ type: Boolean, default: false })
  isLocked: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  lockedBy?: User | Types.ObjectId;

  @Prop({ type: Date })
  lockedAt?: Date;

  @Prop({ type: Date, default: null })
  payslipEmailSentAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  payslipEmailSentBy?: User | Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: User | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: User | Types.ObjectId;
}

export const SalarySchema = SchemaFactory.createForClass(Salary);

SalarySchema.index(
  { workspaceId: 1, teamMemberId: 1, month: 1, year: 1 },
  { unique: true },
);

// Salary paginated list: workspace + month/year without member
SalarySchema.index({ workspaceId: 1, month: 1, year: 1 });

// Phase 23 (D-07) — Stale-flag query path (Salary list returns "Recompute" badge)
SalarySchema.index({ workspaceId: 1, month: 1, year: 1, pieceRateStale: 1 });
