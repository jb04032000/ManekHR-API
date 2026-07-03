import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tier, TierSchema } from '../modules/subscriptions/schemas/tier.schema';
import { Plan, PlanSchema } from '../modules/subscriptions/schemas/plan.schema';
import {
  Subscription,
  SubscriptionSchema,
} from '../modules/subscriptions/schemas/subscription.schema';
import {
  AddOnDefinition,
  AddOnDefinitionSchema,
} from '../modules/add-ons/schemas/add-on-definition.schema';
import { SeedDefaultTiersAndPlansService } from './seed-default-tiers-and-plans';
import { SeedDefaultAddOnsService } from './seed-default-add-ons';
import { MigrateProToGrowthService } from './migrate-pro-to-growth';
import { SeedMsg91CostsService } from './seed-msg91-costs';
import { SeedPlatformAuthOtpWorkspaceService } from './seed-platform-auth-otp-workspace';
import { MigrateTeamAppAccessToWorkspaceMembersService } from './migrate-team-app-access-to-workspace-members';
import { SeedDefaultMemberRoleExistingWorkspacesService } from './seed-default-member-role-existing-workspaces';
import { MigrateWorkspaceMemberPartialIndexService } from './migrate-workspace-member-partial-index';
import { BackfillPermissionScopesService } from './backfill-permission-scopes';
import { BackfillWorkerRegularizationGrantService } from './backfill-worker-regularization-grant';
import { SeedLeaveTypesExistingWorkspacesService } from './seed-leave-types-existing-workspaces';
import { BackfillLeaveRoleGrantsService } from './backfill-leave-role-grants';
import { BackfillWorkspacesViewRoleGrantsService } from './backfill-workspaces-view-role-grants';
import { BackfillRolePermissionPathsService } from './backfill-role-permission-paths';
import { BackfillRoleAttendancePermissionPathsService } from './backfill-role-attendance-permission-paths';
import { MigrateTeamOverridesToPathsService } from './migrate-team-overrides-to-paths';
import { StripAttendanceMarkEditSelfScopeService } from './strip-attendance-mark-edit-self-scope';
import { BackfillLeaveSelfServiceGrantDepsService } from './backfill-leave-self-service-grant-deps';
import { BackfillHrSalarySensitiveViewService } from './backfill-hr-salary-sensitive-view';
import { BackfillTeamMemberWorkspaceIdObjectIdService } from './backfill-team-member-workspaceid-objectid';
import { SeedConnectTiersAndPlansService } from './seed-connect-tiers-and-plans';
import { BackfillConnectProductAndIndexesService } from './backfill-connect-product-and-indexes';
import { BackfillConnectSubFeatureKeysService } from './backfill-connect-subfeature-keys';
import { BackfillListingStorefrontService } from './backfill-listing-storefront';
import { SeedConnectTagsService } from './seed-connect-tags';
import {
  Msg91CostTable,
  Msg91CostTableSchema,
} from '../modules/sms/schemas/msg91-cost-table.schema';
import { Workspace, WorkspaceSchema } from '../modules/workspaces/schemas/workspace.schema';
import { TeamMember, TeamMemberSchema } from '../modules/team/schemas/team-member.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../modules/workspaces/schemas/workspace-member.schema';
import { Role, RoleSchema } from '../modules/rbac/schemas/role.schema';
import { LeaveType, LeaveTypeSchema } from '../modules/leave/schemas/leave-type.schema';
// --- Ledgered migration runner (ADR-0001, Slice 1: Connect) ---
import { MigrationRecord, MigrationRecordSchema } from './schemas/migration-record.schema';
import { MigrationRunnerService } from './migration-runner.service';
import { SeedConnectAdPlacementsService } from './seed-connect-ad-placements';
import { BackfillListingModerationService } from './backfill-listing-moderation';
import { MIGRATION_UNITS, type Migration } from './migration.types';
import { env } from '../config/env';
// --- Slice 2 (Finance) — existing services run via the runner, not onModuleInit ---
import {
  GstRateHistoryStubService,
  InventoryMigrationStubService,
  CessRulesSeedStubService,
  ReminderTemplatesStubService,
  HsnStubService,
} from './finance-removed-stubs/finance-migration-stubs';
// --- Slice 5 (platform + subscription plan-migrations) — existing services run via the runner ---
import { LocalizationModule } from '../modules/localization/localization.module';
import { LocalizationService } from '../modules/localization/localization.service';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';
import { AttendancePlanMigrationService } from '../modules/subscriptions/attendance-plan-migration.service';
import { FinancePlanMigrationService } from '../modules/subscriptions/finance-plan-migration.service';
import { MachinesPlanMigrationService } from '../modules/subscriptions/machines-plan-migration.service';
// --- ADR-0001 loose ends: HSN code seed (split from its runtime cache) + PT slabs ---
import { SeedPtSlabsService } from './seed-pt-slabs';
import { PtSlabConfig, PtSlabConfigSchema } from '../modules/salary/schemas/pt-slab.schema';
// --- Advance self-service (2026-06-14): worker request_advance grant + advanceRequestPolicy stamp ---
import { BackfillWorkerRequestAdvanceGrantService } from './backfill-worker-request-advance-grant';
import { BackfillAdvanceRequestPolicyService } from './backfill-advance-request-policy';
import { BackfillSplitPaymentsDefaultOnService } from './backfill-split-payments-default-on';
// --- Loan self-service (2026-06-22): worker request_loan grant backfill ---
import { BackfillWorkerRequestLoanGrantService } from './backfill-worker-request-loan-grant';
import { BackfillLoanDefaultsOnService } from './backfill-loan-defaults-on';
// --- Salary hardening (2026-06-15, security-review fix HIGH-1 / OQ-S6): worker
// declare_tax (self) + HR declare_tax (all) grant backfill ---
import { BackfillSalaryDeclareTaxGrantService } from './backfill-salary-declare-tax-grant';
import {
  PayrollConfig,
  PayrollConfigSchema,
} from '../modules/salary/schemas/payroll-config.schema';
// --- Auth hardening (2026-06-14, OQ-4): session audit-retention decoupling ---
import { MigrateSessionAuditRetentionService } from './migrate-session-audit-retention';
import { Session, SessionSchema } from '../modules/sessions/schemas/session.schema';
// --- Finance/Bills hardening (2026-06-15, OQ-FB-2): migrate the legacy Bills
// surface onto finance.payable.* paths; backfill those grants onto Manager/HR ---
import { BackfillFinancePayableRoleGrantsService } from './backfill-finance-payable-role-grants';
// --- Connect post view-count semantics (2026-06-17, ADR-0002): drop the stale
// `view`-edge TTL index so view edges become the permanent lifetime-unique
// dedup marker behind Post.viewCount ---
import { DropEngagementViewTtlIndexService } from './drop-engagement-view-ttl-index';
// --- Connect suggestions live-owner guard (2026-06-17, ADR-0003): purge orphaned
// Connect profiles (profile present, owning User gone) so they stop leaking into
// "people you may know" as empty "Connect member" ghost rows. Raw-connection unit
// (no model wiring), mirrors AdminConnectDemoService. ---
import { PurgeOrphanConnectProfilesService } from './purge-orphan-connect-profiles';
// --- Connect boost region-targeting fix (2026-06-19): canonicalize existing
// free-text ConnectProfile.district to the canonical NAME + slugs so region
// targeting recognizes them; blank/unrecognized are left to the matcher fallback. ---
import { BackfillProfileDistrictCanonicalService } from './backfill-profile-district-canonical';
// --- User.hasWorkspace accuracy fix (2026-06-21): recompute the flag from real
// workspace ownership so a workspace-less / Connect-only account stops reading as
// an ERP user (which wrongly routed it into the ERP shell + forced Quick-PIN). ---
import { BackfillUserHasWorkspaceService } from './backfill-user-has-workspace';
// --- Admin-managed legal pages CMS (2026-06-21): seed the 4 draft pages
// (terms/privacy × connect/erp) so the public /terms + /privacy routes resolve. ---
import { SeedLegalPagesService } from './seed-legal-pages';
import { LegalPage, LegalPageSchema } from '../modules/legal-pages/schemas/legal-page.schema';
// --- Connect demo-content marker (2026-06-21, Demo-Content Scope B): backfill the
// denormalized `isDemo:true` flag onto existing Connect content docs (posts /
// listings / jobs / applications / rfqs / quotes) whose owner is a seeded demo
// account, so the FE "Sample" badge + the feed/search demo down-rank read one
// source. Raw-connection unit (no model wiring), mirrors PurgeOrphanConnectProfiles. ---
import { BackfillConnectContentIsDemoService } from './backfill-connect-content-is-demo';
// --- ERP pricing rework Phase 1 (2026-06-23): retire legacy ERP plans
// (deactivate the public Enterprise plan + hide/flag Custom + delete-or-deactivate
// the old hand-seed/pro plans, data-safely keyed on subscription count) so
// existing DBs converge on the canonical 5-plan set. ---
import { RetireLegacyErpPlansService } from './retire-legacy-erp-plans.service';
// --- ERP pricing rework Phase 1 (2026-06-23): RECONCILE plan/tier entitlements.
// Force-corrects drifting member-cap / workspace / total-member + price fields
// on existing ERP plan+tier docs back to the canonical seed values (the seed
// only inserts, never corrects), so the "5 team members" drift on the Starter /
// Growth pricing cards is fixed and made un-driftable. Runs AFTER 0052. ---
import { ReconcileErpPlanEntitlementsService } from './reconcile-erp-plan-entitlements.service';
// --- Connect feed harden Phase (2026-07-02, CN-ADS-1): backfill the new
// AdCampaign reserve-split fields (reservedFromGrant / reservedFromBalance) on
// in-flight campaigns so the split-aware wallet release restores grant vs
// purchased credits correctly. Raw-connection unit; grant-blind default keeps
// backfilled campaigns behaving exactly as before. ---
import { BackfillAdCampaignReserveSplitService } from './backfill-ad-campaign-reserve-split';
// --- System-role baseline reconcile (2026-07-03, owner directive): ensure the
// seeded system roles (Partner/Manager/Accountant/Employee) on EVERY workspace
// carry at least the current DEFAULT_ROLES grants (union-merge, never removes).
// Fixes roles seeded before newer permissions/registry paths existed. ---
import { ReconcileSystemRoleBaselineService } from './reconcile-system-role-baseline';
// --- Strip declare_tax from Employee/Accountant baseline (2026-07-03, owner
// directive): tax declaration is advanced/statutory, granted per role, not a
// default. Removes the grant the v2 baseline briefly wrote. ---
import { StripEmployeeDeclareTaxGrantService } from './strip-employee-declare-tax-grant';
// --- Employee self-service default-on (2026-07-03, owner directive): flip
// selfServiceConfig.selfPunch/selfLeaveApply true on existing workspaces so
// the Employee baseline's self grants (0055) actually surface (Apply-leave
// button, self check-in). New workspaces seed true via schema defaults. ---
import { BackfillSelfServiceDefaultOnService } from './backfill-self-service-default-on';
// --- Advance-request policy default-open (2026-07-03, owner directive): flip
// the 0039-stamped fixed_day policies to any_day so employees can request an
// advance anytime by default; windows/fixed days stay opt-in per workspace. ---
import { AdvanceRequestPolicyAnyDayService } from './advance-request-policy-any-day';
// --- Advance Payments default-on (2026-07-03, owner directive): flip
// features.advancePayments true on existing workspaces (mirrors 0049 split
// payments) so advance-salary requests work out of the box. ---
import { BackfillAdvancePaymentsDefaultOnService } from './backfill-advance-payments-default-on';
// --- Plan marketing copy + 45-day trial plan (2026-07-03, marketing task): backfill
// localized marketing.{tagline,featureHighlights,isHighlighted,displayOrder} onto the
// 4 canonical ERP plans (all 4 locales) AND seed the opt-in 45-day full-access trial
// plan when none exists. Runs AFTER 0028 (ERP tiers/plans seed) so the plans exist. ---
import { SeedPlanMarketingAndTrialService } from './seed-plan-marketing-and-trial.service';

/**
 * Seed-payload versions for the `convergent` Connect migration units (ADR-0001).
 * Bump the relevant value when the underlying seed DATA changes (e.g. a new tier,
 * a new ad-placement slot) so the runner re-applies it on the next `npm run migrate`.
 * `once` backfills don't have a checksum (they run exactly once).
 */
const CONNECT_SEED_CHECKSUMS = {
  tiersAndPlans: 'v1-2026-06-13',
  tags: 'v1-2026-06-13',
  adPlacements: 'v5-22slots-2026-06-20',
} as const;

// Slice 2 (Finance) convergent-seed versions — bump when the seed data changes.
const FINANCE_SEED_CHECKSUMS = {
  cessRules: 'v1-2026-06-13',
  greetingTemplates: 'v1-2026-06-13',
  // Salary Advance CoA (1014) backfill onto existing firms — see migration 0038.
  salaryAdvanceCoa: 'v1-2026-06-14',
} as const;

// Slice 4 (ERP default-data) convergent-seed versions — bump when the seed data
// changes (e.g. a new tier, add-on, or MSG91 rate).
const ERP_SEED_CHECKSUMS = {
  tiersAndPlans: 'v1-2026-06-13',
  addOns: 'v1-2026-06-13',
  msg91Costs: 'v1-2026-06-13',
  authOtpWorkspace: 'v1-2026-06-13',
} as const;

// Slice 5 (platform) convergent-seed versions — bump when the seed data changes.
const PLATFORM_SEED_CHECKSUMS = {
  languages: 'v1-2026-06-13',
} as const;

// ADR-0001 loose-ends convergent-seed versions — bump when the seed data changes.
const LOOSE_END_SEED_CHECKSUMS = {
  hsnCodes: 'v1-2026-06-13',
  ptSlabs: 'v1-2026-06-13',
} as const;

// Legal pages CMS convergent-seed version — bump to re-apply (e.g. when adding a
// new legal doc kind like cookie/refund). Skip-existing, so it never clobbers an
// admin's edited/published content.
// v2: added the 2 company-wide canonical docs (slug `terms` + `privacy`, product
// `platform`) the footer links to, alongside the 4 product-specific docs.
const LEGAL_SEED_CHECKSUMS = {
  pages: 'v2-2026-06-21',
} as const;

// System-role baseline version — bump whenever the DEFAULT_ROLES grants in
// role-seeder.constants.ts change, so migration 0055 re-applies the new
// baseline to existing workspaces' system roles.
const RBAC_BASELINE_CHECKSUMS = {
  // v2: Employee baseline gained salary self-service (view/request_advance/
  // request_loan/declare_tax, all self) — owner directive 2026-07-03.
  // v3: declare_tax REMOVED from the baseline (advanced statutory feature,
  // per-role opt-in); migration 0056 strips the already-written grant.
  // v4: salary sensitive_view added (employee sees own bank/PAN on payslips).
  systemRoles: 'v4-2026-07-03',
} as const;

// Plan marketing copy + trial checksum — convergent so a bumped value re-applies
// the canonical marketing copy (tagline / featureHighlights / isHighlighted /
// displayOrder) onto the 4 ERP plans. Bump whenever the copy in
// seed-plan-marketing-and-trial.service.ts changes. NOTE: re-apply OVERWRITES any
// admin-edited marketing copy with the canonical strings. (The trial-plan seed is
// skip-if-exists, so it is unaffected by re-runs.)
const PLAN_MARKETING_CHECKSUMS = {
  // v2: GST wording removed from Starter/Growth copy (GST module launches later).
  copy: 'v2-2026-07-03',
} as const;

/**
 * Migrations module (ADR-0001) — registers the migration ledger, the
 * `MigrationRunnerService`, and the ordered `MIGRATION_UNITS` registry (every
 * seed/backfill/migration unit, slices 1–4).
 *
 * NOTHING runs on boot. Migrations execute via the explicit `npm run migrate`
 * CLI / CI-CD step, or the opt-in `RUN_MIGRATIONS_ON_BOOT` dev flag (worker/all
 * roles only) — see MigrationRunnerService. This replaces the old
 * `SEED_DEFAULTS_ON_BOOTSTRAP`-gated onModuleInit seeding. `once` units run
 * exactly once; `convergent` seeds re-apply only when their checksum is bumped.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tier.name, schema: TierSchema },
      { name: Plan.name, schema: PlanSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: AddOnDefinition.name, schema: AddOnDefinitionSchema },
      { name: Msg91CostTable.name, schema: Msg91CostTableSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: TeamMember.name, schema: TeamMemberSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: Role.name, schema: RoleSchema },
      { name: LeaveType.name, schema: LeaveTypeSchema },
      // Ledger + the models the two new Connect migration units write to
      // (ADR-0001 Slice 1). Re-registering AdPlacement/ConnectPricingConfig is
      // safe — @nestjs/mongoose reuses the existing connection model.
      { name: MigrationRecord.name, schema: MigrationRecordSchema },
      // ADR-0001 loose end: model for the dedicated PT-slab seed service (avoids
      // importing the heavy AdminModule just to reach this reference-data seed).
      { name: PtSlabConfig.name, schema: PtSlabConfigSchema },
      // Advance self-service: PayrollConfig model for the advanceRequestPolicy stamp.
      { name: PayrollConfig.name, schema: PayrollConfigSchema },
      // Auth hardening (OQ-4): Session model for the audit-retention migration.
      { name: Session.name, schema: SessionSchema },
      // ADR-0002: EngagementEdge model so the view-edge TTL drop migration can
      // reach the `connectengagementedges` collection.
      // Legal pages CMS seed (migration 0047) writes draft Terms/Privacy docs.
      { name: LegalPage.name, schema: LegalPageSchema },
    ]),
    // For the W3 listing->storefront backfill (StorefrontService.getOrCreateDefaultStorefront).
    // Slice 2 (Finance): import the modules that own these services so the
    // runner can call them (each exports its service; none import this module,
    // so no cycle). Their onModuleInit boot hooks were removed.
    // Slice 5: owning modules for the platform language seed + the subscription
    // plan-migrations (each exports its service; nothing imports MigrationsModule,
    // so no cycle).
    LocalizationModule,
    SubscriptionsModule,
    // (now-public) seedIfMissing; the HSN finder cache-warm stays on boot.
  ],
  providers: [
    // Finance-removed no-op stubs (2026-07-04) — see finance-migration-stubs.ts.
    GstRateHistoryStubService,
    InventoryMigrationStubService,
    CessRulesSeedStubService,
    ReminderTemplatesStubService,
    HsnStubService,
    SeedDefaultTiersAndPlansService,
    SeedDefaultAddOnsService,
    MigrateProToGrowthService,
    SeedMsg91CostsService,
    SeedPlatformAuthOtpWorkspaceService,
    MigrateTeamAppAccessToWorkspaceMembersService,
    SeedDefaultMemberRoleExistingWorkspacesService,
    MigrateWorkspaceMemberPartialIndexService,
    BackfillPermissionScopesService,
    BackfillWorkerRegularizationGrantService,
    SeedLeaveTypesExistingWorkspacesService,
    BackfillLeaveRoleGrantsService,
    BackfillWorkspacesViewRoleGrantsService,
    BackfillRolePermissionPathsService,
    BackfillRoleAttendancePermissionPathsService,
    MigrateTeamOverridesToPathsService,
    StripAttendanceMarkEditSelfScopeService,
    BackfillLeaveSelfServiceGrantDepsService,
    BackfillHrSalarySensitiveViewService,
    BackfillTeamMemberWorkspaceIdObjectIdService,
    SeedConnectTiersAndPlansService,
    BackfillConnectProductAndIndexesService,
    BackfillConnectSubFeatureKeysService,
    BackfillListingStorefrontService,
    SeedConnectTagsService,
    // ADR-0001 Slice 1 (Connect) — ledgered runner + the two new Connect units.
    // The 5 existing connect services above now feed the ordered registry below
    // instead of running in onModuleInit (their per-boot blocks were removed).
    MigrationRunnerService,
    SeedConnectAdPlacementsService,
    BackfillListingModerationService,
    // ADR-0001 loose end: dedicated PT-slab seed (model-only, no AdminModule import).
    SeedPtSlabsService,
    // Advance self-service backfills.
    BackfillWorkerRequestAdvanceGrantService,
    BackfillAdvanceRequestPolicyService,
    // Salary hardening (security-review fix HIGH-1 / OQ-S6): declare_tax grant backfill.
    BackfillSalaryDeclareTaxGrantService,
    // Auth hardening (OQ-4): session audit-retention decoupling migration.
    MigrateSessionAuditRetentionService,
    // Finance/Bills hardening (OQ-FB-2): finance.payable.* grant backfill.
    BackfillFinancePayableRoleGrantsService,
    // Connect view-count semantics (ADR-0002): view-edge TTL drop.
    DropEngagementViewTtlIndexService,
    // Connect suggestions live-owner guard (ADR-0003): orphan-profile purge.
    PurgeOrphanConnectProfilesService,
    // Connect boost region-targeting fix: canonical-district backfill.
    BackfillProfileDistrictCanonicalService,
    // User.hasWorkspace accuracy fix: one-time ownership-truth backfill.
    BackfillUserHasWorkspaceService,
    // Legal pages CMS: seed 4 draft Terms/Privacy docs (migration 0047).
    SeedLegalPagesService,
    // Connect demo-content marker (Demo-Content Scope B): isDemo content backfill.
    BackfillConnectContentIsDemoService,
    // Split Payments default-on (2026-06-22, owner directive)
    BackfillSplitPaymentsDefaultOnService,
    // Loan self-service (2026-06-22): worker request_loan grant backfill.
    BackfillWorkerRequestLoanGrantService,
    // Loan defaults-on (2026-06-22, owner directive)
    BackfillLoanDefaultsOnService,
    // ERP pricing rework Phase 1 (2026-06-23): retire legacy ERP plans.
    RetireLegacyErpPlansService,
    // ERP pricing rework Phase 1 (2026-06-23): reconcile plan/tier entitlements.
    ReconcileErpPlanEntitlementsService,
    // Connect feed harden (2026-07-02, CN-ADS-1): ad-campaign reserve-split backfill.
    BackfillAdCampaignReserveSplitService,
    // System-role baseline reconcile (2026-07-03): DEFAULT_ROLES union-merge.
    ReconcileSystemRoleBaselineService,
    // Strip declare_tax from Employee/Accountant baseline (2026-07-03).
    StripEmployeeDeclareTaxGrantService,
    // Employee self-service default-on (2026-07-03).
    BackfillSelfServiceDefaultOnService,
    // Advance-request policy default-open (2026-07-03).
    AdvanceRequestPolicyAnyDayService,
    // Advance Payments default-on (2026-07-03).
    BackfillAdvancePaymentsDefaultOnService,
    // Plan marketing copy + 45-day trial plan (2026-07-03).
    SeedPlanMarketingAndTrialService,
    {
      // Ordered Connect migration registry. Later slices append their units here.
      provide: MIGRATION_UNITS,
      useFactory: (
        connectProductBackfill: BackfillConnectProductAndIndexesService,
        connectSubFeatureBackfill: BackfillConnectSubFeatureKeysService,
        listingStorefrontBackfill: BackfillListingStorefrontService,
        connectTiersAndPlansSeed: SeedConnectTiersAndPlansService,
        connectTagsSeed: SeedConnectTagsService,
        adPlacementsSeed: SeedConnectAdPlacementsService,
        listingModerationBackfill: BackfillListingModerationService,
        // Slice 2 (Finance)
        gstRateHistory: GstRateHistoryStubService,
        inventoryBackfill: InventoryMigrationStubService,
        cessRulesSeed: CessRulesSeedStubService,
        greetingTemplatesSeed: ReminderTemplatesStubService,
        // Slice 3 (RBAC / team / leave / salary)
        proToGrowth: MigrateProToGrowthService,
        teamAppAccessBackfill: MigrateTeamAppAccessToWorkspaceMembersService,
        defaultMemberRoleBackfill: SeedDefaultMemberRoleExistingWorkspacesService,
        permissionScopesBackfill: BackfillPermissionScopesService,
        workerRegularizationBackfill: BackfillWorkerRegularizationGrantService,
        leaveTypesBackfill: SeedLeaveTypesExistingWorkspacesService,
        leaveRoleGrantsBackfill: BackfillLeaveRoleGrantsService,
        workspacesViewRoleGrantsBackfill: BackfillWorkspacesViewRoleGrantsService,
        rolePermissionPathsBackfill: BackfillRolePermissionPathsService,
        roleAttendancePermissionPathsBackfill: BackfillRoleAttendancePermissionPathsService,
        teamOverridesToPaths: MigrateTeamOverridesToPathsService,
        stripMarkEditSelfScope: StripAttendanceMarkEditSelfScopeService,
        leaveSelfServiceGrantDepsBackfill: BackfillLeaveSelfServiceGrantDepsService,
        hrSalarySensitiveViewBackfill: BackfillHrSalarySensitiveViewService,
        teamMemberWsCastBackfill: BackfillTeamMemberWorkspaceIdObjectIdService,
        wsMemberPartialIndex: MigrateWorkspaceMemberPartialIndexService,
        // Slice 4 (ERP default-data seeds — were gated by SEED_DEFAULTS_ON_BOOTSTRAP)
        tiersAndPlansSeed: SeedDefaultTiersAndPlansService,
        addOnsSeed: SeedDefaultAddOnsService,
        msg91CostsSeed: SeedMsg91CostsService,
        platformAuthOtpWorkspaceSeed: SeedPlatformAuthOtpWorkspaceService,
        // Slice 5 (platform + subscription plan-migrations)
        attendancePlanMigration: AttendancePlanMigrationService,
        financePlanMigration: FinancePlanMigrationService,
        machinesPlanMigration: MachinesPlanMigrationService,
        languagesSeed: LocalizationService,
        // ADR-0001 loose ends
        hsnSeed: HsnStubService,
        ptSlabsSeed: SeedPtSlabsService,
        // Advance self-service (2026-06-14)
        workerRequestAdvanceGrant: BackfillWorkerRequestAdvanceGrantService,
        advanceRequestPolicyBackfill: BackfillAdvanceRequestPolicyService,
        // Salary hardening (2026-06-15, security-review fix HIGH-1 / OQ-S6)
        salaryDeclareTaxGrant: BackfillSalaryDeclareTaxGrantService,
        // Auth hardening (2026-06-14, OQ-4)
        sessionAuditRetention: MigrateSessionAuditRetentionService,
        // Finance/Bills hardening (2026-06-15, OQ-FB-2)
        financePayableRoleGrants: BackfillFinancePayableRoleGrantsService,
        // Connect view-count semantics (2026-06-17, ADR-0002)
        dropEngagementViewTtlIndex: DropEngagementViewTtlIndexService,
        // Connect suggestions live-owner guard (2026-06-17, ADR-0003)
        purgeOrphanConnectProfiles: PurgeOrphanConnectProfilesService,
        // Connect boost region-targeting fix (2026-06-19)
        backfillProfileDistrictCanonical: BackfillProfileDistrictCanonicalService,
        // User.hasWorkspace accuracy fix (2026-06-21)
        backfillUserHasWorkspace: BackfillUserHasWorkspaceService,
        // Legal pages CMS (2026-06-21)
        seedLegalPages: SeedLegalPagesService,
        // Connect demo-content marker (2026-06-21, Demo-Content Scope B)
        backfillConnectContentIsDemo: BackfillConnectContentIsDemoService,
        // Split Payments default-on (2026-06-22)
        backfillSplitPaymentsDefaultOn: BackfillSplitPaymentsDefaultOnService,
        // Loan self-service (2026-06-22)
        workerRequestLoanGrant: BackfillWorkerRequestLoanGrantService,
        // Loan defaults-on (2026-06-22)
        backfillLoanDefaultsOn: BackfillLoanDefaultsOnService,
        // ERP pricing rework Phase 1 (2026-06-23)
        retireLegacyErpPlans: RetireLegacyErpPlansService,
        // ERP pricing rework Phase 1 (2026-06-23) — entitlement reconcile.
        reconcileErpPlanEntitlements: ReconcileErpPlanEntitlementsService,
        // Connect feed harden (2026-07-02, CN-ADS-1) — ad-campaign reserve split.
        backfillAdCampaignReserveSplit: BackfillAdCampaignReserveSplitService,
        // System-role baseline reconcile (2026-07-03)
        reconcileSystemRoleBaseline: ReconcileSystemRoleBaselineService,
        // Strip declare_tax from Employee/Accountant baseline (2026-07-03)
        stripEmployeeDeclareTax: StripEmployeeDeclareTaxGrantService,
        // Employee self-service default-on (2026-07-03)
        backfillSelfServiceDefaultOn: BackfillSelfServiceDefaultOnService,
        // Advance-request policy default-open (2026-07-03)
        advanceRequestPolicyAnyDay: AdvanceRequestPolicyAnyDayService,
        // Advance Payments default-on (2026-07-03)
        backfillAdvancePaymentsDefaultOn: BackfillAdvancePaymentsDefaultOnService,
        // Plan marketing copy + 45-day trial plan (2026-07-03)
        seedPlanMarketingAndTrial: SeedPlanMarketingAndTrialService,
      ): Migration[] => [
        // One-shot backfills (skip-by-name forever once applied).
        {
          name: '0001_connect_backfill_product_and_indexes',
          kind: 'once',
          run: () => connectProductBackfill.run(),
        },
        {
          name: '0002_connect_backfill_subfeature_keys',
          kind: 'once',
          run: () => connectSubFeatureBackfill.run(),
        },
        {
          name: '0003_connect_backfill_listing_storefront',
          kind: 'once',
          run: () => listingStorefrontBackfill.run(),
        },
        // Convergent seeds (re-applied only when their checksum changes).
        {
          name: '0004_connect_seed_tiers_and_plans',
          kind: 'convergent',
          checksum: CONNECT_SEED_CHECKSUMS.tiersAndPlans,
          run: () => connectTiersAndPlansSeed.runSeed(),
        },
        {
          name: '0005_connect_seed_tags',
          kind: 'convergent',
          checksum: CONNECT_SEED_CHECKSUMS.tags,
          run: () => connectTagsSeed.runSeed(),
        },
        {
          name: '0006_connect_seed_ad_placements',
          kind: 'convergent',
          checksum: CONNECT_SEED_CHECKSUMS.adPlacements,
          run: () => adPlacementsSeed.runSeed(),
        },
        // Flag-keyed: re-runs whenever moderation is toggled (matches the old
        // every-boot re-check), so legacy pending listings are released when
        // moderation is off and left alone when it is on.
        {
          name: '0007_connect_backfill_listing_moderation',
          kind: 'convergent',
          checksum: 'connect-removed-noop',
          run: () => listingModerationBackfill.run(),
        },
        // --- Slice 2 (Finance) ---
        // Seeds default GST rate-history only when the collection is empty, so it
        // runs effectively once (no re-seed once populated).
        {
          name: '0008_finance_seed_gst_rate_history',
          kind: 'once',
          run: () => gstRateHistory.seedIfEmpty(),
        },
        // Inventory backfills for existing firms (main godown, new CoA accounts,
        // compliance/textile CoA, godown balances, opening stock movements).
        {
          name: '0009_finance_inventory_backfill',
          kind: 'once',
          run: () => inventoryBackfill.run(),
        },
        // GST cess buckets — upsert UPDATES rates, so convergent (bump checksum
        // when the rate table changes to re-apply).
        {
          name: '0010_finance_seed_cess_rules',
          kind: 'convergent',
          checksum: FINANCE_SEED_CHECKSUMS.cessRules,
          run: () => cessRulesSeed.runSeed(),
        },
        // Default greeting templates — $setOnInsert only, so convergent (bump
        // checksum to add new defaults without touching existing rows).
        {
          name: '0011_finance_seed_greeting_templates',
          kind: 'convergent',
          checksum: FINANCE_SEED_CHECKSUMS.greetingTemplates,
          run: () => greetingTemplatesSeed.runSeed(),
        },
        // --- Slice 3 (RBAC / team / leave / salary) ---
        // One-time retrofits of EXISTING workspaces/roles/members; new ones are
        // seeded inline at creation, so each runs `once` (not every boot). Order
        // is preserved from the old onModuleInit — several top-up an
        // already-settled permission set, so they must run after their
        // predecessors. The services' own per-item error collection is unchanged;
        // the runner only fail-closes on a thrown (catastrophic) error.
        {
          name: '0012_rbac_migrate_pro_to_growth',
          kind: 'once',
          run: () => proToGrowth.run(),
        },
        {
          name: '0013_rbac_team_app_access_backfill',
          kind: 'once',
          run: () => teamAppAccessBackfill.run(),
        },
        {
          name: '0014_rbac_default_member_role_backfill',
          kind: 'once',
          run: () => defaultMemberRoleBackfill.run(),
        },
        {
          name: '0015_rbac_permission_scopes_backfill',
          kind: 'once',
          run: () => permissionScopesBackfill.run(),
        },
        {
          name: '0016_rbac_worker_regularization_grant',
          kind: 'once',
          run: () => workerRegularizationBackfill.run(),
        },
        {
          name: '0017_rbac_leave_types_backfill',
          kind: 'once',
          run: () => leaveTypesBackfill.run(),
        },
        {
          name: '0018_rbac_leave_role_grants_backfill',
          kind: 'once',
          run: () => leaveRoleGrantsBackfill.run(),
        },
        {
          name: '0019_rbac_workspaces_view_role_grants',
          kind: 'once',
          run: () => workspacesViewRoleGrantsBackfill.run(),
        },
        {
          name: '0020_rbac_role_permission_paths_backfill',
          kind: 'once',
          run: () => rolePermissionPathsBackfill.run(),
        },
        {
          name: '0021_rbac_role_attendance_permission_paths',
          kind: 'once',
          run: () => roleAttendancePermissionPathsBackfill.run(),
        },
        {
          name: '0022_rbac_team_overrides_to_paths',
          kind: 'once',
          run: () => teamOverridesToPaths.run(),
        },
        {
          name: '0023_rbac_strip_attendance_mark_edit_self_scope',
          kind: 'once',
          run: () => stripMarkEditSelfScope.run(),
        },
        {
          name: '0024_rbac_leave_self_service_grant_deps',
          kind: 'once',
          run: () => leaveSelfServiceGrantDepsBackfill.run(),
        },
        {
          name: '0025_rbac_hr_salary_sensitive_view',
          kind: 'once',
          run: () => hrSalarySensitiveViewBackfill.run(),
        },
        {
          name: '0026_rbac_team_member_workspaceid_cast',
          kind: 'once',
          run: () => teamMemberWsCastBackfill.run(),
        },
        {
          name: '0027_rbac_workspace_member_partial_index',
          kind: 'once',
          run: () => wsMemberPartialIndex.run(),
        },
        // --- Slice 4 (ERP default-data seeds) ---
        // Previously gated by SEED_DEFAULTS_ON_BOOTSTRAP on boot; now ledgered
        // convergent seeds run by the runner (RUN_MIGRATIONS_ON_BOOT fully
        // replaces that flag). Idempotent (skip-existing / upsert); bump the
        // checksum to re-apply when the seed data changes.
        {
          name: '0028_erp_seed_tiers_and_plans',
          kind: 'convergent',
          checksum: ERP_SEED_CHECKSUMS.tiersAndPlans,
          run: () => tiersAndPlansSeed.runSeed(),
        },
        {
          name: '0029_erp_seed_add_ons',
          kind: 'convergent',
          checksum: ERP_SEED_CHECKSUMS.addOns,
          run: () => addOnsSeed.runSeed(),
        },
        {
          name: '0030_erp_seed_msg91_costs',
          kind: 'convergent',
          checksum: ERP_SEED_CHECKSUMS.msg91Costs,
          run: () => msg91CostsSeed.runSeed(),
        },
        {
          name: '0031_erp_seed_platform_auth_otp_workspace',
          kind: 'convergent',
          checksum: ERP_SEED_CHECKSUMS.authOtpWorkspace,
          run: () => platformAuthOtpWorkspaceSeed.runSeed(),
        },
        // --- Slice 5 (platform + subscription plan-migrations) ---
        // The 3 plan-migrations are one-time entitlement backfills of existing
        // plans/subscriptions (keep their own per-pass error handling). Language
        // seeding is an idempotent "ensure exist" — convergent so a bumped
        // checksum re-applies when the language list grows.
        {
          name: '0032_subscriptions_attendance_plan_migration',
          kind: 'once',
          run: () => attendancePlanMigration.run(),
        },
        {
          name: '0033_subscriptions_finance_plan_migration',
          kind: 'once',
          run: () => financePlanMigration.run(),
        },
        {
          name: '0034_subscriptions_machines_plan_migration',
          kind: 'once',
          run: () => machinesPlanMigration.run(),
        },
        {
          name: '0035_localization_seed_languages',
          kind: 'convergent',
          checksum: PLATFORM_SEED_CHECKSUMS.languages,
          run: () => languagesSeed.ensureLanguagesExist(),
        },
        // --- ADR-0001 loose ends ---
        // HSN code directory: split from its runtime cache-warm (which stays on
        // boot in HsnService). $setOnInsert seed, so convergent.
        {
          name: '0036_finance_seed_hsn_codes',
          kind: 'convergent',
          checksum: LOOSE_END_SEED_CHECKSUMS.hsnCodes,
          run: () => hsnSeed.seedIfMissing(),
        },
        // PT-slab default per-state configs (dedicated service; was admin boot hook).
        // Upsert $sets slabs/rates, so convergent (bump checksum to re-apply).
        {
          name: '0037_admin_seed_pt_slabs',
          kind: 'convergent',
          checksum: LOOSE_END_SEED_CHECKSUMS.ptSlabs,
          run: () => ptSlabsSeed.runSeed(),
        },
        // --- Advance self-service (2026-06-14) ---
        // One-time retrofits of EXISTING workspaces; new ones are seeded inline.
        {
          name: '0038_salary_worker_request_advance_grant',
          kind: 'once',
          run: () => workerRequestAdvanceGrant.run(),
        },
        {
          name: '0039_salary_advance_request_policy_backfill',
          kind: 'once',
          run: () => advanceRequestPolicyBackfill.run(),
        },
        // --- Auth hardening (2026-06-14, OQ-4) ---
        // Drop the stale 7-day expiresAt TTL index on `sessions` and stamp
        // retainUntil on already-cleared rows so the login-audit trail enters
        // the 1-year DPDP window instead of being hard-deleted. One-shot.
        {
          name: '0040_sessions_audit_retention',
          kind: 'once',
          run: () => sessionAuditRetention.run(),
        },
        // --- Salary hardening (2026-06-15, security-review fix HIGH-1 / OQ-S6) ---
        // Backfill the dedicated `salary.declare_tax` action onto existing seeded
        // roles: Worker @self (self-declare own taxes) + HR @all (keep HR's
        // all-scoped upsert path now that the route gates on declare_tax, not
        // salary.edit). New workspaces seed it inline. One-shot, idempotent.
        {
          name: '0041_salary_declare_tax_grant',
          kind: 'once',
          run: () => salaryDeclareTaxGrant.run(),
        },
        // --- Finance/Bills hardening (2026-06-15, OQ-FB-2) ---
        // Merge the new `finance.payable.*` paths onto existing seeded Manager/HR
        // roles so members keep Bills access after BillsController moves off the
        // deprecated AppModule.BILLS flat permission onto the FINANCE path model.
        // Worker/Member roles have NO finance grant, so they are not widened —
        // worker Bills access stays removed (OQ-FB-2). New workspaces seed the
        // grants inline. One-shot, idempotent.
        {
          name: '0042_finance_payable_role_grants',
          kind: 'once',
          run: () => financePayableRoleGrants.run(),
        },
        // --- Connect post view-count semantics (2026-06-17, ADR-0002) ---
        // Drop the stale `engagement_view_ttl` partial TTL index so `view` edges
        // become the permanent lifetime-unique dedup marker behind Post.viewCount
        // (the schema no longer declares the TTL; Mongoose won't drop it itself).
        // One-shot, idempotent (re-run finds no such index → no-op).
        {
          name: '0043_connect_drop_engagement_view_ttl_index',
          kind: 'once',
          run: () => dropEngagementViewTtlIndex.run(),
        },
        // --- Connect suggestions live-owner guard (2026-06-17, ADR-0003) ---
        // Purge orphaned Connect profiles (profile present, owning User gone —
        // hard-deleted accounts / leftover demo data) + their dangling network
        // graph edges, so they stop surfacing in "people you may know" as empty
        // "Connect member" ghost rows. One-shot, idempotent (re-run finds no
        // orphans → no-op). Erased accounts are NOT orphans (erasure keeps the
        // anonymized User), so they are never touched.
        {
          name: '0044_connect_purge_orphan_profiles',
          kind: 'once',
          run: () => purgeOrphanConnectProfiles.run(),
        },
        // --- Connect boost region-targeting fix (2026-06-19) ---
        // Canonicalize existing free-text `connectprofiles.district` to the
        // canonical NAME + stamp geoDistrictSlug/geoStateSlug where the value
        // resolves to exactly one recognized canonical district (india-districts).
        // Unrecognized / blank districts are LEFT unchanged — the matcher's
        // unknown-location fallback already keeps those viewers eligible for
        // region boosts. One-shot, idempotent (re-run finds rows already
        // canonical → no writes; never clobbers a deliberate picker slug).
        {
          name: '0045_connect_backfill_profile_district_canonical',
          kind: 'once',
          run: () => backfillProfileDistrictCanonical.run(),
        },
        // --- User.hasWorkspace accuracy fix (2026-06-21) ---
        // Recompute User.hasWorkspace from real workspace ownership: owners of a
        // live workspace -> true; everyone else (incl. never-set/undefined) ->
        // explicit false. Fixes Connect-only / workspace-less accounts that read
        // as ERP users and got force-PIN'd. One-shot, idempotent (re-run -> 0
        // writes). The flag is kept accurate going forward by
        // WorkspacesService.recomputeHasWorkspace (create / remove / restore).
        {
          name: '0046_users_backfill_has_workspace',
          kind: 'once',
          run: () => backfillUserHasWorkspace.run(),
        },
        // --- Admin-managed legal pages CMS (2026-06-21) ---
        // Seed the 4 legal docs (terms/privacy × connect/erp) as DRAFTS so the
        // public /terms + /privacy routes always have a row to resolve to once an
        // admin publishes. Skip-existing, so re-runs never clobber edited/published
        // content. Convergent: bump LEGAL_SEED_CHECKSUMS.pages to add new docs.
        {
          name: '0047_legal_pages_seed_drafts',
          kind: 'convergent',
          checksum: LEGAL_SEED_CHECKSUMS.pages,
          run: () => seedLegalPages.runSeed(),
        },
        // --- Connect demo-content marker (2026-06-21, Demo-Content Scope B) ---
        // Stamp the denormalized `isDemo:true` flag onto existing Connect content
        // docs (posts / listings / jobs / applications / rfqs / quotes) whose
        // OWNER is a seeded demo account (User.isDemo:true OR @connect-demo email),
        // so the FE "Sample" badge + the feed/search demo down-rank read one
        // source. New content is stamped at create from the author's User.isDemo;
        // this retrofits the pre-field rows. One-shot, idempotent (`$ne:true`
        // guard → re-run modifies 0; real docs are never touched).
        {
          name: '0048_connect_backfill_content_is_demo',
          kind: 'once',
          run: () => backfillConnectContentIsDemo.run(),
        },
        // --- Split Payments default-on (2026-06-22, owner directive) ---
        // Flip features.splitPayments -> true on existing workspaces so "default
        // active" applies to already-created tenants (new ones seed true inline).
        // One-shot, idempotent ($ne:true guard => re-run modifies 0). Reversible.
        {
          name: '0049_salary_split_payments_default_on',
          kind: 'once',
          run: () => backfillSplitPaymentsDefaultOn.run(),
        },
        // --- Loan self-service (2026-06-22) ---
        // Retro-grant `salary.request_loan` (self) onto existing seeded Worker
        // roles so workers can self-apply for an interest-free loan (new
        // workspaces seed it inline via DEFAULT_WORKER_ROLE). One-shot,
        // idempotent (re-run finds the grant present => 0 writes). Inert until
        // the workspace also enables the `loan_management` feature AND
        // loanConfig.selfApplyEnabled (both default OFF), exactly like the
        // request_advance grant — so granting the permission is safe.
        {
          name: '0050_salary_worker_request_loan_grant',
          kind: 'once',
          run: () => workerRequestLoanGrant.run(),
        },
        // --- Loan defaults-on (2026-06-22, owner directive) ---
        // Make the 0% employee loan available by default on existing workspaces:
        // turn on BOTH gates it needs (features.loanManagement +
        // loanConfig.selfApplyEnabled). New workspaces seed both true inline.
        // One-shot, idempotent ($or filter => re-run modifies 0). Reversible.
        {
          name: '0051_salary_loan_defaults_on',
          kind: 'once',
          run: () => backfillLoanDefaultsOn.run(),
        },
        // --- ERP pricing rework Phase 1 (2026-06-23) ---
        // Converge existing DBs on the canonical 5-plan ERP set: deactivate +
        // hide the public Enterprise plan + its tier (preserved for any existing
        // subscriptions, never deleted); flag Custom not-public + custom; and
        // delete-or-deactivate the legacy hand-seed / `pro` plans keyed on their
        // live subscription count (data-safe — a plan with subs is deactivated +
        // warned, never deleted; the owner re-points those subs manually).
        // Runs AFTER 0028 (ERP tiers/plans seed) so the canonical Custom row is
        // already present. One-shot, idempotent (re-run deletes nothing, throws
        // nothing — Enterprise/Custom updates are convergent, legacy candidates
        // are already gone or already deactivated).
        {
          name: '0052_erp_retire_legacy_plans',
          kind: 'once',
          run: () => retireLegacyErpPlans.run(),
        },
        // --- ERP pricing rework Phase 1 (2026-06-23) — entitlement reconcile ---
        // Force-correct the drifting capacity + price fields on existing ERP
        // plan/tier docs back to the canonical seed values (the seed only
        // INSERTS, never corrects), fixing the stale "5 team members" cap on
        // Starter/Growth pricing cards. Runs AFTER 0052 (legacy retirement) so
        // we reconcile only the surviving canonical set. One-shot, idempotent
        // (re-run re-issues the same $set with values already in place → 0
        // modified; never creates a missing tier/plan, never touches Connect).
        {
          name: '0053_erp_reconcile_plan_entitlements',
          kind: 'once',
          run: () => reconcileErpPlanEntitlements.run(),
        },
        // --- Connect feed harden (2026-07-02, CN-ADS-1) ---
        // Stamp reservedFromGrant/reservedFromBalance on in-flight ad campaigns
        // so the split-aware release() restores grant vs purchased credits to
        // their origin bucket (before this, release always credited balance,
        // silently promoting expiring grant credits to permanent). Grant-blind
        // default (all-purchased) => backfilled campaigns behave exactly as
        // before; only post-fix reserves carry the real split. One-shot,
        // idempotent (both-fields-absent guard => re-run modifies 0).
        {
          name: '0054_connect_backfill_ad_campaign_reserve_split',
          kind: 'once',
          run: () => backfillAdCampaignReserveSplit.run(),
        },
        // --- System-role baseline reconcile (2026-07-03, owner directive) ---
        // Union-merge the current DEFAULT_ROLES grants (flat permissions +
        // permissionPaths) onto every workspace's seeded system roles
        // (Partner/Manager/Accountant/Employee) so roles seeded before newer
        // permissions existed regain the full baseline. Never removes a grant;
        // owner additions are preserved; scope only ever widens (all > self).
        // Convergent: bump RBAC_BASELINE_CHECKSUMS.systemRoles whenever the
        // defaults in role-seeder.constants.ts change.
        {
          name: '0055_rbac_reconcile_system_role_baseline',
          kind: 'convergent',
          checksum: RBAC_BASELINE_CHECKSUMS.systemRoles,
          run: () => reconcileSystemRoleBaseline.run(),
        },
        // --- Strip declare_tax from Employee/Accountant baseline (2026-07-03,
        // owner directive) --- tax declaration is an advanced statutory feature
        // granted per role explicitly, not a default. Removes the grant the v2
        // baseline briefly wrote onto Employee/Accountant system roles. Runs
        // AFTER 0055 (whose v3 defaults no longer carry it, so it cannot be
        // re-added). One-shot, idempotent (no action found => 0 writes).
        {
          name: '0056_rbac_strip_employee_declare_tax',
          kind: 'once',
          run: () => stripEmployeeDeclareTax.run(),
        },
        // --- Employee self-service default-on (2026-07-03, owner directive) ---
        // Flip selfServiceConfig.selfPunch + selfLeaveApply true on existing
        // workspaces (new ones seed true via schema defaults) so the Employee
        // baseline's self-scoped grants actually surface in the UI (leave
        // Apply button, self check-in, self regularization). One-shot,
        // idempotent ($ne:true filters => re-run modifies 0). Reversible per
        // workspace via the settings toggle.
        {
          name: '0057_workspaces_self_service_default_on',
          kind: 'once',
          run: () => backfillSelfServiceDefaultOn.run(),
        },
        // --- Advance-request policy default-open (2026-07-03, owner directive) ---
        // Flip the 0039-stamped fixed_day advance-request policies to any_day so
        // employees can request an advance anytime by default (windows/fixed days
        // stay per-workspace opt-in via Payroll Settings; explicit `window`
        // policies untouched; fixedDay kept for settings round-trip). One-shot,
        // idempotent (mode filter => re-run matches 0).
        {
          name: '0058_salary_advance_request_policy_any_day',
          kind: 'once',
          run: () => advanceRequestPolicyAnyDay.run(),
        },
        // --- Advance Payments default-on (2026-07-03, owner directive) ---
        // Flip features.advancePayments true on existing workspaces so employee
        // advance-salary requests work out of the box (new workspaces seed true
        // via the basic preset + schema default). Mirrors 0049 split payments.
        // One-shot, idempotent ($ne:true guard => re-run modifies 0). Reversible
        // per workspace via Payroll Settings.
        {
          name: '0059_salary_advance_payments_default_on',
          kind: 'once',
          run: () => backfillAdvancePaymentsDefaultOn.run(),
        },
        // --- Plan marketing copy + 45-day trial plan (2026-07-03, marketing task) ---
        // Backfill localized marketing.{tagline,featureHighlights,isHighlighted,
        // displayOrder} onto the 4 canonical ERP plans (all 4 locales; Growth
        // highlighted) AND seed the opt-in 45-day full-access trial plan when none
        // exists. Runs LAST so the ERP plans (0028) already exist — a missing plan
        // is warned + skipped, not created. Convergent: bump
        // PLAN_MARKETING_CHECKSUMS.copy to re-apply the canonical copy (which
        // OVERWRITES admin-edited marketing text). The trial-plan seed is
        // skip-if-exists so re-runs never duplicate it.
        {
          name: '0060_plans_seed_marketing_and_trial',
          kind: 'convergent',
          checksum: PLAN_MARKETING_CHECKSUMS.copy,
          run: () => seedPlanMarketingAndTrial.run(),
        },
      ],
      inject: [
        BackfillConnectProductAndIndexesService,
        BackfillConnectSubFeatureKeysService,
        BackfillListingStorefrontService,
        SeedConnectTiersAndPlansService,
        SeedConnectTagsService,
        SeedConnectAdPlacementsService,
        BackfillListingModerationService,
        // Slice 2 (Finance)
        GstRateHistoryStubService,
        InventoryMigrationStubService,
        CessRulesSeedStubService,
        ReminderTemplatesStubService,
        // Slice 3 (RBAC / team / leave / salary)
        MigrateProToGrowthService,
        MigrateTeamAppAccessToWorkspaceMembersService,
        SeedDefaultMemberRoleExistingWorkspacesService,
        BackfillPermissionScopesService,
        BackfillWorkerRegularizationGrantService,
        SeedLeaveTypesExistingWorkspacesService,
        BackfillLeaveRoleGrantsService,
        BackfillWorkspacesViewRoleGrantsService,
        BackfillRolePermissionPathsService,
        BackfillRoleAttendancePermissionPathsService,
        MigrateTeamOverridesToPathsService,
        StripAttendanceMarkEditSelfScopeService,
        BackfillLeaveSelfServiceGrantDepsService,
        BackfillHrSalarySensitiveViewService,
        BackfillTeamMemberWorkspaceIdObjectIdService,
        MigrateWorkspaceMemberPartialIndexService,
        // Slice 4 (ERP default-data seeds)
        SeedDefaultTiersAndPlansService,
        SeedDefaultAddOnsService,
        SeedMsg91CostsService,
        SeedPlatformAuthOtpWorkspaceService,
        // Slice 5 (platform + subscription plan-migrations)
        AttendancePlanMigrationService,
        FinancePlanMigrationService,
        MachinesPlanMigrationService,
        LocalizationService,
        // ADR-0001 loose ends
        HsnStubService,
        SeedPtSlabsService,
        // Advance self-service (2026-06-14)
        BackfillWorkerRequestAdvanceGrantService,
        BackfillAdvanceRequestPolicyService,
        // Salary hardening (2026-06-15, security-review fix HIGH-1 / OQ-S6)
        BackfillSalaryDeclareTaxGrantService,
        // Auth hardening (2026-06-14, OQ-4)
        MigrateSessionAuditRetentionService,
        // Finance/Bills hardening (2026-06-15, OQ-FB-2)
        BackfillFinancePayableRoleGrantsService,
        // Connect view-count semantics (2026-06-17, ADR-0002)
        DropEngagementViewTtlIndexService,
        // Connect suggestions live-owner guard (2026-06-17, ADR-0003)
        PurgeOrphanConnectProfilesService,
        // Connect boost region-targeting fix (2026-06-19)
        BackfillProfileDistrictCanonicalService,
        // User.hasWorkspace accuracy fix (2026-06-21)
        BackfillUserHasWorkspaceService,
        // Legal pages CMS (2026-06-21)
        SeedLegalPagesService,
        // Connect demo-content marker (2026-06-21, Demo-Content Scope B)
        BackfillConnectContentIsDemoService,
        // Split Payments default-on (2026-06-22)
        BackfillSplitPaymentsDefaultOnService,
        // Loan self-service (2026-06-22)
        BackfillWorkerRequestLoanGrantService,
        // Loan defaults-on (2026-06-22)
        BackfillLoanDefaultsOnService,
        // ERP pricing rework Phase 1 (2026-06-23)
        RetireLegacyErpPlansService,
        // ERP pricing rework Phase 1 (2026-06-23) — entitlement reconcile.
        ReconcileErpPlanEntitlementsService,
        // Connect feed harden (2026-07-02, CN-ADS-1) — ad-campaign reserve split.
        BackfillAdCampaignReserveSplitService,
        // System-role baseline reconcile (2026-07-03)
        ReconcileSystemRoleBaselineService,
        // Strip declare_tax from Employee/Accountant baseline (2026-07-03)
        StripEmployeeDeclareTaxGrantService,
        // Employee self-service default-on (2026-07-03)
        BackfillSelfServiceDefaultOnService,
        // Advance-request policy default-open (2026-07-03)
        AdvanceRequestPolicyAnyDayService,
        // Advance Payments default-on (2026-07-03)
        BackfillAdvancePaymentsDefaultOnService,
        // Plan marketing copy + 45-day trial plan (2026-07-03)
        SeedPlanMarketingAndTrialService,
      ],
    },
  ],
  exports: [
    SeedDefaultTiersAndPlansService,
    SeedDefaultAddOnsService,
    MigrateProToGrowthService,
    SeedMsg91CostsService,
    SeedPlatformAuthOtpWorkspaceService,
    MigrateTeamAppAccessToWorkspaceMembersService,
    SeedDefaultMemberRoleExistingWorkspacesService,
    MigrateWorkspaceMemberPartialIndexService,
    BackfillPermissionScopesService,
    BackfillWorkerRegularizationGrantService,
    SeedLeaveTypesExistingWorkspacesService,
    BackfillLeaveRoleGrantsService,
    BackfillWorkspacesViewRoleGrantsService,
    BackfillRolePermissionPathsService,
    BackfillRoleAttendancePermissionPathsService,
    MigrateTeamOverridesToPathsService,
    StripAttendanceMarkEditSelfScopeService,
    BackfillLeaveSelfServiceGrantDepsService,
    BackfillHrSalarySensitiveViewService,
    BackfillTeamMemberWorkspaceIdObjectIdService,
    SeedConnectTiersAndPlansService,
    BackfillConnectProductAndIndexesService,
    BackfillConnectSubFeatureKeysService,
    BackfillListingStorefrontService,
    SeedConnectTagsService,
    // Exported so the `npm run migrate` CLI (src/migrate.ts) can resolve it.
    MigrationRunnerService,
  ],
})
// No lifecycle hooks. This module wires the migration runner + every migration
// unit (the MIGRATION_UNITS registry above); NOTHING runs on boot anymore.
// Migrations execute via `npm run migrate` (CLI / CI step) or the opt-in
// RUN_MIGRATIONS_ON_BOOT dev flag — see MigrationRunnerService + ADR-0001. The
// old SEED_DEFAULTS_ON_BOOTSTRAP gate is gone (RUN_MIGRATIONS_ON_BOOT replaces it).
// Do NOT re-add an onModuleInit seed/backfill hook here on merge.
export class MigrationsModule {}
