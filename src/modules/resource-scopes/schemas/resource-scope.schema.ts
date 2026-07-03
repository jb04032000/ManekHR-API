import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'resource_scopes' })
export class ResourceScope extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  // Platform User (not TeamMember). Scope applies to dashboard users who
  // hold an RBAC role via WorkspaceMember.
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: [Types.ObjectId], ref: 'Machine', default: [] })
  machineIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], ref: 'Location', default: [] })
  locationIds: Types.ObjectId[];

  @Prop({ trim: true, maxlength: 200 })
  notes?: string;

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const ResourceScopeSchema = SchemaFactory.createForClass(ResourceScope);

// One scope row per (workspace, user).
ResourceScopeSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
