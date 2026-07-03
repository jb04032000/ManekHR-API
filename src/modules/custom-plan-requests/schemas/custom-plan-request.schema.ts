import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Custom Plan Request -- a sales lead captured when a user's needs don't fit the
 * self-serve plans (Free/Starter/Growth/Business). Surfaced on the in-app Plans
 * hub (app/account/subscription/plans) via a "Request a custom plan" form, and
 * triaged by an admin in app/admin/custom-plan-requests.
 *
 * Pure lead capture: NO subscription is created here. An admin reads the request,
 * calls the user on the captured mobile, and sets up a tailored plan manually via
 * the existing admin custom-plan flow (admin/billing/plans). The status field is
 * a simple triage queue: new -> contacted -> closed.
 *
 * Two kinds of lead share this collection (see `kind`):
 *  - 'custom' -- the "Request a custom plan" form (team size + mobile + note).
 *  - 'plan'   -- a Subscribe click on a predefined paid plan while online payments
 *    are off (captures the plan + a callback mobile so the team reaches out). Set
 *    by SubscriptionsController's plan-interest route; admin sees both in one list.
 *
 * Cross-module links:
 *  - userId -> User (the requester). name/email are denormalized at create time
 *    so the admin list never needs a join.
 *  - planId -> Plan (only for kind='plan'); planTier/planName are denormalized so
 *    the admin list shows which plan was clicked without a join.
 * Additive only (brand-new collection); every @Prop carries an explicit { type }
 * so the repo's Vitest SWC transform resolves SchemaFactory.createForClass.
 */
export const CUSTOM_PLAN_REQUEST_STATUSES = ['new', 'contacted', 'closed'] as const;
export type CustomPlanRequestStatus = (typeof CUSTOM_PLAN_REQUEST_STATUSES)[number];

// Which surface produced the lead. 'custom' = the tailored-plan request form;
// 'plan' = a Subscribe click on a predefined paid plan (payments-off path).
export const CUSTOM_PLAN_REQUEST_KINDS = ['custom', 'plan'] as const;
export type CustomPlanRequestKind = (typeof CUSTOM_PLAN_REQUEST_KINDS)[number];

export const CUSTOM_PLAN_REQUEST_NOTE_MAX = 1000;

@Schema({ timestamps: true, collection: 'custom_plan_requests' })
export class CustomPlanRequest extends Document {
  /** The requesting user. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  /** Denormalized requester identity for the admin list (no join needed). */
  @Prop({ type: String, trim: true, default: '' })
  userName: string;

  @Prop({ type: String, trim: true, default: '' })
  userEmail: string;

  /** Product line the request targets (ERP today; future-proofed for Connect). */
  @Prop({ type: String, enum: ['erp', 'connect'], default: 'erp' })
  product: string;

  /** Lead kind: 'custom' (tailored-plan form) or 'plan' (predefined-plan click). */
  @Prop({ type: String, enum: CUSTOM_PLAN_REQUEST_KINDS, default: 'custom', index: true })
  kind: CustomPlanRequestKind;

  /** The predefined plan the user clicked Subscribe on (kind='plan' only). */
  @Prop({ type: Types.ObjectId, ref: 'Plan', default: null })
  planId: Types.ObjectId | null;

  /** Denormalized plan tier + name for the admin list (kind='plan' only). */
  @Prop({ type: String, trim: true, default: '' })
  planTier: string;

  @Prop({ type: String, trim: true, default: '' })
  planName: string;

  /**
   * Total team members the user expects. Required for the custom form (enforced
   * by its DTO); OPTIONAL here because a plan-interest click may omit it (the
   * Subscribe popup asks for it but does not force it).
   */
  @Prop({ type: Number, min: 1 })
  teamMembers?: number;

  /** Number of companies / factories the user runs (optional). */
  @Prop({ type: Number, min: 0, default: 0 })
  companiesOrFactories: number;

  /** Contact mobile so the team can reach out directly (required). */
  @Prop({ type: String, trim: true, required: true })
  mobile: string;

  /** Anything else the user wants to mention (optional, capped). */
  @Prop({ type: String, trim: true, maxlength: CUSTOM_PLAN_REQUEST_NOTE_MAX, default: '' })
  note: string;

  /** Triage lifecycle: new -> contacted -> closed. */
  @Prop({ type: String, enum: CUSTOM_PLAN_REQUEST_STATUSES, default: 'new', index: true })
  status: CustomPlanRequestStatus;

  /** Admin who last actioned this request. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  handledByUserId: Types.ObjectId | null;

  /** Internal admin note (never shown to the user). */
  @Prop({ type: String, trim: true, maxlength: CUSTOM_PLAN_REQUEST_NOTE_MAX, default: '' })
  adminNote: string;

  // `createdAt` / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type CustomPlanRequestDocument = CustomPlanRequest & Document;

export const CustomPlanRequestSchema = SchemaFactory.createForClass(CustomPlanRequest);

// Admin triage queue: filter by status, newest first.
CustomPlanRequestSchema.index({ status: 1, createdAt: -1 });
