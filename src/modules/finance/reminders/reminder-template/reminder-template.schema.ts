import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Phase 17 / FIN-16-05 D-28 — Plan 17-06 extends `eventType` enum with
 * 'birthday_greeting' and 'anniversary_greeting'. The plan referenced a
 * `kind` field; this codebase uses `eventType` for the same concept (Rule 3
 * deviation — single source of truth retained, no new field added).
 *
 * For greeting templates we also relax `workspaceId` to optional so that the
 * seed file can install GLOBAL default templates with workspaceId === null.
 * Workspace-specific overrides continue to set workspaceId (D-28).
 */
@Schema({ timestamps: true, collection: 'reminder_templates' })
export class ReminderTemplate extends Document {
  /**
   * null/absent = global default template (used by FIN-16-05 greeting seeds).
   * Set = workspace-specific override.
   */
  @Prop({ type: Types.ObjectId, index: true })
  workspaceId?: Types.ObjectId | null;

  /** null = workspace-level default template */
  @Prop({ type: Types.ObjectId, index: true })
  firmId?: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['in_app', 'email', 'sms', 'push', 'whatsapp'],
    required: false,
  })
  channel?: string;

  @Prop({
    type: String,
    enum: [
      'invoice_overdue',
      'invoice_due_soon',
      'service_maintenance',
      'final_notice',
      // Phase 17 / FIN-16-05 D-28 — greeting kinds.
      'birthday_greeting',
      'anniversary_greeting',
    ],
    required: true,
  })
  eventType: string;

  /** Used by email channel only */
  @Prop({ type: String })
  subject?: string;

  @Prop({ type: String, required: true, maxlength: 5000 })
  body: string;

  /**
   * Available template variables, e.g.:
   * ['partyName','invoiceNumber','amountDue','dueDate','daysPastDue']
   */
  @Prop({ type: [String], default: [] })
  variables: string[];

  @Prop({ type: String, default: 'en' })
  language: string;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;
}

export const ReminderTemplateSchema = SchemaFactory.createForClass(ReminderTemplate);

/** Lookup index for template selection by channel + event type + language */
ReminderTemplateSchema.index({
  workspaceId: 1,
  firmId: 1,
  channel: 1,
  eventType: 1,
  language: 1,
});

/**
 * Phase 17 / FIN-16-05 — greeting-template lookup. Greeting templates are
 * channel-agnostic (the same body renders across whatsapp/email/sms with
 * email picking up `subject`). Index keyed on (workspaceId, eventType,
 * language) to support `getGreetingTemplate(wsId, kind, locale)` resolution
 * with a workspace-override-then-global-default fallback.
 */
ReminderTemplateSchema.index({
  workspaceId: 1,
  eventType: 1,
  language: 1,
  isDefault: 1,
});
