import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'call_todos' })
export class CallTodo extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  partyId: Types.ObjectId;

  /** Optional — single invoice reference */
  @Prop({ type: Types.ObjectId })
  invoiceId?: Types.ObjectId;

  /** Optional — multi-invoice batched todos (e.g. all overdue invoices for a party) */
  @Prop({ type: [Types.ObjectId], default: [] })
  invoiceIds?: Types.ObjectId[];

  @Prop({ type: String, required: true, maxlength: 200 })
  title: string;

  @Prop({ type: String, maxlength: 2000 })
  notes?: string;

  @Prop({ type: String })
  contactPhone?: string;

  @Prop({ type: String })
  contactName?: string;

  /** Snapshot of total overdue amount at todo creation time (paise) */
  @Prop({ type: Number })
  totalOverdueAmountPaise?: number;

  @Prop({
    type: String,
    enum: ['payment_followup', 'sales_followup', 'service_reminder', 'other'],
    default: 'payment_followup',
  })
  callType: string;

  @Prop({
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  })
  priority: string;

  @Prop({ type: Date })
  dueDate?: Date;

  @Prop({ type: Date })
  scheduledFor?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  completedBy?: Types.ObjectId;

  @Prop({ type: String })
  completionNote?: string;

  @Prop({
    type: String,
    enum: ['pending', 'in_progress', 'done', 'snoozed', 'cancelled'],
    default: 'pending',
    index: true,
  })
  status: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  assignedTo: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  snoozeDays: number;

  /** true if auto-created by escalation-level-3 ReminderDispatcher */
  @Prop({ type: Boolean, default: false })
  autoCreated: boolean;
}

export const CallTodoSchema = SchemaFactory.createForClass(CallTodo);

/** Compound index for task list queries scoped by firm + assignee + status */
CallTodoSchema.index({ workspaceId: 1, firmId: 1, assignedTo: 1, status: 1 });
