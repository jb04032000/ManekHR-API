import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Shift extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ required: true }) name: string;
  @Prop({ required: true }) startTime: string; // HH:mm format
  @Prop({ required: true }) endTime: string; // HH:mm format

  @Prop({ type: [Number], default: [1, 2, 3, 4, 5, 6] }) // 0=Sunday, 1-6=Mon-Sat
  workingDays: number[];

  @Prop({ type: [String], default: [] })
  weeklyOff: string[];

  @Prop({ default: '#2563EB' }) color: string;
  @Prop({ default: 'rgba(37,99,235,0.15)' }) colorBg: string;
  @Prop({ default: false }) isDefault: boolean;

  @Prop({ default: 0 }) gracePeriodMinutes: number;

  @Prop({ default: 60 })
  halfDayAfterLateMinutes: number;

  @Prop({
    type: String,
    enum: ['fixed', 'flexi', 'split', 'break'],
    default: 'fixed',
  })
  shiftType: 'fixed' | 'flexi' | 'split' | 'break';

  @Prop({ type: Types.ObjectId, ref: 'AttendancePolicy', default: null })
  policyId: Types.ObjectId | null;

  @Prop({ type: Number, default: null })
  requiredHoursPerDay: number | null;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: User | Types.ObjectId;
}

export const ShiftSchema = SchemaFactory.createForClass(Shift);
