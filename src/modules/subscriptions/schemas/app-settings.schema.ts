import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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
