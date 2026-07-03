import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Bill extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ enum: ['payable', 'receivable'], required: true })
  type: string;

  @Prop({ required: true }) partyName: string;
  @Prop({ required: true }) amount: number; // Stored in smallest unit (e.g. paise)

  @Prop() description?: string;
  @Prop() invoiceUrl?: string; // S3 or equivalent URL

  @Prop({ required: true, type: Date }) dueDate: Date;
  @Prop({
    enum: ['pending', 'paid', 'partially_paid', 'overdue'],
    default: 'pending',
  })
  status: string;

  @Prop({ default: 0 }) amountPaid: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: User | Types.ObjectId;

  // ── Soft-delete (Finance/Bills hardening Pillar 1, BUG-FB-1) ───────────────
  // A Bill is a statutory AP/AR financial record (Bucket B, CGST Rule 56 / IT
  // Act s.44AA, 8y retention). A user-initiated delete MUST NOT hard-erase it
  // (the prior `findOneAndDelete` permanently destroyed the books + the invoice
  // file). These flags convert remove() into a soft-delete: the row + its
  // invoiceUrl evidence stay, but every user-facing read filters `isDeleted`.
  // Only the system retention purge (BillsRetentionPurgeCron, OFF by default,
  // 8y floor) ever physically deletes a soft-deleted legacy Bill. Mirrors the
  // PurchaseBill.isDeleted/deletedAt pattern (the canonical reference) plus the
  // member-side `deletedBy` so the actor is auditable. Additive optional fields
  // with safe defaults — no data migration needed (legacy rows read as active).
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) deletedBy?: User | Types.ObjectId;
}

export const BillSchema = SchemaFactory.createForClass(Bill);

// Read-path support: every list/get/count filters `{ isDeleted: false }`, so an
// index on (workspaceId, isDeleted, dueDate) keeps the workspace-scoped, active-
// only, due-date-sorted query index-driven instead of collection-scanning + in-
// memory filtering once soft-deleted rows accumulate.
BillSchema.index({ workspaceId: 1, isDeleted: 1, dueDate: 1 });
