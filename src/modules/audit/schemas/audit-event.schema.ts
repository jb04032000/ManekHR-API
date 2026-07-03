import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';
import { AppModule } from '../../../common/enums/modules.enum';

@Schema({ timestamps: true })
export class AuditEvent extends Document {
  /**
   * Workspace tenant for the event. Required for tenant-scoped business events
   * (salary edits, attendance changes, settings updates). Null for identity-
   * layer events that have no workspace context (auth lifecycle: login/logout/
   * register/password-reset/oauth). Existing tenant-scoped queries filter on
   * `workspaceId: <ObjectId>` so null rows are naturally excluded — no cross-
   * tenant leak risk. Cross-cutting admin queries on auth events use the
   * `{ module, action, createdAt }` index instead.
   */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  workspaceId: Workspace | Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(AppModule), required: true })
  module: AppModule;

  @Prop({ required: true, trim: true })
  entityType: string;

  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  action: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: User | Types.ObjectId;

  @Prop({ required: true, trim: true })
  actorNameSnapshot: string;

  @Prop({ type: Types.ObjectId })
  salaryId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  teamMemberId?: Types.ObjectId;

  @Prop()
  month?: number;

  @Prop()
  year?: number;

  @Prop({ type: SchemaTypes.Mixed })
  before?: Record<string, unknown>;

  @Prop({ type: SchemaTypes.Mixed })
  after?: Record<string, unknown>;

  @Prop({ type: SchemaTypes.Mixed })
  meta?: Record<string, unknown>;

  @Prop({ trim: true })
  reason?: string;

  /**
   * Tier-aware retention: computed at write time as
   * createdAt + tier.retention.auditLogDays (per MODULE_INVENTORY.md §3.5.4).
   * Null / unset = no expiry (Enterprise + Custom tiers).
   * MongoDB TTL index removes documents when expiresAt passes.
   */
  @Prop({ type: Date, required: false, default: null })
  expiresAt?: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);

AuditEventSchema.index({
  workspaceId: 1,
  entityType: 1,
  entityId: 1,
  createdAt: -1,
});
AuditEventSchema.index({ workspaceId: 1, module: 1, createdAt: -1 });

// Cross-cutting admin queries on identity-layer events (no workspaceId).
// Used for: "all login_failures in last 24h" (fraud screen), "register_success
// trend" (growth dashboard), etc.
AuditEventSchema.index({ module: 1, action: 1, createdAt: -1 });

// TTL index — Mongo deletes docs when expiresAt < now.
// Docs with expiresAt = null are NEVER deleted (Enterprise/Custom retention).
AuditEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'audit_event_ttl' });
