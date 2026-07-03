import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { CompanyPage, type CompanyPageDocument } from './schemas/company-page.schema';
import { Storefront, type StorefrontDocument } from './schemas/storefront.schema';
import {
  WORKSPACE_DELETED,
  type WorkspaceDeletedEvent,
} from '../../workspaces/events/workspace.events';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { NotificationsService } from '../../notifications/notifications.service';

/**
 * Consent-first ERP-linked verification — workspace-delete cascade (ADR-0004 /
 * 2026-06-18 spec).
 *
 * Listens for `workspace.deleted` (emitted by `WorkspacesService` on owner
 * delete AND owner account-erasure). For every `CompanyPage` / `Storefront` that
 * pointed at the deleted workspace it:
 *   1. clears the dangling link (`erpWorkspaceId: null`, `erpLink.status: 'revoked'`)
 *      so the trust badge drops and no derivation ever reads a deleted workspace;
 *   2. audits the involuntary trust loss with `actor = system`;
 *   3. notifies the ENTITY owner ("ERP-linked badge removed — the linked
 *      workspace was deleted") — the one involuntary badge loss we tell users
 *      about (voluntary unlinks stay silent, per the spec deletion matrix).
 *
 * The whole body is wrapped in try/catch + `Sentry.captureException`: badge
 * cleanup is a SIDE EFFECT of the workspace delete and must NEVER throw back
 * into that flow (the emit is fire-and-forget). The derive-live decay is the
 * safety net if this listener misses; this listener makes the cleanup immediate
 * + observable.
 *
 * Cross-module: reads/writes the Connect entities collections; depends on the
 * `workspace.deleted` event (WorkspacesModule) + NotificationsService. No static
 * import of WorkspacesService (one-way event dependency, no module cycle).
 */
/**
 * The all-zeros ObjectId used as the audit `actorId` for a SYSTEM action — the
 * involuntary workspace-delete cascade has no human actor. Matches the existing
 * "system actor" convention in finance (sale-invoice / payment-receipt /
 * migrations). A plain `'system'` string would crash `AuditService.logEvent`,
 * which coerces `actorId` via `new Types.ObjectId(...)`.
 */
const SYSTEM_ACTOR_ID = '000000000000000000000000';

@Injectable()
export class ConnectErpLifecycleService {
  private readonly logger = new Logger(ConnectErpLifecycleService.name);

  constructor(
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel: Model<CompanyPageDocument>,
    @InjectModel(Storefront.name)
    private readonly storefrontModel: Model<StorefrontDocument>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(WORKSPACE_DELETED, { async: true })
  async handleWorkspaceDeleted(payload: WorkspaceDeletedEvent): Promise<void> {
    try {
      if (!payload?.workspaceId || !Types.ObjectId.isValid(payload.workspaceId)) return;
      const wsId = new Types.ObjectId(payload.workspaceId);

      await Promise.all([
        this.clearLinks(this.companyPageModel, wsId, 'CompanyPage'),
        // The two collections share the ERP-link field shape; cast to the common
        // model type so one helper serves both without a union-resolver headache.
        this.clearLinks(
          this.storefrontModel as unknown as Model<CompanyPageDocument>,
          wsId,
          'Storefront',
        ),
      ]);
    } catch (err) {
      // Cleanup must never throw into the workspace-delete flow (the derive-live
      // decay is the backstop). Log + Sentry so the missed cleanup is visible.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `ConnectErpLifecycleService cascade failed for workspace ${payload?.workspaceId ?? '-'}: ${detail}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'connect.erp-lifecycle', op: 'workspace_deleted' },
        extra: { workspaceId: payload?.workspaceId },
      });
    }
  }

  /**
   * Clear the dangling ERP link on every entity of one collection that pointed
   * at the deleted workspace, audit each (actor=system), and notify the entity
   * owner. Per-entity update so each owner gets exactly one notification, and a
   * single failed row never aborts the rest (logged + Sentry, then continue).
   */
  private async clearLinks(
    // One model type (not the `Model<A> | Model<B>` union, which trips the type
    // resolver on every chained query call): the two entity collections share an
    // identical ERP-link field shape, so the storefront model is cast to this at
    // the call site. The lean projection below pins the precise read shape.
    model: Model<CompanyPageDocument>,
    workspaceId: Types.ObjectId,
    entityType: 'CompanyPage' | 'Storefront',
  ): Promise<void> {
    const affected = await model
      .find({ erpWorkspaceId: workspaceId })
      .select('_id ownerUserId name erpLink')
      .lean<
        Array<{
          _id: Types.ObjectId;
          ownerUserId: Types.ObjectId;
          name?: string;
          erpLink?: { status?: string; linkedByUserId?: Types.ObjectId; consentVersion?: string };
        }>
      >()
      .exec();
    if (affected.length === 0) return;

    for (const entity of affected) {
      try {
        // Mark the existing link revoked (preserve who/version for the trail) and
        // null the workspace pointer so the badge drops + no read touches the
        // deleted workspace. If there was no `erpLink` sub-doc (legacy dangling
        // pointer), still clear the pointer and stamp a revoked marker.
        const revokedLink = entity.erpLink
          ? { ...entity.erpLink, status: 'revoked', linkedAt: null }
          : { status: 'revoked', linkedAt: null };
        await model
          .updateOne(
            { _id: entity._id },
            {
              $set: {
                erpWorkspaceId: null,
                'erpLink.status': 'revoked',
                'erpLink.linkedAt': null,
              },
            },
          )
          .exec();
        // Belt-and-suspenders: ensure the revoked link object exists even when no
        // prior sub-doc was present (the dotted `$set` above no-ops if erpLink is
        // null), so the entity reads as not-verified afterwards.
        if (!entity.erpLink) {
          await model.updateOne({ _id: entity._id }, { $set: { erpLink: revokedLink } }).exec();
        }

        await this.audit.logEvent({
          workspaceId: null, // the workspace is gone; identity-layer cleanup
          module: AppModule.CONNECT,
          entityType,
          entityId: String(entity._id),
          action:
            entityType === 'CompanyPage' ? 'company_page_erp_unlinked' : 'storefront_erp_unlinked',
          actorId: SYSTEM_ACTOR_ID, // involuntary cascade, not the owner
          meta: { reason: 'workspace_deleted', workspaceId: String(workspaceId) },
        });

        // Notify the entity owner — the one involuntary badge loss we surface.
        await this.notifications.dispatch({
          recipientId: entity.ownerUserId,
          category: 'connect.erp_badge_removed',
          title: 'ERP-linked badge removed',
          message: `The ERP-linked badge on "${entity.name ?? 'your page'}" was removed because the linked workspace was deleted.`,
          actorId: null, // system event
          entityType,
          entityId: String(entity._id),
          type: 'warning',
          metadata: { reason: 'workspace_deleted' },
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `ERP-link cascade clear failed for ${entityType} ${String(entity._id)}: ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect.erp-lifecycle', op: 'clearLink' },
          extra: { entityType, entityId: String(entity._id) },
        });
      }
    }
  }
}
