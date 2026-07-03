import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { WalletService } from '../services/wallet.service';
import { WalletTopupCheckoutService } from '../services/wallet-topup-checkout.service';
import { CreateWalletTopupOrderDto, ConfirmWalletTopupDto } from '../dto/wallet-topup.dto';
import { LegacyUnclassified } from '../../../../common/decorators/legacy-unclassified.decorator';

/** JWT payload shape populated by `JwtAuthGuard` -- `sub` is the User id. */
interface AuthedRequest {
  user: { sub: string };
}

/**
 * Per-user rate limit for creating a top-up payment order. Each call hits the
 * Razorpay API and persists an AdWalletTopup intent, so it is a spam / abuse
 * vector (order flooding, webhook noise) and is throttled far tighter than the
 * read endpoint. Three legitimate retries a minute is ample for a human adding
 * credits; anything beyond that is abuse.
 */
export const TOPUP_ORDER_RATE_LIMIT = 3;

/**
 * `connect/ads/wallet` -- the caller's ad credit wallet.
 *
 * The wallet owner is always the authenticated Connect User (`req.user.sub`);
 * Connect has no workspace. Topping up follows the real gateway flow: the
 * client creates a Razorpay order (`/topup/order`), opens the checkout sheet,
 * then posts the signed payload back (`/topup/confirm`). The server verifies
 * the signature via the ERP's platform Razorpay service BEFORE crediting --
 * there is intentionally no direct-credit endpoint (a user must never be able
 * to credit their own wallet without a confirmed payment). System / admin
 * credits go through `WalletService.topup` from server-side code only.
 */
// CN-ADS-5 (Bucket 4): ThrottlerGuard in the class chain so the existing
// @Throttle tiers on the top-up endpoints actually enforce (the global guard
// list has no ThrottlerGuard).
@LegacyUnclassified()
@Controller('connect/ads/wallet')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly topupCheckout: WalletTopupCheckoutService,
  ) {}

  /**
   * Return the caller's ad wallet (creates an empty one on first access).
   *
   * CN-ADS-15 (feed harden): map to an EXPLICIT `{ balance, reserved,
   * grantBalance }` view instead of returning the raw Mongoose document (which
   * shipped unmodeled internal fields — ownerUserId, grantExpiresAt, timestamps,
   * __v — by default). Own-wallet-only, so not a cross-user leak, but the typed
   * view is the correct contract. `grantBalance` is included deliberately: the
   * boost composer's affordability gate (CN-ADS-4) reads `balance + grantBalance`
   * so a user whose credits sit in the grant bucket is not falsely blocked.
   * Keep in sync with the web `WalletView` type (features/connect/ads/ads.types.ts).
   */
  @Get()
  async getWallet(@Req() req: AuthedRequest) {
    const w = await this.walletService.getWallet(req.user.sub);
    return {
      balance: w.balance ?? 0,
      reserved: w.reserved ?? 0,
      grantBalance: w.grantBalance ?? 0,
    };
  }

  /**
   * Step 1 -- create a Razorpay order for a wallet top-up. `amount` is in whole
   * rupees (min 99). Returns the checkout-sheet payload (keyId, orderId, amount
   * in paise, currency, walletTopupId) so the web can reuse openCheckout.
   */
  @Post('topup/order')
  @Throttle({ 'ads-wallet-topup-order': { limit: TOPUP_ORDER_RATE_LIMIT, ttl: 60_000 } })
  createTopupOrder(@Req() req: AuthedRequest, @Body() dto: CreateWalletTopupOrderDto) {
    return this.topupCheckout.createOrder(req.user.sub, dto);
  }

  /**
   * Step 2 -- confirm a wallet top-up. The server verifies the Razorpay
   * signature and credits the wallet on success. Idempotent: re-confirming an
   * already-paid intent returns the current wallet without re-crediting.
   */
  @Post('topup/confirm')
  @Throttle({ 'ads-wallet-topup-confirm': { limit: 20, ttl: 60_000 } })
  confirmTopup(@Req() req: AuthedRequest, @Body() dto: ConfirmWalletTopupDto) {
    return this.topupCheckout.confirmPayment(req.user.sub, dto);
  }
}
