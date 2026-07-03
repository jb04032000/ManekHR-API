import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'workspace_counters' })
export class WorkspaceCounter extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    unique: true,
    index: true,
  })
  workspaceId: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  teamMemberCodeCounter: number;

  @Prop({ type: Number, default: 0 })
  machineCodeCounter: number;

  @Prop({ type: Number, default: 0 })
  locationCodeCounter: number;

  @Prop({ type: Number, default: 0, min: 0 })
  godownCodeCounter: number;

  @Prop({ type: Number, default: 0, min: 0 })
  productionLogCounter: number;

  @Prop({ type: Number, default: 0, min: 0 })
  downtimeCounter: number;

  @Prop({ type: Number, default: 0, min: 0 })
  maintenanceScheduleCounter: number;

  @Prop({ type: Number, default: 0, min: 0 })
  serviceLogCounter: number;

  // Shop Floor work orders — WO-NNN codes (web: app/dashboard/machines/shop-floor).
  @Prop({ type: Number, default: 0, min: 0 })
  workOrderCounter: number;
}

export const WorkspaceCounterSchema = SchemaFactory.createForClass(WorkspaceCounter);
