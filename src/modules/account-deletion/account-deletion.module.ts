import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionFinalizeService } from './account-deletion-finalize.service';
import { ProcessorErasureService } from './processor-erasure.service';
import { AccountDeletionCron } from './account-deletion.cron';
import { AccountDeletionController } from './account-deletion.controller';
import { UsersModule } from '../users/users.module';
import { UploadsModule } from '../uploads/uploads.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { EmployerLoan, EmployerLoanSchema } from '../salary/schemas/employer-loan.schema';
import {
  AdvanceRecoveryPlan,
  AdvanceRecoveryPlanSchema,
} from '../salary/schemas/advance-recovery-plan.schema';

/**
 * Account-deletion module (ACCOUNT-DELETION-AND-DPDP-PLAN.md §6).
 *
 * Phase 1: the auth-gating SCHEDULE (Scope-3 suspend) + admin RESTORE primitives.
 * Phase 2: the verified self-serve schedule endpoint (`/me/deletion/*`), the
 * step-up OTP HTTP surface, and the targeted Day-30 finalize (service +
 * single-flight cron) + the ~Day-25 reminder cron.
 * Phase 3: Scope-1 "Delete Connect" — `POST /me/deletion/connect` (same gating),
 * the reversible profile hide + admin-recovery un-hide, the manifest-driven
 * `ConnectContentPurgeService`, its Day-30 connect-purge sweep + cron, and the
 * Scope-3 finalize seam now runs the Connect purge before the identity scrub.
 * Phase 4 (this build): Scope-2 "Delete ERP" — `POST /me/deletion/erp` (same
 * gating) + `GET /me/deletion/erp/preview` (B2 warning surface), the reversible
 * ERP soft phase (owned soft-delete + member worker-offboard cascade + hasWorkspace
 * recompute) via the @Global WorkspacesService, and admin-recovery owned-workspace
 * restore wired into `restoreDeletion`. No statutory purge / processor cascade
 * (Phase 7 go-live gates).
 *
 * Imports:
 *   - UsersModule: User model (re-exported) + UserClaimsCacheService.
 *   - SessionsModule: SessionsService (logout-everywhere on suspend).
 *   - AuditModule: AuditService.
 *   - AuthModule: AccountErasureService (erase chokepoint + assertNotLastActiveAdmin),
 *     AuthService (re-auth), SmsOtpService (step-up issue/verify + proof consume).
 *     AuthModule does NOT import this module → no cycle.
 *   - MailModule: MailService (schedule confirmation + Day-25 reminder emails).
 *   - SubscriptionMandateService (cancel auto-renew) is @Global (BillingModule)
 *     and SingleFlightService is @Global (SchedulerModule) — injected without an
 *     explicit import. ScheduleModule.forRoot() is registered once (SalaryModule),
 *     so the @Cron handlers in AccountDeletionCron are auto-discovered.
 */
@Module({
  imports: [
    UsersModule,
    SessionsModule,
    AuditModule,
    AuthModule,
    MailModule,
    // Phase 3 — Scope-1: ConnectProfileService (reversible hide / recovery
    // un-hide) + ConnectContentPurgeService (the Day-30 manifest-driven purge,
    // also run at the Scope-3 finalize seam).
    // Phase 7 — processor cascade: UploadsService deletes the profile-photo
    // object at storage (the one vendor-side artifact the DB scrub can't reach).
    UploadsModule,
    // Phase 4 — Scope-2: read-only access to the salary loan/advance models for
    // the open employer-loan / unpaid-advance warning flags (plan §3B). Mongoose
    // dedups the connection-global model, so re-registering here (also owned by
    // SalaryModule) is safe. WorkspacesService is @Global → no import needed.
    MongooseModule.forFeature([
      { name: EmployerLoan.name, schema: EmployerLoanSchema },
      { name: AdvanceRecoveryPlan.name, schema: AdvanceRecoveryPlanSchema },
    ]),
  ],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AccountDeletionFinalizeService,
    ProcessorErasureService,
    AccountDeletionCron,
  ],
  exports: [AccountDeletionService, AccountDeletionFinalizeService],
})
export class AccountDeletionModule {}
