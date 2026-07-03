import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { ConnectProfile } from './schemas/connect-profile.schema';
import { WorkspaceMember } from '../../workspaces/schemas/workspace-member.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { ERP_VERIFY_CONSENT_VERSION, type ErpConsentStatus } from './erp-verification.constants';

/**
 * The consent state the web needs to render the suggestion banner + the
 * settings toggle (2026-06-18 spec).
 *  - `eligible`           the user has ≥ 1 active workspace membership (the only
 *                         people for whom an ERP badge could ever derive). A
 *                         read-only check — no consent needed to COMPUTE it.
 *  - `consentStatus`      'granted' | 'revoked' | null (never asked).
 *  - `suggestionDismissed` whether the one-time "verify" banner was dismissed.
 *  - `consentVersion`     the version the user agreed to (null when not granted).
 */
export interface ErpVerificationState {
  eligible: boolean;
  consentStatus: ErpConsentStatus | null;
  suggestionDismissed: boolean;
  consentVersion: string | null;
}

/**
 * Consent-first ERP-linked verification — person consent service (ADR-0004 /
 * 2026-06-18 spec).
 *
 * Owns the `ConnectProfile.erpVerificationConsent` lifecycle: grant / revoke /
 * dismiss + the eligibility-and-state read the web suggestion banner uses. The
 * PROFILE ERP badge is consent-gated server-side by `ErpLinkService.getUserStatus`
 * (which reads the `status` this service writes); voluntary actions are silent
 * (no notification), only audited + analytics-tracked.
 *
 * Cross-module: writes the `ConnectProfile` collection (owned by the profile
 * module); reads `WorkspaceMember` for eligibility; audits under `AppModule.CONNECT`.
 */
@Injectable()
export class ErpVerificationService {
  private readonly logger = new Logger(ErpVerificationService.name);

  constructor(
    @InjectModel(ConnectProfile.name)
    private readonly profileModel: Model<ConnectProfile>,
    @InjectModel(WorkspaceMember.name)
    private readonly workspaceMemberModel: Model<WorkspaceMember>,
    private readonly audit: AuditService,
    /** @Optional + LAST so positional unit-test constructors keep working; the
     *  @Global PostHogService is supplied by DI in production (no-op when unset). */
    @Optional() private readonly posthog?: PostHogService,
  ) {}

  /**
   * Grant ERP-verification consent — turns the PROFILE ERP badge ON (subject to
   * the live activity derivation). Stamps `status: 'granted'`, `grantedAt`, the
   * current `consentVersion`, and clears any prior `revokedAt`. Upserts on the
   * lazily-created profile. Audited + PostHog (a meaningful write). Returns the
   * fresh state for the web to re-render.
   */
  async grant(userId: string | Types.ObjectId): Promise<ErpVerificationState> {
    const uid = new Types.ObjectId(userId);
    const now = new Date();
    await this.profileModel
      .updateOne(
        { userId: uid },
        {
          $set: {
            erpVerificationConsent: {
              status: 'granted',
              grantedAt: now,
              revokedAt: null,
              consentVersion: ERP_VERIFY_CONSENT_VERSION,
            },
          },
        },
        // Upsert so a user who hasn't onboarded Connect (no profile row yet) can
        // still grant — the lazy profile is materialised with the consent set.
        { upsert: true },
      )
      .exec();

    await this.audit.logEvent({
      workspaceId: null, // identity-layer event — no workspace scope
      module: AppModule.CONNECT,
      entityType: 'ConnectProfile',
      entityId: String(uid),
      action: 'erp_verification_consent_granted',
      actorId: String(uid),
      meta: { consentVersion: ERP_VERIFY_CONSENT_VERSION },
    });
    this.posthog?.capture({
      distinctId: String(uid),
      event: 'connect.erp_verification_consent_granted',
      properties: { consentVersion: ERP_VERIFY_CONSENT_VERSION },
    });
    return this.getState(uid);
  }

  /**
   * Revoke ERP-verification consent — turns the PROFILE ERP badge OFF
   * immediately (`getUserStatus` returns `{ linked: false }` and we stop reading
   * ERP activity). Stamps `status: 'revoked'`, `revokedAt`, clears `grantedAt`.
   * A no-op-safe `updateOne` (a never-consented user simply records a revoked
   * marker). Audited + PostHog.
   */
  async revoke(userId: string | Types.ObjectId): Promise<ErpVerificationState> {
    const uid = new Types.ObjectId(userId);
    const now = new Date();
    await this.profileModel
      .updateOne(
        { userId: uid },
        {
          $set: {
            erpVerificationConsent: {
              status: 'revoked',
              grantedAt: null,
              revokedAt: now,
              consentVersion: ERP_VERIFY_CONSENT_VERSION,
            },
          },
        },
      )
      .exec();

    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'ConnectProfile',
      entityId: String(uid),
      action: 'erp_verification_consent_revoked',
      actorId: String(uid),
    });
    this.posthog?.capture({
      distinctId: String(uid),
      event: 'connect.erp_verification_consent_revoked',
      properties: {},
    });
    return this.getState(uid);
  }

  /**
   * Record "Not now" on the one-time suggestion banner so it stops nagging.
   * Stamps `erpSuggestionDismissedAt`. A read-only-ish UX preference, not a
   * trust write — audited at info level, no PostHog noise.
   */
  async dismissSuggestion(userId: string | Types.ObjectId): Promise<ErpVerificationState> {
    const uid = new Types.ObjectId(userId);
    await this.profileModel
      .updateOne(
        { userId: uid },
        { $set: { erpSuggestionDismissedAt: new Date() } },
        { upsert: true },
      )
      .exec();
    await this.audit.logEvent({
      workspaceId: null,
      module: AppModule.CONNECT,
      entityType: 'ConnectProfile',
      entityId: String(uid),
      action: 'erp_verification_suggestion_dismissed',
      actorId: String(uid),
    });
    return this.getState(uid);
  }

  /**
   * The consent + eligibility state for the web. `eligible` is computed live
   * (≥ 1 active `WorkspaceMember`) so the suggestion banner can show even before
   * the user has ever consented. Degrades safely: a read fault on eligibility
   * resolves to `eligible: false` (the banner just doesn't show).
   */
  async getState(userId: string | Types.ObjectId): Promise<ErpVerificationState> {
    const uid = new Types.ObjectId(userId);
    const [profile, eligible] = await Promise.all([
      this.profileModel
        .findOne({ userId: uid })
        .select('erpVerificationConsent erpSuggestionDismissedAt')
        .lean<{
          erpVerificationConsent?: { status?: ErpConsentStatus; consentVersion?: string } | null;
          erpSuggestionDismissedAt?: Date | null;
        }>()
        .exec(),
      this.isEligible(uid),
    ]);
    const consent = profile?.erpVerificationConsent ?? null;
    return {
      eligible,
      consentStatus: consent?.status ?? null,
      suggestionDismissed: !!profile?.erpSuggestionDismissedAt,
      consentVersion: consent?.status === 'granted' ? (consent.consentVersion ?? null) : null,
    };
  }

  /** Whether the user has ≥ 1 active workspace membership (badge-eligible). */
  private async isEligible(userId: Types.ObjectId): Promise<boolean> {
    try {
      const count = await this.workspaceMemberModel
        .countDocuments({ userId, status: 'active' })
        .exec();
      return count > 0;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ErpVerificationService.isEligible read failed for user ${String(userId)} — treating as not eligible. ${detail}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.erp-verification', op: 'isEligible' },
      });
      return false;
    }
  }
}
