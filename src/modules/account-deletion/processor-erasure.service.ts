import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { UploadsService } from '../uploads/uploads.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/** Vendor-side artifacts captured BEFORE the Day-30 scrub nulls the User fields,
 *  so the cascade can still erase them at the processor afterwards. */
export interface ProcessorErasureArtifacts {
  /** The user's profile-photo URL (the scrub nulls `User.profilePicture`, but the
   *  uploaded OBJECT still lives in storage until this cascade deletes it). */
  profilePicture?: string | null;
}

/** Per-processor disposition, recorded in the audit trail for the grievance log. */
export interface ProcessorErasureSummary {
  profilePictureObjectDeleted: boolean;
  /** No revocable OAuth token is stored (sign-in is a googleId match only). */
  googleGrant: 'no-revocable-token';
  /** The device token is nulled by the scrub; a single token is not vendor-revoked. */
  fcmToken: 'cleared-at-scrub';
  /** Already de-indexed by the Connect content cascade (runs before the scrub). */
  meiliIndex: 'purged-by-connect-cascade';
  /** Customer PII retained under the billing/tax legal basis (Bucket B). */
  razorpay: 'retained-under-billing-basis';
  /** Processors whose erase step failed (best-effort; recorded, never thrown). */
  errors: string[];
}

/**
 * Phase 7 processor cascade — DPDP s.8(7) "erase at the processor"
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8). Runs at the Day-30 finalize, AFTER the
 * identity scrub, as the cascade seam documented in
 * {@link AccountDeletionFinalizeService.finalizeOne}.
 *
 * The scrub (`eraseAccount` / `buildBucketCScrubPatch`) already nulls the User's
 * `profilePicture`, `googleId` and `fcmToken` IN THE DATABASE. The only thing it
 * cannot reach is OUTSIDE the database: the uploaded profile-photo OBJECT in
 * storage. This service deletes that object at the vendor and records the
 * disposition of every other processor for the grievance trail (see
 * {@link ProcessorErasureSummary}). Google holds no revocable token, FCM is
 * locally-cleared, Meili is already purged by the Connect cascade, and Razorpay
 * PII is retained under the billing/tax basis — those are documented, audited
 * no-ops, not stubs.
 *
 * Best-effort (plan §8): a vendor failure is recorded + Sentry'd but never
 * thrown, because the scrub (the DPDP obligation) has already committed.
 *
 * Cross-module: UploadsService (storage object delete) + AuditService (trail).
 * Wired into AccountDeletionFinalizeService via @Optional DI.
 */
@Injectable()
export class ProcessorErasureService {
  private readonly logger = new Logger(ProcessorErasureService.name);

  constructor(
    private readonly uploads: UploadsService,
    private readonly auditService: AuditService,
  ) {}

  async eraseAtProcessors(
    userId: string,
    artifacts: ProcessorErasureArtifacts,
  ): Promise<ProcessorErasureSummary> {
    const summary: ProcessorErasureSummary = {
      profilePictureObjectDeleted: false,
      googleGrant: 'no-revocable-token',
      fcmToken: 'cleared-at-scrub',
      meiliIndex: 'purged-by-connect-cascade',
      razorpay: 'retained-under-billing-basis',
      errors: [],
    };

    // The one vendor-side artifact the DB scrub can't reach. deleteFile already
    // tolerates an already-removed object, so success means "deleted or absent";
    // we still guard so a storage outage degrades to a recorded error rather than
    // aborting the (already-committed) finalize.
    const url = artifacts.profilePicture;
    if (url) {
      try {
        await this.uploads.deleteFile(url);
        summary.profilePictureObjectDeleted = true;
      } catch (err) {
        summary.errors.push('profilePicture');
        this.logger.warn(
          `[eraseAtProcessors] profile-photo object delete failed for ${userId}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
        Sentry.captureException(err, {
          tags: { module: 'account-deletion', op: 'processorCascade.profilePicture' },
          extra: { userId },
        });
      }
    }

    // Audit the cascade (grievance trail). Awaited but best-effort — an audit
    // failure must never throw out of a post-scrub finalize step.
    await this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: userId,
        action: 'account_processor_erasure',
        actorId: userId,
        meta: { ...summary },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[eraseAtProcessors] cascade audit failed for ${userId}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      });

    return summary;
  }
}
