import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import {
  CandidateRequest,
  type CandidateRequestDocument,
} from './schemas/candidate-request.schema';
import { CompanyPage } from '../entities/schemas/company-page.schema';
import { User } from '../../users/schemas/user.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { InboxService } from '../inbox/inbox.service';
import {
  CONNECT_INBOX_THREAD_ACTIVITY,
  type InboxThreadActivityEvent,
} from '../inbox/inbox.events';

/** Default first-message body when a business sends a hire lead with no pitch. */
const DEFAULT_HIRE_LEAD_BODY = 'We would like to hire your trained candidates.';

/**
 * ManekHR Connect -- `CandidateRequestService` (Institutes Phase 2, Feature 4:
 * hiring-leads-to-inbox).
 *
 * What this does: a business sends a "hire our trained candidates" request to an
 * institute. The service persists a `CandidateRequest` row AND seeds the institute
 * owner's UNIFIED inbox with a new `candidate_request` context thread (reusing the
 * inbox context-thread pipeline EXACTLY like InquiryService.seedInboxThread), so
 * the owner replies in one place. The thread carries only a context REF; the inbox
 * hydrates the subject card from the live `CandidateRequest` row at read time.
 *
 * Business rules (mirroring InquiryService):
 *   1. Institute-only + public gate. The target page must be `kind: 'institute'`
 *      AND `visibility: 'public'`, else 404 (no existence leak for a business page,
 *      a hidden page, or a missing page).
 *   2. Self-lead blocked. The page owner cannot send a hire lead to their own
 *      institute (reuses the inquiry self-block ForbiddenException code style).
 *   3. Best-effort side effects. The inbox seed + bell are wrapped + never fail the
 *      write (the durable CandidateRequest row is the contract).
 *
 * Cross-module links:
 *   - CompanyPage (Connect entities) -> the institute page + its `ownerUserId`
 *     (the recipient) + `kind` / `visibility` gate. Model token comes from
 *     ConnectEntitiesModule (which exports MongooseModule), registered again on
 *     this module's forFeature so the token resolves locally.
 *   - InboxService (Connect inbox) -> findOrCreateContextThread('CandidateRequest',
 *     id) + sendMessage(clientMsgId 'hirelead-<id>'). The status sync rides the
 *     decoupled CONNECT_INBOX_THREAD_ACTIVITY event (the inbox never imports this
 *     module), exactly like the inquiry status sync.
 *   - AuditService / PostHogService / NotificationsService -> the write seams.
 *
 * Keep in sync with: the `CandidateRequest` schema (status enum), the inbox
 * `candidate_request` channel + `CandidateRequest` context-entity type +
 * hydrateCandidateRequestContexts, and the web hire-lead composer + inbox card.
 */
@Injectable()
export class CandidateRequestService {
  private readonly logger = new Logger(CandidateRequestService.name);

  constructor(
    @InjectModel(CandidateRequest.name)
    private readonly candidateRequestModel: Model<CandidateRequestDocument>,
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel: Model<CompanyPage>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
    // The unified Inbox: a hire lead is seeded as a context thread so the institute
    // owner replies in one place. @Optional so unit tests can omit it.
    @Optional() @Inject(InboxService) private readonly inbox?: InboxService,
  ) {}

  /**
   * Surface a hire lead in the Inbox: find-or-create the context thread + seed the
   * business's first message. Idempotent (the thread pairKey + the
   * `hirelead-<id>` clientMsgId), so a self-heal re-run is safe. Non-fatal: a
   * messaging error logs but never fails the lead write. Copies
   * InquiryService.seedInboxThread exactly (only the contextEntityType +
   * clientMsgId prefix + default body differ).
   */
  private async seedInboxThread(
    fromUserId: string,
    instituteOwnerUserId: string,
    candidateRequestId: string,
    message: string,
  ): Promise<string | null> {
    if (!this.inbox) return null;
    try {
      const thread = await this.inbox.findOrCreateContextThread(
        fromUserId,
        instituteOwnerUserId,
        'CandidateRequest',
        candidateRequestId,
      );
      // A hire lead always carries a meaningful opening line: the business pitch
      // when present, otherwise a default so the owner has context to reply to.
      const body = (message ?? '').trim() || DEFAULT_HIRE_LEAD_BODY;
      await this.inbox.sendMessage(fromUserId, String(thread._id), {
        body,
        clientMsgId: `hirelead-${candidateRequestId}`,
      });
      return String(thread._id);
    } catch (e) {
      this.logger.warn(
        `inbox seed failed for candidate request ${candidateRequestId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  /**
   * Sync the hire-lead status from inbox activity (decoupled via the global
   * EventEmitter; the inbox never imports this module). Only the INSTITUTE OWNER's
   * activity advances the status: opening the thread -> `viewed`; replying ->
   * `replied`. Best-effort + idempotent (no-op once already advanced). Copies
   * InquiryService.onInboxThreadActivity, including the ObjectId validation before
   * findById.
   */
  @OnEvent(CONNECT_INBOX_THREAD_ACTIVITY)
  async onInboxThreadActivity(ev: InboxThreadActivityEvent): Promise<void> {
    if (
      ev.contextEntityType !== 'CandidateRequest' ||
      !Types.ObjectId.isValid(ev.contextEntityId)
    ) {
      return;
    }
    try {
      const lead = await this.candidateRequestModel.findById(ev.contextEntityId);
      if (!lead || ev.actorId !== String(lead.instituteOwnerUserId)) return;
      if (ev.kind === 'read' && lead.status === 'sent') {
        lead.status = 'viewed';
        await lead.save();
      } else if (ev.kind === 'reply' && (lead.status === 'sent' || lead.status === 'viewed')) {
        lead.status = 'replied';
        await lead.save();
      }
    } catch (e) {
      this.logger.warn(
        `candidate request status sync failed for ${ev.contextEntityId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Create a hire lead from the authenticated business user to the given institute
   * page. Enforces the institute-only + public gate + the self-lead block, persists
   * the CandidateRequest, then seeds the institute owner's inbox (best-effort) +
   * audits + emits PostHog + dispatches the bell.
   */
  async create(
    fromUserId: string,
    pageId: string,
    message?: string,
  ): Promise<CandidateRequestDocument> {
    if (!Types.ObjectId.isValid(pageId)) {
      throw new NotFoundException('Institute not found');
    }
    const pageObjectId = new Types.ObjectId(pageId);
    const fromObjectId = new Types.ObjectId(fromUserId);

    // Institute-only + public gate. Anything else 404s (no existence leak for a
    // business page / hidden page / missing page).
    const page = await this.companyPageModel
      .findOne({ _id: pageObjectId, kind: 'institute', visibility: 'public' })
      .lean<{ _id: Types.ObjectId; ownerUserId: Types.ObjectId; name?: string }>()
      .exec();
    if (!page) {
      throw new NotFoundException('Institute not found');
    }
    const instituteOwnerUserId = String(page.ownerUserId);

    if (instituteOwnerUserId === fromUserId) {
      throw new ForbiddenException({
        code: 'CONNECT_SELF_HIRE_LEAD_NOT_ALLOWED',
        message: 'You cannot send a hire lead to your own institute.',
      });
    }

    try {
      const lead = (await this.candidateRequestModel.create({
        companyPageId: pageObjectId,
        fromUserId: fromObjectId,
        instituteOwnerUserId: page.ownerUserId,
        message: message?.trim() ?? '',
        status: 'sent',
      })) as CandidateRequestDocument;

      await this.audit.logEvent({
        module: AppModule.CONNECT,
        entityType: 'CandidateRequest',
        entityId: String(lead._id),
        action: 'connect_hire_lead_created',
        actorId: fromUserId,
        meta: { pageId, instituteOwnerUserId },
      });
      this.posthog?.capture({
        distinctId: fromUserId,
        event: 'connect.hire_lead_created',
        properties: {
          pageId,
          instituteOwnerUserId,
          candidateRequestId: String(lead._id),
        },
      });

      // Seed the inbox thread FIRST so the bell notification can deep-link to the
      // conversation. Both are best-effort + never block the lead write.
      const threadId = await this.seedInboxThread(
        fromUserId,
        instituteOwnerUserId,
        String(lead._id),
        lead.message,
      );

      const sender = await this.userModel
        .findById(fromObjectId)
        .select('name')
        .lean<{ name?: string }>()
        .exec();
      const senderName = sender?.name?.trim() || 'A business';
      const instituteName = page.name?.trim() || 'your institute';
      void this.notifications
        ?.dispatch({
          recipientId: page.ownerUserId,
          actorId: fromObjectId,
          category: 'connect.hire_lead_received',
          entityType: 'CandidateRequest',
          entityId: String(lead._id),
          title: 'New hiring request',
          message: `${senderName} wants to hire candidates trained at ${instituteName}.`,
          // FE routing: open the conversation straight from the bell.
          metadata: threadId ? { threadId } : undefined,
        })
        .catch(() => undefined);

      return lead;
    } catch (err) {
      Sentry.captureException(err, { tags: { module: 'connect.candidate_request', op: 'create' } });
      throw err;
    }
  }
}
