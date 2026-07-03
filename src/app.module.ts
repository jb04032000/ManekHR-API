import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { join } from 'path';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { PermissionVersionInterceptor } from './common/interceptors/permission-version.interceptor';
import { SessionActivityMiddleware } from './common/middleware/session-activity.middleware';
import { databaseConfig } from './config/database.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PinUnlockGuard } from './common/guards/pin-unlock.guard';
import { PlatformAccessGuard } from './common/guards/platform-access.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { MailModule } from './modules/mail/mail.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { MeDashboardModule } from './modules/me-dashboard/me-dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { CallerScopeModule } from './common/services/caller-scope.module';
import appConfig from './config/app.config';
import jwtConfig from './config/jwt.config';
import googleOauthConfig from './config/google-oauth.config';

// NOTE: The following modules are scaffolded but not yet fully implemented.
// Uncomment them as they are completed:
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { TeamModule } from './modules/team/team.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { SalaryModule } from './modules/salary/salary.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { HolidaysModule } from './modules/holidays/holidays.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { UserDevicesModule } from './modules/user-devices/user-devices.module';
import { StatisticsModule } from './modules/statistics/statistics.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { LocalizationModule } from './modules/localization/localization.module';
import { AdminModule } from './modules/admin/admin.module';
import { AccountDeletionModule } from './modules/account-deletion/account-deletion.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { AddOnsModule } from './modules/add-ons/add-ons.module';
import { CustomPlanRequestsModule } from './modules/custom-plan-requests/custom-plan-requests.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AttendanceIngestModule } from './modules/attendance-ingest/attendance-ingest.module';
import { AttendanceDevicesModule } from './modules/attendance-devices/attendance-devices.module';
import { AttendancePoliciesModule } from './modules/attendance-policies/attendance-policies.module';
import { RegularizationModule } from './modules/regularization/regularization.module';
import { LeaveModule } from './modules/leave/leave.module';
import { AttendanceImportModule } from './modules/attendance-import/attendance-import.module';
import { AttendanceStatutoryModule } from './modules/attendance-statutory/attendance-statutory.module';
import { AnomaliesModule } from './modules/anomalies/anomalies.module';
// Locations — standalone (2026-07-04): restored as its own feature (owner
// directive) after the Machines module was removed. Only depends on
// Workspaces/Subscriptions, never on Machines. Managed from Workspace
// Settings; consumed by Team's "Work location" field.
import { LocationsModule } from './modules/locations/locations.module';
import storageConfig from './config/storage.config';
import brandingConfig from './config/branding.config';
import { RedisModule } from './common/redis/redis.module';
import { SchedulerModule } from './common/scheduler/scheduler.module';
import { PostHogModule } from './common/posthog/posthog.module';
import { WorkspaceRevocationModule } from './common/workspace-revocation/workspace-revocation.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { MigrationsModule } from './migrations/migrations.module';
import { SmsModule } from './modules/sms/sms.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { LegalPagesModule } from './modules/legal-pages/legal-pages.module';
// Institutes Phase 2 leaf module (institute-admin credential confirm/decline).
// Imports ConnectProfileModule + ConnectEntitiesModule; nothing imports it.
// Connect Referral Program leaf module. Imports AdsModule (WalletService) +
// AuditModule + User-schema only; nothing in its import chain reaches AuthModule,
// so AuthModule imports it (for the signup attribution call) without a cycle.

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, jwtConfig, googleOauthConfig, storageConfig, brandingConfig],
    }),
    MongooseModule.forRootAsync(databaseConfig),
    // Phase 16 Plan 04 — portal throttler (60 req/min per (jti, ip), D-27).
    // The named definition 'portal' is referenced from PortalPublicController
    // via @Throttle({ portal: { limit: 60, ttl: 60_000 } }) + PortalThrottlerGuard.
    ThrottlerModule.forRoot([
      { name: 'portal', limit: 60, ttl: 60_000 },
      // Auth endpoints — protect login + forgot-password from credential
      // stuffing / abuse. 10 attempts per minute per IP. Applied via
      // @Throttle({ auth: { limit: 10, ttl: 60_000 } }) + ThrottlerGuard
      // on AuthController. ttl in ms.
      { name: 'auth', limit: 10, ttl: 60_000 },
      // Phase D1b — billing checkout. Caps the worst-case React re-render
      // storm where the same user fires the order-create endpoint dozens of
      // times per minute (each call hits the live Razorpay API). 5 orders /
      // 60s is well above any legitimate manual checkout cadence. Reused
      // by D1c on POST /subscriptions/checkout/mandate so a misbehaving
      // client can't evade the cap by alternating one-time + mandate.
      { name: 'billing-create', limit: 5, ttl: 60_000 },
      // Confirm is bursty by design (sheet retries on flaky network) but
      // bounded by Razorpay's own per-order one-shot capture model. Allow
      // headroom while still capping abuse.
      { name: 'billing-confirm', limit: 20, ttl: 60_000 },
      // Phase D1c — mandate lifecycle (cancel / pause / resume). Bursty
      // by design (UI may double-tap). Generous but bounded.
      { name: 'billing-mutate', limit: 10, ttl: 60_000 },
      // Phase 2 polish atoms — user-submitted feedback POST. 5/min/IP
      // is comfortable for legitimate one-off submissions while blocking
      // accidental form-replay storms or scripted abuse.
      { name: 'feedback-create', limit: 5, ttl: 60_000 },
      // App Lock (Quick PIN) — caps brute-force attempts on /auth/pin-verify
      // + reset endpoints. Same tier shape as forgot/reset password.
      { name: 'pin', limit: 5, ttl: 60_000 },
      // App Lock activity heartbeat — /auth/pin-touch. Fired by the web idle
      // timer (throttled ~20s/tab) so the BE unlock TTL slides on user input.
      // Generous limit so multiple tabs behind one NAT IP don't get 429'd and
      // miss a slide (a missed slide could 423-lock an active session).
      { name: 'pin-touch', limit: 60, ttl: 60_000 },
      // SMS-OTP — per-IP burst cap on /auth/send-otp + send-mobile-verify-otp.
      // /verify-otp + /resend-otp use the same tier with per-route override
      // (10/min and 3/min respectively). Per-phone + per-IP-daily caps live in
      // a Redis sliding-window separately (otp-rate-limiter.ts).
      { name: 'sms-otp', limit: 5, ttl: 60_000 },
      // Attendance analytics reads — org-wide rollups (grid / overtime /
      // compliance / absence-patterns / live-presence). 30/min per user is
      // generous for interactive dashboards while capping runaway polling.
      { name: 'attendance-analytics', limit: 30, ttl: 60_000 },
      // Attendance-policy writes (create / update / remove). Policy mutation
      // is a rare, deliberate admin operation; 10/min caps accidental replay.
      { name: 'attendance-policy-write', limit: 10, ttl: 60_000 },
      // Attendance-policy dry-run — scans up to 200 members × 31 days per
      // call. Same 10/min cap as writes to bound DB scan load.
      { name: 'attendance-policy-dryrun', limit: 10, ttl: 60_000 },
      // Leave reads — type catalogue / balances / requests / calendar /
      // conflicts. 60/min per user is generous for interactive self-service
      // + approval-inbox polling while capping runaway re-fetch loops.
      { name: 'leave-read', limit: 60, ttl: 60_000 },
      // Leave writes — apply / approve / reject / cancel / withdraw / type
      // CRUD / settings / adjustments / delegations. 20/min per user is
      // comfortable for legitimate use while blocking accidental replay.
      { name: 'leave-write', limit: 20, ttl: 60_000 },
      // Holiday reads - calendar / year / single-date lookup. 60/min per user
      // is generous for interactive calendar + leave/attendance consumers while
      // capping runaway re-fetch loops.
      { name: 'holidays-read', limit: 60, ttl: 60_000 },
      // Holiday writes - create / update / delete. Holiday mutation is a rare,
      // deliberate admin operation; 20/min caps accidental replay.
      { name: 'holidays-write', limit: 20, ttl: 60_000 },
      // Shifts reads - workspace shift catalog (findAll). 60/min per user is
      // generous for the interactive admin page plus team/attendance consumers
      // pulling shift metadata, while capping runaway re-fetch loops. Mirrors
      // the holidays-read tier.
      { name: 'shifts-read', limit: 60, ttl: 60_000 },
      // Shifts writes - create / update / delete. Shift mutation is a rare,
      // deliberate admin operation; 20/min caps accidental replay. Mirrors
      // the holidays-write tier.
      { name: 'shifts-write', limit: 20, ttl: 60_000 },
      // Phase 1f.3 — team-member mobile OTP. Defence-in-depth on top of the
      // per-(workspace,mobile) cooldown + per-workspace burst cap already
      // enforced inside MobileOtpService. The controller tier caps per-IP +
      // per-userId abuse (e.g., scripted enumeration across many mobiles
      // from a single attacker session). `start` is the expensive path
      // (DB write + DLT SMS); `confirm` is cheaper (bcrypt compare + JWT
      // sign) and bursty by design (UI re-submit on flaky network).
      { name: 'team-mobile-otp-start', limit: 10, ttl: 60_000 },
      { name: 'team-mobile-otp-confirm', limit: 30, ttl: 60_000 },
      // Connect feed — engagement writes (react/unreact, comment, save/unsave,
      // viewport impressions). 90/min/user is far above human cadence but caps
      // a render-loop bug or a script from saturating the Mongo pool + the
      // Socket.IO/notification path for everyone. Applied via
      // @Throttle({ 'connect-engage': {...} }) + ThrottlerGuard on FeedController.
      { name: 'connect-engage', limit: 90, ttl: 60_000 },
      // Connect feed — heavier writes (create post / repost / edit). 30/min is
      // generous for deliberate posting while blocking spam / replay storms.
      { name: 'connect-write', limit: 30, ttl: 60_000 },
      // Connect view-tracking -- one record call per storefront / product view.
      // High-frequency by nature (every page open), so a generous cap that still
      // bounds a render-loop or scripted abuse. Deduped per viewer/day in Mongo.
      { name: 'connect-view', limit: 120, ttl: 60_000 },
      // Connect global search — GET /connect/search (+ /search/listings/recent).
      // Rate-limited per authenticated USER (ConnectSearchThrottlerGuard), not
      // per IP, so workers behind one factory NAT don't 429 each other on a
      // shared connection. 120/min is far above debounced human typeahead — the
      // Redis prefix cache (SRCH-PERF-1) absorbs repeated identical prefixes, so
      // this tier is the backstop that caps a render-loop / scripted
      // distinct-query flood from one user. Applied via
      // @Throttle({ 'connect-search': {...} }) + ConnectSearchThrottlerGuard on
      // SearchController.
      { name: 'connect-search', limit: 120, ttl: 60_000 },
      // Finance interactive reads — e.g. smart-defaults pre-fill lookup fired
      // by the new-invoice form on party select. 60/min per user is generous
      // for interactive form use while capping a render-loop / re-fetch storm.
      { name: 'finance-read', limit: 60, ttl: 60_000 },
      // Uploads — single-file POST. 20/min per user is well above any
      // legitimate interactive upload cadence (avatar, post media, document)
      // while capping a scripted storage-flooding / cost-abuse loop. Applied
      // via @Throttle({ 'uploads-single': {...} }) + ThrottlerGuard on
      // UploadsController.
      { name: 'uploads-single', limit: 20, ttl: 60_000 },
      // Attendance hardening Gap ATTEND-6 — public kiosk punch / lookup. The
      // kiosk is unauthenticated (bcrypt secret + per-employee PIN + 5-attempt
      // lockout), so an explicit per-IP HTTP cap backs the lockout: 30/min per IP
      // covers a busy factory shift-change rush on a single shared tablet while
      // bounding a brute-force script that cycles employee codes to evade the
      // per-employee lockout. Applied via @Throttle({ kiosk: {...} }) +
      // ThrottlerGuard on KioskController.
      { name: 'kiosk', limit: 30, ttl: 60_000 },
    ]),
    // Phase 17 Plan 01 — EventEmitter2 wiring for D-17 (party.timeline events).
    // Producer fires 'party.timeline'; PartyTimelineSubscriber listens (wave 1).
    EventEmitterModule.forRoot({
      wildcard: false,
      maxListeners: 20,
      ignoreErrors: false,
      verboseMemoryLeak: false,
    }),
    RedisModule,
    SchedulerModule,
    PostHogModule,
    WorkspaceRevocationModule,
    RealtimeModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
        prefix: `cr-bull:${config.get<string>('NODE_ENV', 'development')}`,
        defaultJobOptions: {
          removeOnComplete: { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      }),
      inject: [ConfigService],
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),
    UsersModule,
    AuthModule,
    WorkspacesModule,
    RbacModule,
    MeDashboardModule,
    HealthModule,
    MonitoringModule,
    CallerScopeModule,
    MailModule,
    SubscriptionsModule,
    CustomPlanRequestsModule,
    TeamModule,
    AttendanceModule,
    AttendanceIngestModule,
    AttendanceDevicesModule,
    AttendancePoliciesModule,
    RegularizationModule,
    LeaveModule,
    AttendanceImportModule,
    AttendanceStatutoryModule,
    AnomaliesModule,
    LocationsModule,
    SalaryModule,
    ShiftsModule,
    HolidaysModule,
    NotificationsModule,
    UserDevicesModule,
    StatisticsModule,
    UploadsModule,
    LocalizationModule,
    AdminModule,
    AccountDeletionModule,
    SessionsModule,
    SettingsModule,
    AddOnsModule,
    SmsModule,
    FeedbackModule,
    // Admin-managed legal/policy pages (Terms + Privacy CMS): admin CRUD +
    // @Public published-only read for the marketing /terms + /privacy routes.
    LegalPagesModule,
    // ManekHR Connect — network / marketplace / jobs layer (Phase 0 scaffold).
    // Profile sub-module ships the ConnectProfile schema + ErpLinkService;
    // CRUD endpoints land in Phase 1.
    // Institutes Phase 2: institute-admin credential confirm/decline (leaf).
    // Connect Referral Program: referral config + tracking + attribution/qualify/
    // release/summary/admin-log/clawback + the two controllers.
    // Broker introductions: a broker introduces a buyer + a seller; both must
    // confirm before the introduction is `confirmed` (anti-gaming core). Leaf.
    // Broker reviews: a party of a CONFIRMED introduction may leave ONE
    // verified-but-anonymous review of the broker; the broker can only reply
    // once. Anchored to the introduction (the proof). Leaf.
    // Public, projection-only sitemap reads for the web app's dynamic sitemap
    // index (counts + per-section {ref, updatedAt} chunks). Reuses the over-limit
    // suppression so the listing sitemap matches the public detail-route 404.
    // Registers the migration ledger + runner + the MIGRATION_UNITS registry
    // (ADR-0001). Nothing runs on boot — migrations execute via `npm run migrate`
    // / CI or the opt-in RUN_MIGRATIONS_ON_BOOT flag. Listed last so that
    // SubscriptionsModule + AddOnsModule register their schemas first.
    MigrationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PlatformAccessGuard,
    // SentryGlobalFilter MUST come before any HttpException-specific filter
    // so it captures unhandled errors before they're transformed into HTTP
    // responses. Sentry's filter re-throws so other filters still run.
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // App Lock (Quick PIN) gate. Runs AFTER JwtAuthGuard populates req.user
    // and BEFORE PlatformAccessGuard. Endpoints needed during locked state
    // (PIN setup/verify/forgot, /auth/logout, /auth/refresh, /auth/me) carry
    // @SkipPinUnlock() to bypass.
    {
      provide: APP_GUARD,
      useClass: PinUnlockGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PlatformAccessGuard,
    },
    // RBAC re-architecture (design §4 / task 9) — fail-closed authorization.
    // Registered last in the guard chain so req.user (JwtAuthGuard) is
    // populated. Every route must carry exactly one RBAC marker
    // (@RequirePermission / @RequirePermissions / @AuthenticatedOnly /
    // @Public / @LegacyUnclassified); an unmarked route is denied.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    // Phase 2.3 — emit X-Permission-Version on every workspace-scoped
    // response so the FE detects permission drift without polling.
    // Runs after IdempotencyInterceptor (order matches declaration order).
    {
      provide: APP_INTERCEPTOR,
      useClass: PermissionVersionInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SessionActivityMiddleware).forRoutes('api/*');
  }
}
