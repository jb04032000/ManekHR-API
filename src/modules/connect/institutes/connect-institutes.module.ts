import { Module, OnModuleInit, Optional } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectProfileModule } from '../profile/connect-profile.module';
import { ConnectProfileService } from '../profile/connect-profile.service';
import { ConnectEntitiesModule } from '../entities/entities.module';
import { CompanyPageService } from '../entities/services/company-page.service';
import { ConnectInboxModule } from '../inbox/inbox.module';
import { AuditModule } from '../../audit/audit.module';
import { AuditService } from '../../audit/audit.service';
import { NotificationsModule } from '../../notifications/notifications.module';
import { NotificationsService } from '../../notifications/notifications.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { CandidateRequest, CandidateRequestSchema } from './schemas/candidate-request.schema';
import { ConnectPageInvite, ConnectPageInviteSchema } from './schemas/connect-page-invite.schema';
import { InstituteCredentialsController } from './institute-credentials.controller';
import { InstitutePublicController } from './institute-public.controller';
import { CandidateRequestController } from './candidate-request.controller';
import { CandidateRequestService } from './candidate-request.service';
import { StudentInvitesController } from './student-invites.controller';
import { ConnectPageInviteService } from './connect-page-invite.service';
import { InstituteReferralService } from './institute-referral.service';

/**
 * ManekHR Connect Institutes module (Institutes Phase 2).
 *
 * What this does: hosts ALL Phase-2 institute surfaces. Feature 2 ships the
 * page-owner credential confirm/decline + pending-list controller (authed admin);
 * Feature 3 (this pass) ships the PUBLIC institute-page reads - the Alumni /
 * Open-to-work tab + the Placement wall ("where our students work") - via
 * `InstitutePublicController` (`@Public()`, DPDP-gated in the service).
 *
 * Why a NEW leaf module: the institute-admin path needs BOTH
 * `ConnectProfileService` (owns the ConnectProfile + the training[] credentials)
 * AND `CompanyPageService.getMine` (the page-owner gate, owned by
 * ConnectEntitiesModule). ConnectEntitiesModule already imports
 * ConnectProfileModule (for ErpLinkService), so the profile/entities pair cannot
 * import each other without a cycle. This module sits ABOVE both, imports both,
 * and is a LEAF (NOTHING imports it), so adding it introduces no circular
 * import. It is registered in the parent app wiring (app.module.ts) only.
 *
 * Cross-module wiring: the Feature 2 confirm/decline logic lives on
 * ConnectProfileService (per the task) but ConnectProfileService cannot statically
 * depend on CompanyPageService / NotificationsService without re-creating the
 * cycle. So this module (the one place that can see all of them) injects the
 * page-admin gate + audit/analytics/bell into ConnectProfileService at boot via
 * `setInstituteDeps` (setter injection). Keep `setInstituteDeps` in sync with the
 * InstituteDeps shape in connect-profile.service.ts.
 *
 * Feature 4 ships hiring-leads-to-inbox: a business sends a "hire our
 * trained candidates" request to an institute page (`CandidateRequestController` +
 * `CandidateRequestService`), which persists a `CandidateRequest` row AND seeds the
 * institute owner's unified inbox with a new `candidate_request` context thread
 * (reusing the inbox context-thread pipeline). This adds `ConnectInboxModule`
 * (for `InboxService`) to the imports + registers the `CandidateRequest` + `User`
 * model tokens via `forFeature` (the `CompanyPage` token rides
 * ConnectEntitiesModule's exported MongooseModule). The hire-lead status sync runs
 * via the decoupled CONNECT_INBOX_THREAD_ACTIVITY event (the inbox never imports
 * this module), so it needs no extra wiring.
 *
 * Feature 5 (this pass) ships bulk student invite + first-touch referral
 * attribution. `StudentInvitesController` + `ConnectPageInviteService` let a page
 * owner bulk-invite student phone numbers (writing `ConnectPageInvite` rows +
 * returning wa.me-share tokens) and read the page's joined/pending metrics, both
 * page-owner gated via `CompanyPageService.getMine` and strictly scoped to the
 * caller's own pageId. Attribution is event-driven: `ConnectProfileService` emits
 * `connect.profile.created` on first Connect onboarding, and
 * `InstituteReferralService` (an `@OnEvent` handler here) credits the FIRST
 * institute that invited that mobile by stamping `User.invitedByCompanyPageId`
 * (first-touch, never overwritten) + claiming the matching invites. This registers
 * the `ConnectPageInvite` model token via `forFeature` (the `User` token is already
 * registered for Feature 4; `CompanyPageService` rides ConnectEntitiesModule). The
 * referral handler is wired purely by the global EventEmitter, so it needs no
 * import of the profile service (no module cycle). The ONLY edit outside Connect is
 * the additive `User.invitedByCompanyPageId` field (default null, no migration).
 *
 * Imports:
 *  - ConnectProfileModule  -> ConnectProfileService (credential read/write).
 *  - ConnectEntitiesModule -> CompanyPageService    (page-owner getMine gate) +
 *                             the CompanyPage model token (exported MongooseModule).
 *  - ConnectInboxModule    -> InboxService          (seed the hire-lead thread).
 *  - AuditModule           -> AuditService          (decision + lead audit trail).
 *  - NotificationsModule   -> NotificationsService  (best-effort student/owner bell).
 *  - MongooseModule.forFeature(CandidateRequest, User) -> the hire-lead model + the
 *                             sender-name lookup.
 *  (PostHogService is @Global, injected without an import.)
 */
@Module({
  imports: [
    ConnectProfileModule,
    ConnectEntitiesModule,
    ConnectInboxModule,
    AuditModule,
    NotificationsModule,
    MongooseModule.forFeature([
      { name: CandidateRequest.name, schema: CandidateRequestSchema },
      { name: ConnectPageInvite.name, schema: ConnectPageInviteSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [
    InstituteCredentialsController,
    InstitutePublicController,
    CandidateRequestController,
    StudentInvitesController,
  ],
  providers: [CandidateRequestService, ConnectPageInviteService, InstituteReferralService],
})
export class ConnectInstitutesModule implements OnModuleInit {
  constructor(
    private readonly profiles: ConnectProfileService,
    private readonly companyPages: CompanyPageService,
    private readonly audit: AuditService,
    // @Global; @Optional so a keyless/degraded boot still wires the rest.
    @Optional() private readonly posthog?: PostHogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Wire the institute-side seams into ConnectProfileService once the DI graph is
   * built. This is the cycle-free injection point for the page-admin gate +
   * audit/analytics/bell that the Feature 2 confirm/decline methods need.
   */
  onModuleInit(): void {
    this.profiles.setInstituteDeps({
      companyPages: this.companyPages,
      audit: this.audit,
      posthog: this.posthog,
      notifications: this.notifications,
    });
  }
}
