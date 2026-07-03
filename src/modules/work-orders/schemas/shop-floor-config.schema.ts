import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ShopFloorFloor — one named floor inside a physical location. Order in the
 * parent array IS the display order on the web Shop Floor Setup wizard
 * (app/dashboard/machines/shop-floor) — never sort server-side.
 *
 * All `@Prop` decorators use explicit `{ type: ... }` to dodge the Mongoose
 * 8.23 autocast bug (memory: project_attendance_module_session_2026-04-22.md).
 */
@Schema({ _id: false })
export class ShopFloorFloor {
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  name: string;
}

export const ShopFloorFloorSchema = SchemaFactory.createForClass(ShopFloorFloor);

/**
 * ShopFloorPerson — team member linked to one floor of the location.
 * `floor` must equal one of the parent doc's floors[].name (service-validated
 * on every upsert; renaming a floor requires re-submitting its people).
 */
@Schema({ _id: false })
export class ShopFloorPerson {
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  floor: string;
}

export const ShopFloorPersonSchema = SchemaFactory.createForClass(ShopFloorPerson);

/**
 * ShopFloorConfig — per (workspace, location) floor layout + people links for
 * the web Shop Floor Setup wizard (app/dashboard/machines/shop-floor).
 * Machine→floor assignment is NOT stored here — that lives on
 * Machine.floorTag (machines module); the wizard PATCHes machines directly.
 */
@Schema({ timestamps: true, collection: 'shopfloorconfigs' })
export class ShopFloorConfig extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true })
  locationId: Types.ObjectId;

  @Prop({ type: [ShopFloorFloorSchema], default: [] })
  floors: ShopFloorFloor[];

  @Prop({ type: [ShopFloorPersonSchema], default: [] })
  people: ShopFloorPerson[];
}

export const ShopFloorConfigSchema = SchemaFactory.createForClass(ShopFloorConfig);

// One config per location per workspace — the PUT upsert key.
ShopFloorConfigSchema.index({ workspaceId: 1, locationId: 1 }, { unique: true });
