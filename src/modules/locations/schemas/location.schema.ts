import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'locations' })
export class Location extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  })
  workspaceId: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ trim: true, maxlength: 32 })
  locationCode?: string;

  @Prop({ trim: true })
  addressLine1?: string;

  @Prop({ trim: true })
  addressLine2?: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true })
  state?: string;

  @Prop({ trim: true, default: 'India' })
  country?: string;

  @Prop({ trim: true })
  pincode?: string;

  @Prop({ trim: true })
  timezone?: string;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const LocationSchema = SchemaFactory.createForClass(Location);

// Partial-unique: (workspaceId, name) among non-deleted rows.
LocationSchema.index(
  { workspaceId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

// Partial-unique: (workspaceId, locationCode) when code present among non-deleted.
LocationSchema.index(
  { workspaceId: 1, locationCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      locationCode: { $type: 'string' },
      isDeleted: false,
    },
  },
);
