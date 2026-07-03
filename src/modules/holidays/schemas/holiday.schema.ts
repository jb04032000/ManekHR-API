import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Holiday extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ required: true }) name: string;

  @Prop({ required: true, type: Date }) date: Date;

  @Prop() description?: string;

  @Prop({ default: false }) isRecurring: boolean;

  @Prop({
    enum: ['national', 'festival', 'company', 'other'],
    default: 'national',
  })
  type: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: User | Types.ObjectId;
}

export const HolidaySchema = SchemaFactory.createForClass(Holiday);

HolidaySchema.index({ workspaceId: 1, date: 1 }, { unique: true });
