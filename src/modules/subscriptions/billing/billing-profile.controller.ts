import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { User } from '../../users/schemas/user.schema';
import { UpdateBillingProfileDto } from './dto/billing-profile.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve billing profile (D1f). Backs the GST B2B invoice
 * recipient block. Edits AFTER an order is placed do NOT retroactively
 * change historical invoices — `SubscriptionPayment.billingSnapshot`
 * captures the values at order-create time.
 *
 * Throttle: `billing-mutate` (10/60s). Intentionally generous — users
 * may correct typos a few times in a row when reading their GSTIN
 * letter.
 */
@LegacyUnclassified()
@Controller('users/me/billing')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class BillingProfileController {
  constructor(@InjectModel(User.name) private readonly userModel: Model<User>) {}

  @Get()
  async fetch(@Req() req: any) {
    const user = await this.userModel.findById(req.user.sub).select('billingProfile').exec();
    if (!user) throw new NotFoundException('User not found');
    return { billingProfile: user.billingProfile ?? null };
  }

  @Patch()
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  async update(@Req() req: any, @Body() dto: UpdateBillingProfileDto) {
    // GSTIN ↔ stateCode consistency check — the first 2 digits of a
    // valid GSTIN ARE the state code. Surface mismatches instead of
    // silently picking one.
    if (dto.gstin && dto.stateCode) {
      const gstinStateCode = dto.gstin.slice(0, 2);
      if (gstinStateCode !== dto.stateCode) {
        throw new BadRequestException(
          `stateCode (${dto.stateCode}) does not match GSTIN's state code (${gstinStateCode})`,
        );
      }
    }
    // Derive stateCode from GSTIN if not supplied.
    const derivedStateCode = dto.stateCode ?? (dto.gstin ? dto.gstin.slice(0, 2) : undefined);

    const user = await this.userModel.findById(req.user.sub).exec();
    if (!user) throw new NotFoundException('User not found');

    const merged = {
      ...(user.billingProfile ?? {}),
      ...dto,
      ...(derivedStateCode ? { stateCode: derivedStateCode } : {}),
    };
    user.billingProfile = merged;
    await user.save();

    return { billingProfile: user.billingProfile };
  }
}
