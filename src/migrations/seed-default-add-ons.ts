import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AddOnDefinition,
  AddOnType,
  AddOnBillingCycle,
} from '../modules/add-ons/schemas/add-on-definition.schema';
import { AppModule } from '../common/enums/modules.enum';
import { FeatureAccessLevel } from '../common/enums/feature-access.enum';

/**
 * Seed default Add-on definitions per ADD_ON_INVENTORY.md §6.
 *
 * Idempotent — re-runnable safely. Uses upsert by slug.
 *
 * Categories:
 *   1. Quota bumps (members, workspaces, sessions, storage, emails)
 *   2. Module unlocks (sell premium modules to lower-tier customers)
 *   3. Sub-feature upgrades (single-feature unlocks, e.g. Form 16, Tally export)
 *   4. Lifetime / one-time bundles (onboarding, data migration)
 *
 * NOTES:
 *   - Wave 4: Credit packs (SMS/WhatsApp) NOW SEEDED — 8 entries (4 SMS sizes,
 *     4 WhatsApp sizes). Type CREDIT_PACK, lifetime billing (credits don't
 *     expire — they sit on subscription.appliedEntitlements.communications.*).
 *   - Storage/extra-firms are NOT seeded yet — entitlement schema needs
 *     storageGbPerWorkspace + extraFirms fields added first (drift #36).
 *     Documented in ADD_ON_INVENTORY.md §6.1 for future seeding.
 *   - Pricing is realistic India SaaS — calibrate via sales feedback.
 *     SMS @ ₹0.20-0.30/credit, WhatsApp @ ₹0.50-0.85/credit (utility template).
 */
@Injectable()
export class SeedDefaultAddOnsService {
  private readonly logger = new Logger(SeedDefaultAddOnsService.name);

  constructor(
    @InjectModel(AddOnDefinition.name)
    private addOnModel: Model<AddOnDefinition>,
  ) {}

  // ── ADD-ON DEFINITIONS ────────────────────────────────────────────
  private readonly ADDON_DEFINITIONS: Array<{
    slug: string;
    name: string;
    description: string;
    type: AddOnType;
    monthlyPrice: number;
    yearlyPrice: number;
    lifetimePrice: number;
    stackable: boolean;
    maxStack: number;
    applicableTiers: string[];
    defaultBillingCycle: AddOnBillingCycle;
    allowedBillingCycles: string[];
    allowProratedBilling: boolean;
    minDaysBeforeRenewal: number;
    displayOrder: number;
    entitlementDelta: {
      extraWorkspaces?: number;
      extraMembersPerWorkspace?: number;
      extraTotalMembers?: number;
      extraSessionsPerPlatform?: number;
      extraSessionsTotal?: number;
      targetModule?: AppModule;
      targetSubFeatureModule?: AppModule;
      targetSubFeatureKey?: string;
      targetSubFeatureAccess?: FeatureAccessLevel;
      featureOverrides?: Record<string, boolean>;
      creditsDelta?: { sms?: number; whatsapp?: number };
    };
  }> = [
    // ── Category 1: Quota bumps ─────────────────────────────────────
    {
      slug: 'extra-members-5',
      name: '+5 Team Members',
      description:
        'Add 5 more team members to your workspace — pay only for what you need.',
      type: AddOnType.QUOTA,
      monthlyPrice: 299,
      yearlyPrice: 2999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 20,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 10,
      entitlementDelta: { extraTotalMembers: 5 },
    },
    {
      slug: 'extra-members-25',
      name: '+25 Team Members',
      description:
        'Scaling fast? Add 25 members at a discount — perfect for seasonal hiring.',
      type: AddOnType.QUOTA,
      monthlyPrice: 1199,
      yearlyPrice: 11999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 8,
      applicableTiers: ['growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 11,
      entitlementDelta: { extraTotalMembers: 25 },
    },
    {
      slug: 'extra-workspace-1',
      name: '+1 Workspace',
      description:
        'Run a second branch / GSTIN / business under its own workspace. (One workspace = one GSTIN by design.)',
      type: AddOnType.QUOTA,
      monthlyPrice: 499,
      yearlyPrice: 4999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 10,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 20,
      entitlementDelta: { extraWorkspaces: 1 },
    },
    {
      slug: 'extra-workspaces-5',
      name: '+5 Workspaces Pack',
      description:
        'Multi-state / multi-branch / holding-co operator? Add 5 workspaces at a discount.',
      type: AddOnType.QUOTA,
      monthlyPrice: 1999,
      yearlyPrice: 19999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 4,
      applicableTiers: ['growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 21,
      entitlementDelta: { extraWorkspaces: 5 },
    },
    {
      slug: 'extra-sessions-3',
      name: '+3 Concurrent Sessions',
      description:
        'Let more managers log in at once during shift handovers.',
      type: AddOnType.QUOTA,
      monthlyPrice: 199,
      yearlyPrice: 1999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 5,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 30,
      entitlementDelta: { extraSessionsTotal: 3 },
    },
    {
      slug: 'extra-emails-500',
      name: '+500 Emails / month',
      description:
        'Send 500 more emails monthly — payslips, invoices, reminders.',
      type: AddOnType.QUOTA,
      monthlyPrice: 199,
      yearlyPrice: 1999,
      lifetimePrice: 0,
      stackable: true,
      maxStack: 10,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 40,
      entitlementDelta: {},
      // Note: emailsPerMonth delta needs added to AddOnEntitlementDelta schema
      // OR handled via featureOverrides until then. Currently the +500 doesn't
      // wire into entitlement-merge because the field isn't on the delta type.
    },

    // ── Category 2: Module unlocks (à-la-carte tier upgrades) ───────
    {
      slug: 'module-shifts',
      name: 'Shifts Module',
      description:
        'Add shift scheduling to your free plan — no need to upgrade the whole tier.',
      type: AddOnType.MODULE,
      monthlyPrice: 399,
      yearlyPrice: 3999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['free'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 100,
      entitlementDelta: { targetModule: AppModule.SHIFTS },
    },
    {
      slug: 'module-roles',
      name: 'Custom Roles',
      description:
        'Define custom roles beyond the default Manager / HR / Operator set.',
      type: AddOnType.MODULE,
      monthlyPrice: 399,
      yearlyPrice: 3999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['free'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 101,
      entitlementDelta: { targetModule: AppModule.ROLES },
    },
    {
      slug: 'module-machines',
      name: 'Machines + Operations',
      description:
        'Track every machine — assignments, production, downtime, maintenance.',
      type: AddOnType.MODULE,
      monthlyPrice: 999,
      yearlyPrice: 9999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 110,
      entitlementDelta: { targetModule: AppModule.MACHINES },
    },
    {
      slug: 'module-finance',
      name: 'Finance (Core Accounting)',
      description: 'Add full GST accounting to your starter plan.',
      type: AddOnType.MODULE,
      monthlyPrice: 1499,
      yearlyPrice: 14999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 120,
      entitlementDelta: { targetModule: AppModule.FINANCE },
    },
    {
      slug: 'module-gst-compliance',
      name: 'GST Compliance Suite',
      description:
        'GSTR-1, GSTR-3B, e-invoice, e-way bills, ITC-04 — full compliance.',
      type: AddOnType.MODULE,
      monthlyPrice: 999,
      yearlyPrice: 9999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 130,
      entitlementDelta: { targetModule: AppModule.GST_COMPLIANCE },
    },
    {
      slug: 'module-inventory',
      name: 'Inventory Management',
      description:
        'Multi-godown inventory with serial-number tracking, lot/batch, samples.',
      type: AddOnType.MODULE,
      monthlyPrice: 799,
      yearlyPrice: 7999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 140,
      entitlementDelta: { targetModule: AppModule.INVENTORY },
    },
    {
      slug: 'module-manufacturing',
      name: 'Manufacturing',
      description:
        'BOM design + production vouchers + automatic WIP/FG/COGS posting.',
      type: AddOnType.MODULE,
      monthlyPrice: 1299,
      yearlyPrice: 12999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 150,
      entitlementDelta: { targetModule: AppModule.MANUFACTURING },
    },
    {
      slug: 'module-job-work',
      name: 'Job Work',
      description:
        'Outward/inward challans, processor invoicing, lot tracking, ITC-04.',
      type: AddOnType.MODULE,
      monthlyPrice: 899,
      yearlyPrice: 8999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 160,
      entitlementDelta: { targetModule: AppModule.JOB_WORK },
    },
    {
      slug: 'module-regularization',
      name: 'Attendance Regularization',
      description:
        'Approval workflow for attendance corrections — request, approve, reject with audit.',
      type: AddOnType.MODULE,
      monthlyPrice: 299,
      yearlyPrice: 2999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 170,
      entitlementDelta: { targetModule: AppModule.REGULARIZATION },
    },
    {
      slug: 'module-maintenance',
      name: 'Preventive Maintenance',
      description:
        'Schedule preventive maintenance + log work orders so machines do not fail when you cannot afford it.',
      type: AddOnType.MODULE,
      monthlyPrice: 1499,
      yearlyPrice: 14999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 180,
      entitlementDelta: { targetModule: AppModule.MAINTENANCE },
    },

    // ── Category 3: Sub-feature upgrades ────────────────────────────
    {
      slug: 'subfeature-form16',
      name: 'Form 16 Generation',
      description:
        'Issue annual Form 16 TDS certificates without upgrading to Enterprise.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 499,
      yearlyPrice: 4999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.YEARLY, // Form 16 is annual
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 200,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.SALARY,
        targetSubFeatureKey: 'form16_generation',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },
    {
      slug: 'subfeature-fnf',
      name: 'Full & Final Settlement',
      description: 'Run formal exit workflows with gratuity payout.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 399,
      yearlyPrice: 3999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 201,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.SALARY,
        targetSubFeatureKey: 'fnf_settlement',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },
    {
      slug: 'subfeature-payslip-email',
      name: 'Payslip Email Delivery',
      description:
        'Auto-email payslips to all employees in one click.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 299,
      yearlyPrice: 2999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 210,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.SALARY,
        targetSubFeatureKey: 'payslip_email',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },
    {
      slug: 'subfeature-pdf-branding',
      name: 'PDF Branding',
      description:
        'Brand every exported PDF with your logo and details.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 199,
      yearlyPrice: 1999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 220,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.SETTINGS,
        targetSubFeatureKey: 'pdf_branding',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },
    {
      slug: 'subfeature-tally-export',
      name: 'Tally XML Export',
      description:
        'Export your books to Tally XML for legacy ERP bridges.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 299,
      yearlyPrice: 2999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 230,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.FINANCE,
        targetSubFeatureKey: 'finance_advanced',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },
    {
      slug: 'subfeature-statutory-compliance',
      name: 'Statutory Compliance (PF/ESI/PT)',
      description:
        'Manage PF, ESI, PT, TDS settings per state — full compliance.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 599,
      yearlyPrice: 5999,
      lifetimePrice: 0,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth'],
      defaultBillingCycle: AddOnBillingCycle.MONTHLY,
      allowedBillingCycles: ['monthly', 'yearly'],
      allowProratedBilling: true,
      minDaysBeforeRenewal: 0,
      displayOrder: 240,
      entitlementDelta: {
        targetSubFeatureModule: AppModule.SALARY,
        targetSubFeatureKey: 'statutory_compliance',
        targetSubFeatureAccess: FeatureAccessLevel.FULL,
      },
    },

    // ── Category 4: Lifetime / one-time bundles ─────────────────────
    {
      slug: 'lifetime-onboarding',
      name: 'Setup & Onboarding Bundle',
      description:
        'One-time setup with a dedicated specialist — masters, imports, rules.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 9999,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 300,
      entitlementDelta: {
        featureOverrides: { whiteGloveOnboarding: true },
      },
    },
    {
      slug: 'lifetime-data-migration',
      name: 'Tally Data Migration',
      description:
        'One-time migration of historical Tally data into ManekHR.',
      type: AddOnType.SUBFEATURE,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 14999,
      stackable: false,
      maxStack: 1,
      applicableTiers: ['starter', 'growth', 'business'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 310,
      entitlementDelta: {
        featureOverrides: { tallyMigration: true },
      },
    },
    // ── Category 5: Credit packs (SMS / WhatsApp) ───────────────────
    // Lifetime billing — credits don't expire, they sit on
    // subscription.appliedEntitlements.communications.* and decrement per send.
    // Stackable (customers can buy multiple packs for big campaigns).
    // Applicable to ALL paid tiers + free (free can buy a pack to try SMS).
    {
      slug: 'sms-pack-100',
      name: 'SMS Pack — 100 credits',
      description:
        '100 DLT-templated SMS sends via MSG91. Credits never expire.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 35,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 400,
      entitlementDelta: { creditsDelta: { sms: 100 } },
    },
    {
      slug: 'sms-pack-500',
      name: 'SMS Pack — 500 credits',
      description: '500 DLT-templated SMS sends. Best for monthly reminders.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 150,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 401,
      entitlementDelta: { creditsDelta: { sms: 500 } },
    },
    {
      slug: 'sms-pack-2000',
      name: 'SMS Pack — 2,000 credits',
      description: '2,000 DLT-templated SMS sends. Volume discount.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 520,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 402,
      entitlementDelta: { creditsDelta: { sms: 2000 } },
    },
    {
      slug: 'sms-pack-5000',
      name: 'SMS Pack — 5,000 credits',
      description: '5,000 DLT-templated SMS sends. Best per-credit rate.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 900,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 403,
      entitlementDelta: { creditsDelta: { sms: 5000 } },
    },
    {
      slug: 'whatsapp-pack-100',
      name: 'WhatsApp Pack — 100 credits',
      description:
        '100 WhatsApp utility-template sends via AiSensy. Credits never expire.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 95,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 410,
      entitlementDelta: { creditsDelta: { whatsapp: 100 } },
    },
    {
      slug: 'whatsapp-pack-500',
      name: 'WhatsApp Pack — 500 credits',
      description: '500 WhatsApp utility-template sends.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 400,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 411,
      entitlementDelta: { creditsDelta: { whatsapp: 500 } },
    },
    {
      slug: 'whatsapp-pack-2000',
      name: 'WhatsApp Pack — 2,000 credits',
      description: '2,000 WhatsApp utility-template sends. Volume discount.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 1400,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 412,
      entitlementDelta: { creditsDelta: { whatsapp: 2000 } },
    },
    {
      slug: 'whatsapp-pack-5000',
      name: 'WhatsApp Pack — 5,000 credits',
      description: '5,000 WhatsApp utility-template sends. Best per-credit rate.',
      type: AddOnType.CREDIT_PACK,
      monthlyPrice: 0,
      yearlyPrice: 0,
      lifetimePrice: 2750,
      stackable: true,
      maxStack: -1,
      applicableTiers: ['free', 'starter', 'growth', 'business', 'enterprise'],
      defaultBillingCycle: AddOnBillingCycle.LIFETIME,
      allowedBillingCycles: ['lifetime'],
      allowProratedBilling: false,
      minDaysBeforeRenewal: 0,
      displayOrder: 413,
      entitlementDelta: { creditsDelta: { whatsapp: 5000 } },
    },
  ];

  async seedAddOns(): Promise<{
    inserted: number;
    updated: number;
    skipped: number;
  }> {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const def of this.ADDON_DEFINITIONS) {
      const existing = await this.addOnModel
        .findOne({ slug: def.slug })
        .exec();

      // Wave 8 — only CREDIT_PACK definitions are upserted (price-aware
      // re-seed). All other add-on types remain skip-on-existing so admin
      // edits via /admin/add-ons survive a re-seed. PurchasedAddOn rows
      // already snapshot the price + entitlement at activation time, so
      // existing customers are not affected by repricing.
      const isCreditPack = def.type === AddOnType.CREDIT_PACK;

      if (existing) {
        if (!isCreditPack) {
          this.logger.log(`Add-on '${def.slug}' already exists — skipping.`);
          skipped++;
          continue;
        }

        const priceChanged =
          existing.monthlyPrice !== def.monthlyPrice ||
          existing.yearlyPrice !== def.yearlyPrice ||
          existing.lifetimePrice !== def.lifetimePrice;

        if (!priceChanged) {
          skipped++;
          continue;
        }

        await this.addOnModel.updateOne(
          { _id: existing._id },
          {
            $set: {
              name: def.name,
              description: def.description,
              monthlyPrice: def.monthlyPrice,
              yearlyPrice: def.yearlyPrice,
              lifetimePrice: def.lifetimePrice,
            },
          },
        );
        this.logger.log(
          `Add-on '${def.slug}' repriced (lifetime ₹${existing.lifetimePrice} → ₹${def.lifetimePrice}). PurchasedAddOn snapshots untouched.`,
        );
        updated++;
        continue;
      }

      await this.addOnModel.create({
        name: def.name,
        description: def.description,
        slug: def.slug,
        type: def.type,
        entitlementDelta: def.entitlementDelta,
        monthlyPrice: def.monthlyPrice,
        yearlyPrice: def.yearlyPrice,
        lifetimePrice: def.lifetimePrice,
        stackable: def.stackable,
        maxStack: def.maxStack,
        applicableTiers: def.applicableTiers,
        isActive: true,
        displayOrder: def.displayOrder,
        defaultBillingCycle: def.defaultBillingCycle,
        allowedBillingCycles: def.allowedBillingCycles,
        allowProratedBilling: def.allowProratedBilling,
        minDaysBeforeRenewal: def.minDaysBeforeRenewal,
      });

      this.logger.log(
        `Add-on '${def.slug}' (${def.name}) seeded — type=${def.type}, ₹${def.monthlyPrice}/mo.`,
      );
      inserted++;
    }

    return { inserted, updated, skipped };
  }

  async runSeed(): Promise<{
    inserted: number;
    updated: number;
    skipped: number;
  }> {
    this.logger.log('Starting default Add-ons seed...');
    const result = await this.seedAddOns();
    this.logger.log(
      `Add-on seed complete: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped.`,
    );
    return result;
  }
}
