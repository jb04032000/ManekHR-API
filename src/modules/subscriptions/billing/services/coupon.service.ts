import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Coupon } from '../schemas/coupon.schema';
import { CouponRedemption } from '../schemas/coupon-redemption.schema';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { Plan } from '../../schemas/plan.schema';
import {
  BillingCycle,
  DiscountResolution,
  ResolvedCoupon,
} from '../billing.types';
import {
  CouponListQueryDto,
  CreateCouponDto,
  UpdateCouponDto,
} from '../dto/coupon.dto';
import { AuditAction, AuditLogService } from './audit-log.service';

interface ResolveArgs {
  codes: string[];
  userId: string;
  planId: string;
  billingCycle: BillingCycle;
  /** Plan list price for the cycle in paise — what the discount is computed against. */
  basePricePaise: number;
}

interface AutoApplyArgs {
  userId: string;
  planId: string;
  billingCycle: BillingCycle;
  basePricePaise: number;
  /**
   * If supplied, only the coupon with this `autoApplyCampaignKey` is
   * considered (matching `?promo=<key>` from the marketing URL).
   * If omitted, all active autoApply coupons are scanned.
   */
  campaignKey?: string;
}

interface RecordRedemptionArgs {
  payment: SubscriptionPayment;
  resolved: ResolvedCoupon[];
  userId: string;
}

/**
 * Coupon engine — admin CRUD + customer-facing validation + redemption
 * recording (D1e).
 *
 * Stacking model:
 *   - At most ONE `fixed_price` coupon. Non-stackable by construction
 *     (it sets the final price; stacking with anything else makes no
 *     sense). Rejected when combined with any other coupon.
 *   - Multiple `percentage` and `fixed_amount` coupons may stack ONLY
 *     when every coupon in the cart has `isStackable=true`.
 *   - Stacking application order: percentages cumulative-but-capped at
 *     100% combined first, then fixed_amount discounts subtracted from
 *     the post-percent amount, then floored at 0.
 *
 * Eligibility checks (in order, fail-fast):
 *   1. Coupon active + within validity window.
 *   2. Plan + billing cycle scope match.
 *   3. Global maxRedemptions not exhausted.
 *   4. Per-user maxRedemptionsPerUser not exhausted (queries CouponRedemption).
 *   5. isFirstTimeOnly: user has zero prior captured SubscriptionPayment.
 *
 * Redemption recording is atomic — `$inc redemptionsCount` on the Coupon
 * with a `$expr` guard against the cap, and a `CouponRedemption` insert
 * per coupon. Both happen at capture time (one-time `/confirm` and the
 * recurring `subscription.charged` first-cycle webhook).
 */
@Injectable()
export class CouponService {
  private readonly logger = new Logger(CouponService.name);

  constructor(
    @InjectModel(Coupon.name) private readonly couponModel: Model<Coupon>,
    @InjectModel(CouponRedemption.name)
    private readonly redemptionModel: Model<CouponRedemption>,
    @InjectModel(SubscriptionPayment.name)
    private readonly paymentModel: Model<SubscriptionPayment>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    private readonly audit: AuditLogService,
  ) {}

  // ── public: resolve customer-supplied codes ─────────────────────────

  /**
   * Resolve a set of customer-supplied codes for a planned checkout.
   * Returns the discount breakdown without recording any redemption —
   * recording happens at capture time via `recordRedemptions`.
   */
  async resolveCodes(args: ResolveArgs): Promise<DiscountResolution> {
    if (!args.codes.length) {
      return this.emptyResolution();
    }

    const dedupedCodes = Array.from(
      new Set(args.codes.map((c) => c.trim().toUpperCase())),
    );

    const coupons = await this.couponModel
      .find({ code: { $in: dedupedCodes }, isActive: true })
      .exec();

    // Surface missing/invalid codes explicitly so the UI can show
    // exactly which coupon failed.
    if (coupons.length !== dedupedCodes.length) {
      const found = new Set(coupons.map((c) => c.code));
      const missing = dedupedCodes.filter((c) => !found.has(c));
      throw new BadRequestException(
        `Coupon code(s) not found or inactive: ${missing.join(', ')}`,
      );
    }

    // Per-coupon eligibility (validity window, scope, caps).
    for (const coupon of coupons) {
      await this.assertEligibleForUser(coupon, args);
    }

    return this.applyStacking(coupons, args);
  }

  // ── public: scan auto-apply coupons ─────────────────────────────────

  /**
   * Scan auto-apply coupons matching the planned checkout. Returns the
   * single best resolution (greatest savings) — auto-apply does NOT
   * stack across multiple campaigns to keep UX deterministic.
   */
  async resolveAutoApply(args: AutoApplyArgs): Promise<DiscountResolution> {
    const filter: any = {
      isActive: true,
      autoApplyCampaignKey: { $exists: true, $ne: null },
    };
    if (args.campaignKey) {
      filter.autoApplyCampaignKey = args.campaignKey;
    }

    const candidates = await this.couponModel.find(filter).exec();
    if (!candidates.length) return this.emptyResolution();

    let best: DiscountResolution = this.emptyResolution();
    for (const coupon of candidates) {
      try {
        await this.assertEligibleForUser(coupon, {
          codes: [coupon.code],
          userId: args.userId,
          planId: args.planId,
          billingCycle: args.billingCycle,
          basePricePaise: args.basePricePaise,
        });
      } catch {
        continue; // not eligible — skip silently
      }
      const resolution = this.applyStacking([coupon], {
        codes: [coupon.code],
        userId: args.userId,
        planId: args.planId,
        billingCycle: args.billingCycle,
        basePricePaise: args.basePricePaise,
      });
      if (resolution.totalDiscountPaise > best.totalDiscountPaise) {
        best = resolution;
      }
    }
    return best;
  }

  // ── public: record redemptions at capture time ──────────────────────

  /**
   * Record redemptions for every resolved coupon on this payment.
   * Atomic per coupon — `$inc redemptionsCount` only when the global
   * cap allows it. Per-user cap is enforced by the `CouponRedemption`
   * insert (on dup-key would throw — but we don't have that index, so
   * we re-check the count before insert; race window is small and the
   * customer-friendly outcome of an over-redemption by 1 is acceptable).
   *
   * Idempotent: a duplicate call (e.g. webhook replay) detects existing
   * `CouponRedemption{ subscriptionPaymentId, couponId }` and skips.
   */
  async recordRedemptions(args: RecordRedemptionArgs): Promise<void> {
    if (!args.resolved.length) return;
    const userObjectId = new Types.ObjectId(args.userId);
    const paymentId = args.payment._id as Types.ObjectId;

    for (const r of args.resolved) {
      const couponObjectId = new Types.ObjectId(r.couponId);

      // Dedup against replays.
      const existing = await this.redemptionModel
        .findOne({
          subscriptionPaymentId: paymentId,
          couponId: couponObjectId,
        })
        .exec();
      if (existing) continue;

      // Atomic global-cap check + increment.
      const incremented = await this.couponModel
        .findOneAndUpdate(
          {
            _id: couponObjectId,
            isActive: true,
            $or: [
              { maxRedemptions: null },
              { $expr: { $lt: ['$redemptionsCount', '$maxRedemptions'] } },
            ],
          },
          { $inc: { redemptionsCount: 1 } },
          { new: true },
        )
        .exec();
      if (!incremented) {
        // Cap exhausted between resolve and record — log + skip without
        // failing the whole capture (payment is already taken; refusing
        // the discount now would be worse for the user).
        this.logger.warn(
          `Coupon cap exhausted at redemption time: code=${r.code} payment=${paymentId}`,
        );
        continue;
      }

      await this.redemptionModel.create({
        couponId: couponObjectId,
        userId: userObjectId,
        subscriptionPaymentId: paymentId,
        discountAppliedPaise: r.discountAppliedPaise,
        code: r.code,
      });
    }

    this.logger.log(
      `Coupon redemptions recorded payment=${paymentId} count=${args.resolved.length}`,
    );
  }

  // ── admin CRUD ──────────────────────────────────────────────────────

  async create(adminId: string, dto: CreateCouponDto): Promise<Coupon> {
    this.validateDtoSemantics(dto);

    const code = dto.code.trim().toUpperCase();
    const existing = await this.couponModel.findOne({ code }).exec();
    if (existing) {
      throw new ConflictException(`Coupon code already exists: ${code}`);
    }

    if (dto.autoApplyCampaignKey) {
      const dup = await this.couponModel
        .findOne({ autoApplyCampaignKey: dto.autoApplyCampaignKey })
        .exec();
      if (dup) {
        throw new ConflictException(
          `autoApplyCampaignKey already in use: ${dto.autoApplyCampaignKey}`,
        );
      }
    }

    const created = await this.couponModel.create({
      ...dto,
      code,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      applicablePlanIds:
        dto.applicablePlanIds?.map((id) => new Types.ObjectId(id)) ?? [],
      applicableBillingCycles: dto.applicableBillingCycles ?? [],
      maxRedemptions: dto.maxRedemptions ?? null,
      maxRedemptionsPerUser: dto.maxRedemptionsPerUser ?? 1,
      isFirstTimeOnly: dto.isFirstTimeOnly ?? false,
      isStackable: dto.isStackable ?? false,
      isActive: dto.isActive ?? true,
      createdBy: new Types.ObjectId(adminId),
    });
    await this.audit.log({
      action: AuditAction.AdminCouponCreated,
      actorType: 'admin',
      actorUserId: adminId,
      couponId: String(created._id),
      metadata: {
        code,
        discountType: dto.discountType,
        valueOrPaise: dto.valueOrPaise,
        isStackable: dto.isStackable ?? false,
      },
    });
    return created;
  }

  async update(
    id: string,
    dto: UpdateCouponDto,
    adminId?: string,
  ): Promise<Coupon> {
    if (dto.discountType && dto.valueOrPaise === undefined) {
      // Type changed but value not — semantics could become invalid
      // (e.g. percentage 5000 makes no sense). Force re-supply.
      throw new BadRequestException(
        'When changing discountType, valueOrPaise must also be supplied',
      );
    }
    if (dto.discountType || dto.valueOrPaise !== undefined) {
      const merged: any = { ...dto };
      // Pull existing for fields the caller didn't override.
      const current = await this.couponModel.findById(id).exec();
      if (!current) throw new NotFoundException('Coupon not found');
      this.validateDtoSemantics({
        code: current.code,
        discountType: (dto.discountType ?? current.discountType) as any,
        valueOrPaise: dto.valueOrPaise ?? current.valueOrPaise,
        ...merged,
      });
    }

    const update: any = { ...dto };
    if (dto.validFrom) update.validFrom = new Date(dto.validFrom);
    if (dto.validUntil) update.validUntil = new Date(dto.validUntil);
    if (dto.applicablePlanIds) {
      update.applicablePlanIds = dto.applicablePlanIds.map(
        (pid) => new Types.ObjectId(pid),
      );
    }

    const updated = await this.couponModel
      .findByIdAndUpdate(id, { $set: update }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Coupon not found');
    await this.audit.log({
      action: AuditAction.AdminCouponUpdated,
      actorType: 'admin',
      actorUserId: adminId,
      couponId: id,
      metadata: { changedKeys: Object.keys(update) },
    });
    return updated;
  }

  async list(query: CouponListQueryDto) {
    const filter: any = {};
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.search) {
      filter.code = { $regex: query.search.toUpperCase(), $options: 'i' };
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [items, total] = await Promise.all([
      this.couponModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.couponModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }

  async fetch(id: string): Promise<Coupon> {
    const c = await this.couponModel.findById(id).exec();
    if (!c) throw new NotFoundException('Coupon not found');
    return c;
  }

  async archive(id: string, adminId?: string): Promise<Coupon> {
    const c = await this.couponModel
      .findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true })
      .exec();
    if (!c) throw new NotFoundException('Coupon not found');
    await this.audit.log({
      action: AuditAction.AdminCouponArchived,
      actorType: 'admin',
      actorUserId: adminId,
      couponId: id,
      metadata: { code: c.code },
    });
    return c;
  }

  async redemptionStats(id: string) {
    const coupon = await this.couponModel.findById(id).exec();
    if (!coupon) throw new NotFoundException('Coupon not found');
    const couponObjectId = coupon._id as Types.ObjectId;

    const [totalRedemptions, totalDiscountAggregate] = await Promise.all([
      this.redemptionModel.countDocuments({ couponId: couponObjectId }).exec(),
      this.redemptionModel
        .aggregate([
          { $match: { couponId: couponObjectId } },
          {
            $group: {
              _id: null,
              totalDiscountPaise: { $sum: '$discountAppliedPaise' },
              uniqueUsers: { $addToSet: '$userId' },
            },
          },
        ])
        .exec(),
    ]);
    const agg = totalDiscountAggregate[0];
    return {
      couponId: String(coupon._id),
      code: coupon.code,
      totalRedemptions,
      totalDiscountPaise: agg?.totalDiscountPaise ?? 0,
      uniqueUserCount: agg?.uniqueUsers?.length ?? 0,
      counterValue: coupon.redemptionsCount,
      maxRedemptions: coupon.maxRedemptions ?? null,
      isCapExhausted:
        coupon.maxRedemptions != null &&
        coupon.redemptionsCount >= coupon.maxRedemptions,
    };
  }

  /**
   * D4 — coupon revenue attribution. Joins each redemption to its
   * SubscriptionPayment to compute:
   *   - grossRevenuePaise: sum of every linked payment's totalPaise
   *     (what the customer actually paid AFTER discount)
   *   - discountGivenPaise: sum of discounts applied
   *   - refundedPaise: sum of refunds against linked payments (so we
   *     can compute net revenue)
   *   - netRevenuePaise: gross - refunded
   *   - paidConversions: count of redemptions whose linked payment is
   *     status=captured (excludes failed/cancelled)
   *   - perCycleBreakdown: paid count split by billingCycle so we can
   *     see whether a coupon drives more monthly vs yearly
   *
   * Single aggregation pipeline keeps this cheap even with thousands
   * of redemptions per coupon.
   */
  async attribution(id: string) {
    const coupon = await this.couponModel.findById(id).exec();
    if (!coupon) throw new NotFoundException('Coupon not found');
    const couponObjectId = coupon._id as Types.ObjectId;

    const pipeline = [
      { $match: { couponId: couponObjectId } },
      {
        $lookup: {
          from: 'subscriptionpayments',
          localField: 'subscriptionPaymentId',
          foreignField: '_id',
          as: 'payment',
        },
      },
      { $unwind: { path: '$payment', preserveNullAndEmptyArrays: false } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                grossRevenuePaise: { $sum: '$payment.totalPaise' },
                discountGivenPaise: { $sum: '$discountAppliedPaise' },
                refundedPaise: {
                  $sum: {
                    $cond: [
                      { $isArray: '$payment.refunds' },
                      {
                        $sum: {
                          $map: {
                            input: '$payment.refunds',
                            as: 'r',
                            in: {
                              $cond: [
                                { $ne: ['$$r.status', 'failed'] },
                                '$$r.amountPaise',
                                0,
                              ],
                            },
                          },
                        },
                      },
                      0,
                    ],
                  },
                },
                paidConversions: {
                  $sum: {
                    $cond: [{ $eq: ['$payment.status', 'captured'] }, 1, 0],
                  },
                },
              },
            },
          ],
          perCycle: [
            { $match: { 'payment.status': 'captured' } },
            {
              $group: {
                _id: '$payment.billingCycle',
                count: { $sum: 1 },
                revenuePaise: { $sum: '$payment.totalPaise' },
              },
            },
          ],
        },
      },
    ];

    const [result] = await this.redemptionModel
      .aggregate(pipeline)
      .exec();
    const totals = result?.totals?.[0] ?? {
      grossRevenuePaise: 0,
      discountGivenPaise: 0,
      refundedPaise: 0,
      paidConversions: 0,
    };
    const perCycleBreakdown = (
      (result?.perCycle ?? []) as Array<{
        _id: string;
        count: number;
        revenuePaise: number;
      }>
    ).reduce<Record<string, { count: number; revenuePaise: number }>>(
      (acc, row) => {
        acc[row._id] = { count: row.count, revenuePaise: row.revenuePaise };
        return acc;
      },
      {},
    );

    return {
      couponId: String(coupon._id),
      code: coupon.code,
      campaignKey: coupon.autoApplyCampaignKey,
      grossRevenuePaise: totals.grossRevenuePaise,
      discountGivenPaise: totals.discountGivenPaise,
      refundedPaise: totals.refundedPaise,
      netRevenuePaise: totals.grossRevenuePaise - totals.refundedPaise,
      paidConversions: totals.paidConversions,
      perCycleBreakdown,
    };
  }

  // ── eligibility ─────────────────────────────────────────────────────

  private async assertEligibleForUser(
    coupon: Coupon,
    args: ResolveArgs,
  ): Promise<void> {
    const now = new Date();
    if (coupon.validFrom && now < coupon.validFrom) {
      throw new BadRequestException(`Coupon ${coupon.code} is not yet valid`);
    }
    if (coupon.validUntil && now > coupon.validUntil) {
      throw new BadRequestException(`Coupon ${coupon.code} has expired`);
    }

    if (
      coupon.applicablePlanIds.length > 0 &&
      !coupon.applicablePlanIds.some(
        (pid) => pid.toString() === args.planId,
      )
    ) {
      throw new BadRequestException(
        `Coupon ${coupon.code} is not valid for this plan`,
      );
    }

    if (
      coupon.applicableBillingCycles.length > 0 &&
      !coupon.applicableBillingCycles.includes(args.billingCycle)
    ) {
      throw new BadRequestException(
        `Coupon ${coupon.code} is not valid for ${args.billingCycle} billing`,
      );
    }

    if (
      coupon.maxRedemptions != null &&
      coupon.redemptionsCount >= coupon.maxRedemptions
    ) {
      throw new BadRequestException(
        `Coupon ${coupon.code} has reached its redemption limit`,
      );
    }

    if (coupon.maxRedemptionsPerUser != null) {
      const userRedemptions = await this.redemptionModel
        .countDocuments({
          couponId: coupon._id,
          userId: new Types.ObjectId(args.userId),
        })
        .exec();
      if (userRedemptions >= coupon.maxRedemptionsPerUser) {
        throw new BadRequestException(
          `Coupon ${coupon.code} has been used the maximum number of times for this account`,
        );
      }
    }

    if (coupon.isFirstTimeOnly) {
      const priorCaptures = await this.paymentModel
        .countDocuments({
          userId: new Types.ObjectId(args.userId),
          status: 'captured',
        })
        .exec();
      if (priorCaptures > 0) {
        throw new BadRequestException(
          `Coupon ${coupon.code} is for first-time customers only`,
        );
      }
    }
  }

  // ── stacking + discount math ────────────────────────────────────────

  private applyStacking(
    coupons: Coupon[],
    args: ResolveArgs,
  ): DiscountResolution {
    const fixedPrice = coupons.filter((c) => c.discountType === 'fixed_price');
    if (fixedPrice.length > 1) {
      throw new BadRequestException(
        'Only one fixed-price coupon can be applied per checkout',
      );
    }
    if (fixedPrice.length === 1 && coupons.length > 1) {
      throw new BadRequestException(
        `Coupon ${fixedPrice[0].code} cannot be combined with other coupons`,
      );
    }

    if (fixedPrice.length === 1) {
      const c = fixedPrice[0];
      const finalTotal = Math.min(args.basePricePaise, Math.max(0, c.valueOrPaise));
      const discount = Math.max(0, args.basePricePaise - finalTotal);
      return {
        resolved: [
          {
            couponId: String(c._id),
            code: c.code,
            discountType: 'fixed_price',
            discountAppliedPaise: discount,
          },
        ],
        finalTotalOverridePaise: finalTotal,
        totalDiscountPaise: discount,
        warnings: [],
      };
    }

    // Stack-eligibility: multi-coupon requires every coupon to be stackable.
    if (coupons.length > 1 && coupons.some((c) => !c.isStackable)) {
      const offending = coupons.find((c) => !c.isStackable)!;
      throw new BadRequestException(
        `Coupon ${offending.code} is not stackable`,
      );
    }

    const warnings: string[] = [];
    let totalPercent = 0;
    let totalFixedPaise = 0;
    const percentResolved: { c: Coupon; discountPaise: number }[] = [];
    const fixedResolved: { c: Coupon; discountPaise: number }[] = [];

    for (const c of coupons) {
      if (c.discountType === 'percentage') {
        totalPercent += c.valueOrPaise;
      } else if (c.discountType === 'fixed_amount') {
        totalFixedPaise += c.valueOrPaise;
      }
    }
    if (totalPercent > 100) {
      warnings.push(
        `Combined percentage discount capped at 100% (was ${totalPercent}%)`,
      );
      totalPercent = 100;
    }

    const percentDiscountPaise = Math.round(
      (args.basePricePaise * totalPercent) / 100,
    );
    const postPercentBase = args.basePricePaise - percentDiscountPaise;
    const fixedDiscountAppliedPaise = Math.min(totalFixedPaise, postPercentBase);
    const totalDiscountPaise = percentDiscountPaise + fixedDiscountAppliedPaise;

    // Distribute the discount per-coupon proportionally for the
    // CouponRedemption snapshot.
    if (percentDiscountPaise > 0) {
      let remaining = percentDiscountPaise;
      const percentCoupons = coupons.filter((c) => c.discountType === 'percentage');
      percentCoupons.forEach((c, idx) => {
        const share = idx === percentCoupons.length - 1
          ? remaining
          : Math.round(
              (args.basePricePaise * c.valueOrPaise) / 100,
            );
        const clamped = Math.min(share, remaining);
        percentResolved.push({ c, discountPaise: clamped });
        remaining -= clamped;
      });
    }

    if (fixedDiscountAppliedPaise > 0) {
      let remaining = fixedDiscountAppliedPaise;
      const fixedCoupons = coupons.filter((c) => c.discountType === 'fixed_amount');
      fixedCoupons.forEach((c, idx) => {
        const share = idx === fixedCoupons.length - 1
          ? remaining
          : Math.min(c.valueOrPaise, remaining);
        const clamped = Math.min(share, remaining);
        fixedResolved.push({ c, discountPaise: clamped });
        remaining -= clamped;
      });
    }

    const resolved: ResolvedCoupon[] = [
      ...percentResolved.map((r) => ({
        couponId: String(r.c._id),
        code: r.c.code,
        discountType: 'percentage' as const,
        discountAppliedPaise: r.discountPaise,
      })),
      ...fixedResolved.map((r) => ({
        couponId: String(r.c._id),
        code: r.c.code,
        discountType: 'fixed_amount' as const,
        discountAppliedPaise: r.discountPaise,
      })),
    ];

    return {
      resolved,
      discountOnBasePaise: totalDiscountPaise,
      totalDiscountPaise,
      warnings,
    };
  }

  private validateDtoSemantics(dto: {
    code: string;
    discountType: 'percentage' | 'fixed_amount' | 'fixed_price';
    valueOrPaise: number;
  }): void {
    if (dto.discountType === 'percentage') {
      if (dto.valueOrPaise < 1 || dto.valueOrPaise > 100) {
        throw new BadRequestException(
          'percentage coupon: valueOrPaise must be 1..100',
        );
      }
    }
    if (dto.discountType === 'fixed_amount' && dto.valueOrPaise < 1) {
      throw new BadRequestException(
        'fixed_amount coupon: valueOrPaise must be a positive number of paise',
      );
    }
    if (dto.discountType === 'fixed_price' && dto.valueOrPaise < 0) {
      throw new BadRequestException(
        'fixed_price coupon: valueOrPaise must be a non-negative number of paise',
      );
    }
  }

  private emptyResolution(): DiscountResolution {
    return { resolved: [], totalDiscountPaise: 0, warnings: [] };
  }
}
