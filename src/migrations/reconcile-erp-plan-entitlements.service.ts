import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Plan } from '../modules/subscriptions/schemas/plan.schema';
import { Tier } from '../modules/subscriptions/schemas/tier.schema';
import {
  CANONICAL_ERP_TIER_KEYS,
  CANONICAL_ERP_TIER_CAPS,
  CANONICAL_ERP_PLAN_PRICES,
} from './canonical-erp-plans.constants';

/**
 * Phase-1 ERP pricing rework (2026-06-23) — RECONCILE plan/tier entitlements.
 *
 * Real bug. The in-app + marketing pricing cards read each plan's
 * `entitlements.maxMembersPerWorkspace`. In some owner DBs the Starter and
 * Growth plans show "5 team members" because those plan rows still carry a stale
 * member cap of 5 (the Free-tier default). The canonical seed
 * (`seed-default-tiers-and-plans.ts`) only INSERTS plans/tiers (idempotent
 * skip-if-exists) — it NEVER corrects an existing one, so drift like this
 * persists indefinitely. (Business reads 500 correctly because it was created
 * fresh.)
 *
 * This migration force-reconciles the small set of capacity + price fields that
 * drift visibly, ERP-only (`product != 'connect'`), back to the canonical source
 * of truth, and is safe to re-run (un-driftable):
 *   1. TIERS (by `key`, only if the doc exists — never created):
 *        defaultEntitlements.maxMembersPerWorkspace / .maxWorkspaces / .maxTotalMembers
 *   2. PLANS (matched by canonical tier, ERP product — ALL ERP plans of that
 *      tier are corrected so they all carry the canonical cap):
 *        entitlements.maxMembersPerWorkspace / .maxWorkspaces / .maxTotalMembers
 *        + monthlyPrice + yearlyPrice
 *
 * It does NOT touch moduleAccess, names, marketing, sessions/storage/email
 * overrides, or anything else — only the drifting capacity/price fields. The
 * retired `enterprise` tier/plan is intentionally absent from the canonical map,
 * so it is never reconciled (it is handled by 0052 retire-legacy-erp-plans).
 * Connect plans are excluded by the ERP-only guard.
 *
 * Idempotent: a second run re-issues the same `updateOne` `$set` with values
 * already in place — harmless. We tally how many docs actually changed via
 * `modifiedCount` for the summary log.
 *
 * NOT auto-run on boot. Wired into the ledgered migration runner
 * (MigrationsModule) as a `once` unit ordered AFTER 0052; runs via
 * `npm run migrate`.
 *
 * The canonical caps + prices come from the shared
 * `./canonical-erp-plans.constants` module (CANONICAL_ERP_TIER_CAPS +
 * CANONICAL_ERP_PLAN_PRICES) — the SAME source the seed imports — so the seed and
 * this migration can never disagree (DRY; no "keep-in-sync by comment" drift).
 * `custom` uses -1 sentinels (unlimited / admin-defined). Enterprise is
 * deliberately absent from that map (retired) so it is never reconciled here.
 */

@Injectable()
export class ReconcileErpPlanEntitlementsService {
  private readonly logger = new Logger(ReconcileErpPlanEntitlementsService.name);

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(Tier.name) private readonly tierModel: Model<Tier>,
  ) {}

  async run(): Promise<{ tiersReconciled: number; plansReconciled: number }> {
    let tiersReconciled = 0;
    let plansReconciled = 0;

    // ERP-only guard, reused on every plan query. Connect plans are out of
    // scope — matches how SubscriptionsService distinguishes ERP from Connect.
    const erpScope = { product: { $ne: 'connect' } } as const;

    for (const key of CANONICAL_ERP_TIER_KEYS) {
      // Canonical caps + prices for this tier, from the shared single source of
      // truth (same constants the seed imports — they cannot drift apart).
      const caps = CANONICAL_ERP_TIER_CAPS[key];
      const prices = CANONICAL_ERP_PLAN_PRICES[key];

      // ── 1. Reconcile the TIER doc (only if it exists — never created) ────
      // updateOne with the same values is a no-op (modifiedCount:0), so the
      // "only if exists" is handled by the empty match writing nothing.
      const tierRes = await this.tierModel
        .updateOne(
          { key },
          {
            $set: {
              'defaultEntitlements.maxMembersPerWorkspace': caps.maxMembersPerWorkspace,
              'defaultEntitlements.maxWorkspaces': caps.maxWorkspaces,
              'defaultEntitlements.maxTotalMembers': caps.maxTotalMembers,
            },
          },
        )
        .exec();
      if ((tierRes?.modifiedCount ?? 0) > 0) {
        tiersReconciled++;
        this.logger.log(
          `Tier '${key}' entitlements reconciled — maxMembersPerWorkspace=${caps.maxMembersPerWorkspace}, maxWorkspaces=${caps.maxWorkspaces}, maxTotalMembers=${caps.maxTotalMembers}.`,
        );
      }

      // ── 2. Reconcile EVERY ERP plan on this tier ─────────────────────────
      // There should be one canonical plan per tier, but if a DB carries
      // multiple ERP plans sharing a tier they should all carry the canonical
      // cap, so we update them all.
      const plans = await this.planModel.find({ ...erpScope, tier: key }).exec();
      for (const plan of plans) {
        const res = await this.planModel
          .updateOne(
            { _id: plan._id },
            {
              $set: {
                'entitlements.maxMembersPerWorkspace': caps.maxMembersPerWorkspace,
                'entitlements.maxWorkspaces': caps.maxWorkspaces,
                'entitlements.maxTotalMembers': caps.maxTotalMembers,
                monthlyPrice: prices.monthlyPrice,
                yearlyPrice: prices.yearlyPrice,
              },
            },
          )
          .exec();
        if ((res?.modifiedCount ?? 0) > 0) {
          plansReconciled++;
          this.logger.log(
            `Plan '${plan.name}' (${String(plan._id)}, tier='${key}') entitlements reconciled — maxMembersPerWorkspace=${caps.maxMembersPerWorkspace}, monthlyPrice=₹${prices.monthlyPrice}, yearlyPrice=₹${prices.yearlyPrice}.`,
          );
        }
      }
    }

    this.logger.log(
      `ERP plan/tier entitlement reconcile complete: tiers changed=${tiersReconciled}, plans changed=${plansReconciled}.`,
    );

    return { tiersReconciled, plansReconciled };
  }
}
