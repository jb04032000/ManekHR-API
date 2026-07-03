import { BadRequestException, Injectable } from '@nestjs/common';
import { Plan } from '../../schemas/plan.schema';
import { Subscription } from '../../schemas/subscription.schema';
import { BillingCycle, PlanChangeQuote } from '../billing.types';
import { BillingPolicyService } from './billing-policy.service';
import { PricingService } from './pricing.service';

/** Milliseconds in one calendar day. */
const DAY_MS = 86_400_000;

interface ComputePlanChangeQuoteArgs {
  /** The customer's current active subscription. */
  subscription: Subscription;
  /** The plan the subscription is currently on. */
  currentPlan: Plan;
  /** The plan the customer wants to move to. */
  targetPlan: Plan;
  /** Billing cycle for the target plan. Lifetime is rejected. */
  targetBillingCycle: BillingCycle;
  /** Clock injection point — defaults to `new Date()`. */
  now?: Date;
  /** Optional pre-resolved coupon discount (paise) applied to the target plan's base. */
  targetDiscountOnBasePaise?: number;
  /** Optional coupon code stamped onto the returned quote. */
  appliedCouponCode?: string;
}

/**
 * Proration engine for plan upgrades / downgrades (Task 3).
 *
 * Turns `(current subscription, current plan, target plan, target cycle)`
 * into a `PlanChangeQuote` — the money math for moving between plans.
 * It is a PURE service: no DB reads/writes, no mutation of its inputs.
 * `PricingService` (also pure) supplies the GST-correct taxable base for
 * each plan/cycle; `BillingPolicyService` supplies the admin-configured
 * proration policy (`policy.proration`).
 *
 * Money model — all integer paise. The `unusedCreditPaise` and
 * `targetChargePaise` quote fields are on a TAXABLE basis (pre-GST);
 * `netTaxablePaise = max(0, targetCharge - unusedCredit)`; GST is then
 * computed on the net; `netPayablePaise = netTaxable + gst`. Proration
 * always works against the taxable base so the credit and the charge
 * are GST-symmetric — GST is applied once, to the net.
 *
 * Direction is decided by yearly-equivalent rank, not list price, so a
 * monthly→yearly move on the same plan reads as an upgrade. The renewal
 * date is preserved on a same-cycle prorated upgrade and reset on a
 * cross-cycle / full-reset change.
 */
@Injectable()
export class ProrationService {
  constructor(
    private readonly pricing: PricingService,
    private readonly billingPolicy: BillingPolicyService,
  ) {}

  /**
   * Computes the price of moving `subscription` from `currentPlan` to
   * `targetPlan` on `targetBillingCycle`. See class doc for the money
   * model. Does no DB work and never mutates `args`.
   */
  async computePlanChangeQuote(args: ComputePlanChangeQuoteArgs): Promise<PlanChangeQuote> {
    const {
      subscription,
      currentPlan,
      targetPlan,
      targetBillingCycle,
      targetDiscountOnBasePaise,
      appliedCouponCode,
    } = args;

    if (targetBillingCycle === 'lifetime') {
      throw new BadRequestException('Lifetime is not a valid target cycle for a plan change');
    }

    const now = args.now ?? new Date();
    const currentBillingCycle = subscription.billingCycle as BillingCycle;

    // ── Direction classification (yearly-equivalent rank) ────────────────
    const direction = this.classifyDirection(
      currentPlan,
      targetPlan,
      currentBillingCycle,
      targetBillingCycle,
    );

    // ── Pricing inputs — taxable base for each plan/cycle ────────────────
    // Current plan is priced on the cycle the subscription is actually on.
    // Lifetime current cycles cannot be re-quoted by PricingService, so the
    // current taxable base falls back to 0 — a lifetime subscriber has no
    // time-bounded value to credit.
    const currentTaxableBase =
      currentBillingCycle === 'lifetime'
        ? 0
        : this.pricing.computeQuote(currentPlan, currentBillingCycle).taxableBasePaise;

    const targetQuote = this.pricing.computeQuote(targetPlan, targetBillingCycle, {
      discountOnBasePaise: targetDiscountOnBasePaise,
    });
    const targetTaxableBase = targetQuote.taxableBasePaise;
    const gstRatePercent = targetQuote.gstRatePercent;

    // ── Period day math ──────────────────────────────────────────────────
    const periodStart = subscription.currentPeriodStart;
    const periodEnd = subscription.currentPeriodEnd;
    const hasLivePeriod =
      periodStart instanceof Date &&
      periodEnd instanceof Date &&
      periodEnd.getTime() > now.getTime();

    const policy = await this.billingPolicy.getPolicy();
    const proration = policy.proration;
    const upgradeMode = proration.upgradeMode;
    const downgradeMode = proration.downgradeMode;
    const creditUnused = proration.creditUnusedOnUpgrade;
    const minProratedChargePaise = proration.minProratedChargePaise ?? 0;

    // No live period to prorate → treat the change as a fresh purchase:
    // full target charge, no credit, applies immediately, fresh renewal.
    if (!hasLivePeriod) {
      const targetChargeTaxable = targetTaxableBase;
      const netTaxable = targetChargeTaxable;
      const gst = this.roundGst(netTaxable, gstRatePercent);
      return this.buildQuote({
        direction,
        currentPlan,
        targetPlan,
        currentBillingCycle,
        targetBillingCycle,
        totalDays: 1,
        remainingDays: 0,
        unusedCreditTaxable: 0,
        targetChargeTaxable,
        netTaxable,
        gst,
        gstRatePercent,
        netPayable: netTaxable + gst,
        appliesAt: 'immediate',
        effectiveDate: now,
        renewalDate: this.addCycle(now, targetBillingCycle),
        upgradeMode,
        appliedCouponCode,
      });
    }

    // `hasLivePeriod` guarantees both dates are real Date objects.
    const periodStartMs = periodStart.getTime();
    const periodEndMs = periodEnd.getTime();
    const nowMs = now.getTime();

    const totalDays = Math.max(1, Math.round((periodEndMs - periodStartMs) / DAY_MS));
    const remainingDays = this.clamp(Math.round((periodEndMs - nowMs) / DAY_MS), 0, totalDays);

    // ── Compute by direction ─────────────────────────────────────────────
    if (direction === 'upgrade') {
      if (upgradeMode === 'full_reset') {
        // Charge the full target cycle now; restart the billing cycle.
        const targetChargeTaxable = targetTaxableBase;
        const netTaxable = targetChargeTaxable;
        const gst = this.roundGst(netTaxable, gstRatePercent);
        return this.buildQuote({
          direction,
          currentPlan,
          targetPlan,
          currentBillingCycle,
          targetBillingCycle,
          totalDays,
          remainingDays,
          unusedCreditTaxable: 0,
          targetChargeTaxable,
          netTaxable,
          gst,
          gstRatePercent,
          netPayable: netTaxable + gst,
          appliesAt: 'immediate',
          effectiveDate: now,
          renewalDate: this.addCycle(now, targetBillingCycle),
          upgradeMode,
          appliedCouponCode,
        });
      }

      // upgradeMode === 'prorated'
      const sameCycle = targetBillingCycle === currentBillingCycle;
      const unusedCreditTaxable = creditUnused
        ? this.prorate(currentTaxableBase, totalDays, remainingDays)
        : 0;

      let targetChargeTaxable: number;
      let renewalDate: Date;
      if (sameCycle) {
        // Charge only the remaining-days slice of the new plan; keep the
        // current renewal date untouched.
        targetChargeTaxable = this.prorate(targetTaxableBase, totalDays, remainingDays);
        renewalDate = periodEnd;
      } else {
        // Cross-cycle (monthly↔yearly): the customer buys a full new cycle;
        // the renewal date resets to one target-cycle from now.
        targetChargeTaxable = targetTaxableBase;
        renewalDate = this.addCycle(now, targetBillingCycle);
      }

      let netTaxable = Math.max(0, targetChargeTaxable - unusedCreditTaxable);
      let gst = this.roundGst(netTaxable, gstRatePercent);
      let netPayable = netTaxable + gst;

      // Floor: a tiny computed net collapses to a free upgrade (no
      // ₹0.01 Razorpay orders). Zero the taxable + GST too so the quote
      // stays internally consistent.
      if (netPayable < minProratedChargePaise) {
        netTaxable = 0;
        gst = 0;
        netPayable = 0;
      }

      return this.buildQuote({
        direction,
        currentPlan,
        targetPlan,
        currentBillingCycle,
        targetBillingCycle,
        totalDays,
        remainingDays,
        unusedCreditTaxable,
        targetChargeTaxable,
        netTaxable,
        gst,
        gstRatePercent,
        netPayable,
        appliesAt: 'immediate',
        effectiveDate: now,
        renewalDate,
        upgradeMode,
        appliedCouponCode,
      });
    }

    if (direction === 'downgrade') {
      if (downgradeMode === 'immediate') {
        // Apply now, no refund, no credit. `targetChargeTaxable` is the
        // full target cycle (informational — the next renewal amount).
        return this.buildQuote({
          direction,
          currentPlan,
          targetPlan,
          currentBillingCycle,
          targetBillingCycle,
          totalDays,
          remainingDays,
          unusedCreditTaxable: 0,
          targetChargeTaxable: targetTaxableBase,
          netTaxable: 0,
          gst: 0,
          gstRatePercent,
          netPayable: 0,
          appliesAt: 'immediate',
          effectiveDate: now,
          renewalDate: this.addCycle(now, targetBillingCycle),
          upgradeMode,
          appliedCouponCode,
        });
      }

      // downgradeMode === 'cycle_end' — deferred. Nothing payable now; the
      // change takes effect at period end and the customer pays the target
      // plan's full price at the following renewal.
      return this.buildQuote({
        direction,
        currentPlan,
        targetPlan,
        currentBillingCycle,
        targetBillingCycle,
        totalDays,
        remainingDays,
        unusedCreditTaxable: 0,
        targetChargeTaxable: targetTaxableBase,
        netTaxable: 0,
        gst: 0,
        gstRatePercent,
        netPayable: 0,
        appliesAt: 'cycle_end',
        effectiveDate: periodEnd,
        renewalDate: this.addCycle(periodEnd, targetBillingCycle),
        upgradeMode,
        appliedCouponCode,
      });
    }

    // direction === 'lateral' — same rank, different plan. No charge, no
    // credit; apply now, keep the existing renewal date.
    return this.buildQuote({
      direction,
      currentPlan,
      targetPlan,
      currentBillingCycle,
      targetBillingCycle,
      totalDays,
      remainingDays,
      unusedCreditTaxable: 0,
      targetChargeTaxable: targetTaxableBase,
      netTaxable: 0,
      gst: 0,
      gstRatePercent,
      netPayable: 0,
      appliesAt: 'immediate',
      effectiveDate: now,
      renewalDate: periodEnd,
      upgradeMode,
      appliedCouponCode,
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Classifies the change as upgrade / downgrade / lateral.
   *
   * Plans are ranked by yearly-equivalent price so a cheaper-per-month
   * but only-yearly plan still compares sanely:
   *   `rank = yearlyPrice > 0 ? yearlyPrice : monthlyPrice * 12`.
   * On a tie, a same-plan cycle change is read by cycle (monthly→yearly =
   * upgrade, yearly→monthly = downgrade); a different-plan tie is lateral.
   */
  private classifyDirection(
    currentPlan: Plan,
    targetPlan: Plan,
    currentBillingCycle: BillingCycle,
    targetBillingCycle: BillingCycle,
  ): PlanChangeQuote['direction'] {
    const currentRank = this.yearlyEquivalentRank(currentPlan);
    const targetRank = this.yearlyEquivalentRank(targetPlan);

    if (targetRank > currentRank) return 'upgrade';
    if (targetRank < currentRank) return 'downgrade';

    // Equal rank — disambiguate by same-plan cycle change.
    const samePlan = String(currentPlan._id) === String(targetPlan._id);
    if (samePlan) {
      if (currentBillingCycle === 'monthly' && targetBillingCycle === 'yearly') {
        return 'upgrade';
      }
      if (currentBillingCycle === 'yearly' && targetBillingCycle === 'monthly') {
        return 'downgrade';
      }
    }
    return 'lateral';
  }

  /** Yearly-equivalent price used to rank a plan. */
  private yearlyEquivalentRank(plan: Plan): number {
    const yearly = typeof plan.yearlyPrice === 'number' ? plan.yearlyPrice : 0;
    if (yearly > 0) return yearly;
    const monthly = typeof plan.monthlyPrice === 'number' ? plan.monthlyPrice : 0;
    return monthly * 12;
  }

  /**
   * Prorates `basePaise` to `remainingDays / totalDays`, rounded to the
   * nearest integer paise. `totalDays` is always >= 1 by construction.
   */
  private prorate(basePaise: number, totalDays: number, remainingDays: number): number {
    return Math.round((basePaise / totalDays) * remainingDays);
  }

  /** GST on a taxable amount, rounded to the nearest integer paise. */
  private roundGst(taxablePaise: number, gstRatePercent: number): number {
    return Math.round((taxablePaise * gstRatePercent) / 100);
  }

  /** Clamps `value` into the inclusive `[min, max]` range. */
  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Returns a NEW Date `from + one billing cycle`. Monthly adds one
   * calendar month, yearly adds one calendar year (calendar-correct —
   * handles month-length + leap-year drift via the Date API). `from` is
   * never mutated.
   */
  private addCycle(from: Date, cycle: BillingCycle): Date {
    const next = new Date(from.getTime());
    if (cycle === 'yearly') {
      next.setFullYear(next.getFullYear() + 1);
    } else {
      // 'monthly' (lifetime is rejected before this is reached).
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }

  /** Assembles the final `PlanChangeQuote` from computed integer-paise parts. */
  private buildQuote(parts: {
    direction: PlanChangeQuote['direction'];
    currentPlan: Plan;
    targetPlan: Plan;
    currentBillingCycle: BillingCycle;
    targetBillingCycle: BillingCycle;
    totalDays: number;
    remainingDays: number;
    unusedCreditTaxable: number;
    targetChargeTaxable: number;
    netTaxable: number;
    gst: number;
    gstRatePercent: number;
    netPayable: number;
    appliesAt: PlanChangeQuote['appliesAt'];
    effectiveDate: Date;
    renewalDate: Date;
    upgradeMode: string;
    appliedCouponCode?: string;
  }): PlanChangeQuote {
    return {
      direction: parts.direction,
      currentPlanId: String(parts.currentPlan._id),
      currentPlanName: parts.currentPlan.name,
      targetPlanId: String(parts.targetPlan._id),
      targetPlanName: parts.targetPlan.name,
      currentBillingCycle: parts.currentBillingCycle,
      targetBillingCycle: parts.targetBillingCycle,
      totalDays: parts.totalDays,
      remainingDays: parts.remainingDays,
      unusedCreditPaise: parts.unusedCreditTaxable,
      targetChargePaise: parts.targetChargeTaxable,
      netTaxablePaise: parts.netTaxable,
      gstPaise: parts.gst,
      gstRatePercent: parts.gstRatePercent,
      netPayablePaise: parts.netPayable,
      appliesAt: parts.appliesAt,
      effectiveDate: parts.effectiveDate.toISOString(),
      renewalDate: parts.renewalDate.toISOString(),
      upgradeMode: parts.upgradeMode,
      appliedCouponCode: parts.appliedCouponCode,
    };
  }
}
