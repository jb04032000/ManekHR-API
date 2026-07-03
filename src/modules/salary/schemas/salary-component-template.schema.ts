import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';

@Schema({ _id: false })
export class SalaryComponentDef {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    enum: ['percent_of_ctc', 'percent_of_component', 'fixed', 'balancing'],
  })
  calcMode: string;

  @Prop()
  value?: number;

  @Prop()
  referenceComponentId?: string;

  @Prop({ default: true })
  includedInCtc: boolean;

  @Prop({ default: false })
  isBasicComponent: boolean;

  @Prop({ default: true })
  isTaxable: boolean;

  @Prop({ default: false })
  isEmployerContribution?: boolean;

  @Prop({ required: true })
  sortOrder: number;
}

export const SalaryComponentDefSchema =
  SchemaFactory.createForClass(SalaryComponentDef);

@Schema({ timestamps: true })
export class SalaryComponentTemplate extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ type: [SalaryComponentDefSchema], required: true, minlength: 1 })
  components: SalaryComponentDef[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export const SalaryComponentTemplateSchema = SchemaFactory.createForClass(
  SalaryComponentTemplate,
);
