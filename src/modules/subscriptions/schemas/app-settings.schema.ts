import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Modules flagged "Coming Soon" by default on a fresh DB: the ManekHR
 * not-yet-built set (accounting group and machines group).
 * The flag only changes the LOCKED presentation (Coming Soon card instead of
 * the Upgrade prompt) — a workspace whose plan enables the module is
 * unaffected. Admin-editable anytime via PATCH /admin/settings
 * { comingSoonModules }. Keep in sync with the web admin availability editor
 * groups (manekhr-web components/admin/module-availability-editor.tsx).
 */
export const DEFAULT_COMING_SOON_MODULES: AppModule[] = [
  // Time & Attendance group — not completed yet
  // Accounting group (bill / finance) — not completed yet
  AppModule.FINANCE,
  AppModule.INVENTORY,
  AppModule.GST_COMPLIANCE,
  AppModule.JOB_WORK,
  AppModule.BILLS,
  // Machines group — not completed yet
  AppModule.MACHINES,
  AppModule.LOCATIONS,
  AppModule.RESOURCE_SCOPES,
  AppModule.MANUFACTURING,
  AppModule.DOWNTIME,
  AppModule.MAINTENANCE,
];

// Completed modules must never be presented as "Coming Soon", even if an older
// AppSettings document still carries the pre-completion defaults.
export const COMPLETED_MODULES_NOT_COMING_SOON = new Set<AppModule>([
  AppModule.ATTENDANCE,
  AppModule.LEAVE,
  AppModule.REGULARIZATION,
  AppModule.SHIFTS,
  AppModule.HOLIDAYS,
]);

/**
 * Site-wide 45-day free-trial BANNER config. Admin-dynamic: the admin can turn
 * the banner on/off and optionally override its headline text. When
 * `headlineOverride` is empty the front end renders its own localized default
 * (the backend only stores the override string).
 */
@Schema({ _id: false })
export class TrialBannerSettings {
  /** Whether the trial banner is shown. */
  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  /** Optional admin custom banner text. Empty = FE shows its localized default. */
  @Prop({ type: String, default: '' })
  headlineOverride: string;
}

@Schema({ timestamps: true })
export class AppSettings extends Document {
  @Prop({ default: true })
  freeTierEnabled: boolean;

  /** Admin-dynamic 45-day free-trial banner (on/off + optional custom text). */
  @Prop({ type: TrialBannerSettings, default: () => ({ enabled: true, headlineOverride: '' }) })
  trialBanner: TrialBannerSettings;

  /**
   * Modules the platform shows as "Coming Soon" when locked, instead of the
   * plan-upgrade prompt. Presentation-only: SubscriptionGuard still 403s and
   * nav still locks; this only tells the web WHICH locked card to render.
   * Served publicly via GET /subscriptions/public/module-availability.
   */
  @Prop({ type: [String], enum: AppModule, default: () => [...DEFAULT_COMING_SOON_MODULES] })
  comingSoonModules: AppModule[];

  @Prop({
    type: {
      logo: String,
      pdfHeaderLogo: String,
      pdfWatermarkLogo: String,
      pdfFooterDetails: String,
    },
    default: undefined,
    _id: false,
  })
  defaultBranding?: {
    logo?: string;
    pdfHeaderLogo?: string;
    pdfWatermarkLogo?: string;
    pdfFooterDetails?: string;
  };
}

export const AppSettingsSchema = SchemaFactory.createForClass(AppSettings);
