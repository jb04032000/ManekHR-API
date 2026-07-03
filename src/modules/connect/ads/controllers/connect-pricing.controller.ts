import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { ConnectPricingConfigService } from '../services/connect-pricing-config.service';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';
import type { ConnectPricingView } from '../schemas/connect-pricing-config.schema';

/**
 * `connect/ads/pricing` -- the public-safe pricing levers the web reads.
 *
 * The boost composer (BoostComposer.tsx) reads min budget + allowed durations +
 * suggested budgets; the wallet panel (WalletPanel.tsx) reads the top-up min +
 * suggested amounts. Every field here is a price the user is already shown, so
 * it is safe for any authed Connect user; no admin scope required. Writes live
 * on AdsAdminController (admin-only). Read is cached in the service, so this is
 * a cheap call on the hot boost/wallet paths.
 */
@LegacyUnclassified()
@Controller('connect/ads/pricing')
@UseGuards(JwtAuthGuard)
export class ConnectPricingController {
  constructor(private readonly pricing: ConnectPricingConfigService) {}

  /** Returns the live pricing levers (min / durations / presets / bids). */
  @Get()
  get(): Promise<ConnectPricingView> {
    return this.pricing.getConfig();
  }
}
