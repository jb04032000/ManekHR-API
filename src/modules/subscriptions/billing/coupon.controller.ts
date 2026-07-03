import { Body, Controller, NotFoundException, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CouponService } from './services/coupon.service';
import { PricingService } from './services/pricing.service';
import { Plan } from '../schemas/plan.schema';
import { ValidateCouponDto } from './dto/coupon.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve coupon preview (D1e). Customer-facing — returns the
 * discount breakdown + post-discount PriceQuote so the UI can display
 * "you saved ₹X" before the user clicks pay. No state mutated.
 *
 * Throttler: same `billing-create` budget as checkout — typing into a
 * coupon field triggers validation per keystroke if the FE debounces
 * poorly, and we'd rather cap there than at the gateway.
 */
@LegacyUnclassified()
@Controller('subscriptions/coupons')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class CouponController {
  constructor(
    private readonly couponService: CouponService,
    private readonly pricing: PricingService,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
  ) {}

  @Post('validate')
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  async validate(@Req() req: any, @Body() dto: ValidateCouponDto) {
    const plan = await this.planModel.findById(dto.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');

    // Compute base price (no discount) so we know what discount math
    // operates on.
    const baseQuote = this.pricing.computeQuote(plan, dto.billingCycle);

    const resolution = await this.couponService.resolveCodes({
      codes: dto.codes,
      userId: req.user.sub,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      basePricePaise: baseQuote.basePricePaise,
    });

    const finalQuote = this.pricing.computeQuote(plan, dto.billingCycle, {
      discountOnBasePaise: resolution.discountOnBasePaise,
      finalTotalOverridePaise: resolution.finalTotalOverridePaise,
      appliedCouponCode: resolution.resolved.map((r) => r.code).join(','),
      appliedCouponId: resolution.resolved[0]?.couponId,
    });

    return {
      resolved: resolution.resolved,
      totalDiscountPaise: resolution.totalDiscountPaise,
      warnings: resolution.warnings,
      baseQuote,
      finalQuote,
    };
  }

  /**
   * Auto-apply preview — UI passes `?promo=<key>` from the marketing
   * URL OR omits it for a generic scan. Returns the best matching
   * auto-apply coupon's effect on this checkout, if any.
   */
  @Post('auto-apply')
  @Throttle({ 'billing-create': { limit: 5, ttl: 60_000 } })
  async autoApply(
    @Req() req: any,
    @Body() dto: { planId: string; billingCycle: 'monthly' | 'yearly' },
    @Query('promo') campaignKey?: string,
  ) {
    const plan = await this.planModel.findById(dto.planId).exec();
    if (!plan) throw new NotFoundException('Plan not found');

    const baseQuote = this.pricing.computeQuote(plan, dto.billingCycle);

    const resolution = await this.couponService.resolveAutoApply({
      userId: req.user.sub,
      planId: dto.planId,
      billingCycle: dto.billingCycle,
      basePricePaise: baseQuote.basePricePaise,
      campaignKey,
    });

    if (!resolution.resolved.length) {
      return {
        resolved: [],
        totalDiscountPaise: 0,
        warnings: [],
        baseQuote,
        finalQuote: baseQuote,
      };
    }

    const finalQuote = this.pricing.computeQuote(plan, dto.billingCycle, {
      discountOnBasePaise: resolution.discountOnBasePaise,
      finalTotalOverridePaise: resolution.finalTotalOverridePaise,
      appliedCouponCode: resolution.resolved.map((r) => r.code).join(','),
      appliedCouponId: resolution.resolved[0]?.couponId,
    });

    return {
      resolved: resolution.resolved,
      totalDiscountPaise: resolution.totalDiscountPaise,
      warnings: resolution.warnings,
      baseQuote,
      finalQuote,
    };
  }
}
