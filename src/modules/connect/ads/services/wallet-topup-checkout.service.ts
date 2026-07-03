import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AdWalletTopup, type AdWalletTopupDocument } from '../schemas/ad-wallet-topup.schema';
import { WalletService } from './wallet.service';
import { RazorpayPlatformService } from '../../../subscriptions/billing/services/razorpay-platform.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import type { AdvertiserWalletDocument } from '../schemas/advertiser-wallet.schema';
import type { CreateWalletTopupOrderDto, ConfirmWalletTopupDto } from '../dto/wallet-topup.dto';

interface CreateOrderResponse {
  /** Razorpay key id for the client checkout sheet. */
  keyId: string;
  /** Razorpay order id the checkout sheet opens against. */
  orderId: string;
  /** Order amount in PAISE (what the sheet charges). */
  amount: number;
  /** Settlement currency. */
  currency: string;
  /** Local AdWalletTopup intent id echoed back on confirm. */
  walletTopupId: string;
}

/**
 * ManekHR Connect Ads -- wallet top-up checkout (gateway-confirm-first).
 *
 * Replaces the old insecure direct-credit endpoint with the real
 * order -> pay -> verify-signature -> credit flow, REUSING the ERP's
 * `RazorpayPlatformService` for both order creation and signature
 * verification (no hand-rolled HMAC, no second Razorpay client).
 *
 * Two-step flow mirroring `CreditPackCheckoutService`, but person-centric:
 *   1. POST /connect/ads/wallet/topup/order   -> Razorpay order created, the
 *      client opens the checkout sheet with the returned payload.
 *   2. POST /connect/ads/wallet/topup/confirm -> server verifies the signed
 *      payload, then credits the wallet via `WalletService.topup`.
 *
 * The wallet is denominated in RUPEES. Razorpay charges in PAISE. The rupee
 * -> paise conversion (x100) happens ONLY at the Razorpay boundary; the wallet
 * is always credited in rupees.
 *
 * Idempotency:
 *   - A double-confirm against an already-`paid` intent is a safe no-op: the
 *     current wallet is returned without re-crediting.
 *   - The credit itself passes the razorpayPaymentId as the wallet-ledger
 *     idempotencyKey so even a racing re-confirm cannot double-credit (the
 *     ledger has a partial-unique idempotencyKey index).
 *
 * Connect has NO workspace: the owner is always `ownerUserId` (= req.user.sub).
 */
@Injectable()
export class WalletTopupCheckoutService {
  private readonly logger = new Logger(WalletTopupCheckoutService.name);

  constructor(
    @InjectModel(AdWalletTopup.name)
    private readonly topupModel: Model<AdWalletTopupDocument>,
    private readonly razorpay: RazorpayPlatformService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * Step 1 -- advertiser clicked "Add credits": convert rupees to paise,
   * create a Razorpay order via the platform service, persist a `created`
   * AdWalletTopup intent. Returns the payload powering the checkout sheet
   * (mirrors the credit-pack order response so the web can reuse openCheckout).
   */
  async createOrder(
    ownerUserId: string,
    dto: CreateWalletTopupOrderDto,
  ): Promise<CreateOrderResponse> {
    const amountRupees = dto.amount;
    // Convert to paise ONLY at the Razorpay boundary. The wallet stays rupees.
    const amountPaise = Math.round(amountRupees * 100);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException('Computed amount is invalid');
    }

    const order = await this.razorpay.createOrder({
      amountPaise,
      receipt: this.buildReceipt(ownerUserId),
      notes: {
        ownerUserId,
        kind: 'ads_wallet_topup',
      },
    });

    const intent = await this.topupModel.create({
      ownerUserId: new Types.ObjectId(ownerUserId),
      amountRupees,
      amountPaise,
      currency: 'INR',
      razorpayOrderId: order.id,
      status: 'created',
    });

    this.logger.log(
      `ads wallet topup order created owner=${ownerUserId} amountRupees=${amountRupees} order=${order.id} intent=${String(intent._id)}`,
    );

    return {
      keyId: this.razorpay.getKeyId(),
      orderId: order.id,
      amount: order.amount, // paise -- the checkout sheet charges this
      currency: 'INR',
      walletTopupId: String(intent._id),
    };
  }

  /**
   * Step 2 -- the checkout sheet returned a signed payload. Verify the
   * signature, mark the intent `paid`, then credit the wallet in rupees.
   *
   * Idempotent: re-confirming an already-`paid` intent returns the current
   * wallet without re-crediting. The credit passes razorpayPaymentId as the
   * ledger idempotencyKey so a racing re-confirm also cannot double-credit.
   */
  async confirmPayment(
    ownerUserId: string,
    dto: ConfirmWalletTopupDto,
  ): Promise<AdvertiserWalletDocument> {
    const intent = await this.topupModel.findById(dto.walletTopupId).exec();
    // ObjectId-equality ownership check (mirrors feed.service deletePost) rather
    // than String() coercion, for consistency with the rest of the ads module.
    if (!intent || !intent.ownerUserId.equals(ownerUserId)) {
      // Treat not-owned the same as not-found so we never confirm whether an
      // intent id belongs to a different user.
      throw new NotFoundException('Wallet top-up not found');
    }

    // Idempotency: a double-confirm against an already-paid intent is a safe
    // no-op -- return the current wallet without re-crediting or re-verifying.
    if (intent.status === 'paid') {
      return this.wallet.getWallet(ownerUserId);
    }

    if (intent.razorpayOrderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order id mismatch');
    }
    if (intent.status !== 'created') {
      throw new BadRequestException(`Top-up is in a non-confirmable state: ${intent.status}`);
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      orderId: dto.razorpayOrderId,
      paymentId: dto.razorpayPaymentId,
      signature: dto.razorpaySignature,
    });
    if (!verified) {
      // Mark failed and refuse -- never credit on an unverified signature.
      intent.status = 'failed';
      await intent.save();
      this.logger.warn(
        `ads wallet topup signature verification failed owner=${ownerUserId} order=${dto.razorpayOrderId} intent=${String(intent._id)}`,
      );
      throw new BadRequestException('Razorpay signature verification failed');
    }

    intent.razorpayPaymentId = dto.razorpayPaymentId;
    intent.status = 'paid';
    await intent.save();

    // Credit the wallet in RUPEES. The razorpayPaymentId is the ledger
    // idempotencyKey so a retried/racing confirm cannot double-credit.
    const wallet = await this.wallet.topup(ownerUserId, intent.amountRupees, {
      ref: dto.razorpayPaymentId,
      idempotencyKey: dto.razorpayPaymentId,
      recordedBy: ownerUserId,
      note: 'Ads wallet top-up via gateway',
    });

    await this.audit.logEvent({
      module: AppModule.ADS,
      entityType: 'AdWalletTopup',
      entityId: String(intent._id),
      action: 'wallet_topup_confirmed',
      actorId: ownerUserId,
      meta: {
        amountRupees: intent.amountRupees,
        amountPaise: intent.amountPaise,
        razorpayOrderId: dto.razorpayOrderId,
        razorpayPaymentId: dto.razorpayPaymentId,
      },
    });

    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'ads.topup_wallet',
      properties: {
        amountRupees: intent.amountRupees,
        amountPaise: intent.amountPaise,
        balanceAfter: wallet.balance,
      },
    });

    this.logger.log(
      `ads wallet topup confirmed owner=${ownerUserId} amountRupees=${intent.amountRupees} payment=${dto.razorpayPaymentId} intent=${String(intent._id)}`,
    );

    return wallet;
  }

  private buildReceipt(ownerUserId: string): string {
    // Razorpay caps receipts at 40 chars. `aw-` + 12-char user tail + base36
    // timestamp stays well under the cap.
    const userTail = ownerUserId.slice(-12);
    const tsB36 = Date.now().toString(36);
    return `aw-${userTail}-${tsB36}`;
  }
}
