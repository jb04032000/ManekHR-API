import { IsIn } from 'class-validator';

/**
 * The four onboarding intents a new Connect user picks from. Persisted on
 * `ConnectProfile.onboardingIntent` (read by the Connect-to-ERP cross-sell);
 * also drives one profile pre-set (a karigar is set open-to-work) + the
 * analytics event.
 */
export const CONNECT_ONBOARDING_INTENTS = [
  'workshop_owner',
  'karigar',
  'buyer',
  'explorer',
] as const;
export type ConnectOnboardingIntent = (typeof CONNECT_ONBOARDING_INTENTS)[number];

/** POST body for `/me/connect/profile/onboarding`. */
export class CompleteOnboardingDto {
  @IsIn(CONNECT_ONBOARDING_INTENTS)
  intent: ConnectOnboardingIntent;
}
