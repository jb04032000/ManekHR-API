import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { env } from '../../../config/env';
import {
  AddOnDefinition,
  AddOnDefinitionDocument,
  AddOnType,
} from '../schemas/add-on-definition.schema';
import { CreditPackPayment } from '../schemas/credit-pack-payment.schema';
import { Subscription } from '../../subscriptions/schemas/subscription.schema';
import { RazorpayPlatformService } from '../../subscriptions/billing/services/razorpay-platform.service';
import { AddOnsService } from '../add-ons.service';
import { Msg91BalanceService } from '../../sms/services/msg91-balance.service';
import {
  CreateCreditPackOrderDto,
  ConfirmCreditPackPaymentDto,
} from '../dto/credit-pack-checkout.dto';

interface CreateOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  creditPackPaymentId: string;
  addOnDefinitionId: string;
  quantity: number;
}

interface ConfirmResponse {
  creditPackPaymentId: string;
  purchasedAddOnId: string;
  smsBalance: number;
  whatsappBalance: number;
}

/**
 * Wave 7 credit-pack billing hookup.
 *
 * Two-step flow mirroring `SubscriptionCheckoutService`:
 *   1. POST /add-ons/credit-pack/order  → Razorpay order created, client opens checkout sheet
 *   2. POST /add-ons/credit-pack/confirm → server verifies signature + activates pack via internal flow
 *
 * Activation goes through `AddOnsService.applyCreditPackInternal()` which
 * skips the public `purchaseAddOn()` BadRequest gate. Same internal path is
 * used by the auto-recharge cron and admin assign — payment-side concerns
 * are kept here, balance/PurchasedAddOn writes stay in AddOnsService.
 */
@Injectable()
export class CreditPackCheckoutService {
  private readonly logger = new Logger(CreditPackCheckoutService.name);

  /** Reuse window for an open (status=created) credit-pack payment intent. */
  private static readonly OPEN_INTENT_REUSE_WINDOW_MS = 10 * 60 * 1000;

  constructor(
    @InjectModel(AddOnDefinition.name)
    private readonly addOnDefinitionModel: Model<AddOnDefinitionDocument>,
    @InjectModel(CreditPackPayment.name)
    private readonly paymentModel: Model<CreditPackPayment>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    private readonly razorpay: RazorpayPlatformService,
    private readonly addOnsService: AddOnsService,
    // Wave 8.1 — pre-flight ops alert when MSG91 wallet runway can't cover
    // the implied volume of a freshly-purchased pack. Optional from @Global
    // SmsModule.
    private readonly msg91Balance: Msg91BalanceService,
  ) {}

  /**
   * Step 1 — user clicked "Buy SMS Pack 100": validate pack, compute amount,
   * create Razorpay order, persist a CreditPackPayment intent in `created`
   * state. Returns the payload powering the Razorpay checkout sheet.
   *
   * Reuses an open intent for the same (user, pack, qty) inside the reuse
   * window — same defence-in-depth as `SubscriptionCheckoutService`.
   */
  async createOrder(userId: string, dto: CreateCreditPackOrderDto): Promise<CreateOrderResponse> {
    const subscription = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();
    if (!subscription) {
      throw new BadRequestException('You need an active subscription to purchase credit packs');
    }

    const addOnDef = await this.addOnDefinitionModel.findById(dto.addOnDefinitionId).lean();
    if (!addOnDef || !addOnDef.isActive) {
      throw new NotFoundException('Credit pack not available');
    }
    if (addOnDef.type !== AddOnType.CREDIT_PACK) {
      throw new BadRequestException(
        'This add-on is not a credit pack — use /add-ons/purchase instead',
      );
    }

    const unitPrice = addOnDef.lifetimePrice ?? 0;
    if (unitPrice <= 0) {
      throw new BadRequestException('Credit pack has no lifetime price configured');
    }
    const amountPaise = Math.round(unitPrice * dto.quantity * 100);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException('Computed amount is invalid');
    }

    // Reuse open intent if same user/pack/qty/amount already in flight.
    const reusable = await this.findReusableOpenIntent({
      userId,
      addOnDefinitionId: dto.addOnDefinitionId,
      quantity: dto.quantity,
      amountPaise,
    });
    if (reusable) {
      this.logger.log(
        `credit-pack order reused user=${userId} pack=${dto.addOnDefinitionId} order=${reusable.gatewayOrderId} intent=${String(reusable._id)}`,
      );
      return {
        orderId: reusable.gatewayOrderId,
        amount: reusable.amountPaise,
        currency: 'INR',
        keyId: this.razorpay.getKeyId(),
        creditPackPaymentId: String(reusable._id),
        addOnDefinitionId: dto.addOnDefinitionId,
        quantity: dto.quantity,
      };
    }

    const order = await this.razorpay.createOrder({
      amountPaise,
      receipt: this.buildReceipt(userId),
      notes: {
        userId,
        kind: 'credit_pack',
        addOnDefinitionId: dto.addOnDefinitionId,
        quantity: String(dto.quantity),
      },
    });

    const intent = await this.paymentModel.create({
      userId: new Types.ObjectId(userId),
      subscriptionId: subscription._id,
      addOnDefinitionId: addOnDef._id,
      quantity: dto.quantity,
      status: 'created',
      gatewayOrderId: order.id,
      amountPaise,
    });

    this.logger.log(
      `credit-pack order created user=${userId} pack=${addOnDef.slug} qty=${dto.quantity} order=${order.id} intent=${String(intent._id)}`,
    );

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: this.razorpay.getKeyId(),
      creditPackPaymentId: String(intent._id),
      addOnDefinitionId: dto.addOnDefinitionId,
      quantity: dto.quantity,
    };
  }

  /**
   * Step 2 — Razorpay sheet returned a signed payload. Verify signature,
   * transition the intent to `captured`, then activate the pack via the
   * internal AddOnsService flow (PurchasedAddOn + balance top-up + recompute).
   *
   * Idempotent: re-issuing the same confirm with the same intent + payment id
   * resolves to the existing `activated` row instead of double-activating.
   */
  async confirmPayment(userId: string, dto: ConfirmCreditPackPaymentDto): Promise<ConfirmResponse> {
    const intent = await this.paymentModel.findById(dto.creditPackPaymentId).exec();
    if (!intent) throw new NotFoundException('Credit pack payment not found');
    if (String(intent.userId) !== userId) {
      throw new ForbiddenException('Payment record does not belong to user');
    }
    if (intent.gatewayOrderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order id mismatch');
    }

    if (intent.status === 'activated' && intent.purchasedAddOnId) {
      return this.toConfirmResponse(intent, userId);
    }
    if (intent.status !== 'created' && intent.status !== 'captured') {
      throw new BadRequestException(`Payment is in non-confirmable state: ${intent.status}`);
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      orderId: dto.razorpayOrderId,
      paymentId: dto.razorpayPaymentId,
      signature: dto.razorpaySignature,
    });
    if (!verified) {
      throw new BadRequestException('Razorpay signature verification failed');
    }

    const now = new Date();

    // Atomic transition created → captured. Race-safe re-read on conflict.
    let captured = intent;
    if (intent.status === 'created') {
      const updated = await this.paymentModel
        .findOneAndUpdate(
          { _id: intent._id, status: 'created' },
          {
            $set: {
              status: 'captured',
              gatewayPaymentId: dto.razorpayPaymentId,
              capturedAt: now,
            },
          },
          { new: true },
        )
        .exec();
      if (!updated) {
        const reread = await this.paymentModel.findById(intent._id).exec();
        if (reread && reread.status === 'activated' && reread.purchasedAddOnId) {
          return this.toConfirmResponse(reread, userId);
        }
        throw new BadRequestException('Payment is not in a confirmable state');
      }
      captured = updated;
    }

    // Activate the pack via the internal flow (skips the public
    // purchaseAddOn BadRequest gate). Mints PurchasedAddOn + applies
    // balance + recomputes appliedEntitlements.
    const addOnDef = await this.addOnDefinitionModel.findById(captured.addOnDefinitionId).lean();
    if (!addOnDef) {
      throw new NotFoundException('Credit pack definition disappeared');
    }

    const purchasedAddOn = await this.addOnsService.applyCreditPackInternal({
      userId,
      subscriptionId: String(captured.subscriptionId),
      addOnDefinition: addOnDef,
      quantity: captured.quantity,
      source: 'self',
    });

    captured.status = 'activated';
    captured.purchasedAddOnId = purchasedAddOn._id;
    captured.activatedAt = new Date();
    await captured.save();

    this.logger.log(
      `credit-pack activated user=${userId} pack=${addOnDef.slug} qty=${captured.quantity} purchased=${String(purchasedAddOn._id)} payment=${String(captured._id)}`,
    );

    // Wave 8.1 — opportunistic ops alert when our MSG91 wallet runway
    // can't cover the implied volume of this pack. Customer doesn't see
    // anything (silent UX); ops gets paged so they can top up MSG91 BEFORE
    // the customer fires their first send. Best-effort — never fails the
    // confirm flow.
    void this.maybeFireOpsAlertOnPurchase(addOnDef, captured).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`ops alert hook failed (non-fatal) payment=${String(captured._id)}: ${msg}`);
    });

    return this.toConfirmResponse(captured, userId);
  }

  /**
   * Estimate worst-case MSG91 cost for the implied volume of a pack:
   *   credits × MSG91_COST_GSM7_SEG_PAISE (or UCS2 for WhatsApp).
   * Then check `hasRunwayFor`. Skip alert when our wallet has runway.
   */
  private async maybeFireOpsAlertOnPurchase(
    addOnDef: AddOnDefinition,
    captured: CreditPackPayment,
  ): Promise<void> {
    const sms = (addOnDef.entitlementDelta?.creditsDelta?.sms ?? 0) * captured.quantity;
    const wa = (addOnDef.entitlementDelta?.creditsDelta?.whatsapp ?? 0) * captured.quantity;
    if (sms === 0 && wa === 0) return; // not a credit-bearing pack

    const smsCostPaise = env.msg91.costGsm7SegPaise;
    // WhatsApp passthrough cost roughly approximated at ₹0.40/conversation
    // for a fast pre-flight; per-send AiSensy rate-card not modeled here.
    const waCostPaise = env.aisensy.costPerConversationPaise;
    const requiredPaise = sms * smsCostPaise + wa * waCostPaise;
    if (requiredPaise <= 0) return;

    const hasRunway = await this.msg91Balance.hasRunwayFor(requiredPaise, 1);
    if (hasRunway) return;

    const status = (await this.msg91Balance.getStatus().catch(() => null)) as {
      balancePaise?: number;
      avgDailyBurnPaise?: number;
    } | null;
    await this.addOnsService
      .dispatchOpsLowMsg91Alert({
        context: 'pack_purchase',
        balancePaise: status?.balancePaise ?? -1,
        requiredPaise,
        runwayDays:
          status?.avgDailyBurnPaise && status.avgDailyBurnPaise > 0
            ? Math.floor((status.balancePaise ?? 0) / status.avgDailyBurnPaise)
            : 0,
        workspaceId: String(captured.subscriptionId),
        note: `Customer pack: ${addOnDef.slug} × ${captured.quantity}`,
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(`ops alert dispatch failed: ${msg}`);
      });
  }

  private async findReusableOpenIntent(args: {
    userId: string;
    addOnDefinitionId: string;
    quantity: number;
    amountPaise: number;
  }): Promise<CreditPackPayment | null> {
    const cutoff = new Date(Date.now() - CreditPackCheckoutService.OPEN_INTENT_REUSE_WINDOW_MS);
    return this.paymentModel
      .findOne({
        userId: new Types.ObjectId(args.userId),
        addOnDefinitionId: new Types.ObjectId(args.addOnDefinitionId),
        quantity: args.quantity,
        amountPaise: args.amountPaise,
        status: 'created',
        gatewayOrderId: { $exists: true, $ne: null },
        createdAt: { $gte: cutoff },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  private buildReceipt(userId: string): string {
    const userTail = userId.slice(-12);
    const tsB36 = Date.now().toString(36);
    return `cp-${userTail}-${tsB36}`;
  }

  private async toConfirmResponse(
    intent: CreditPackPayment,
    userId: string,
  ): Promise<ConfirmResponse> {
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'trial'] },
      })
      .lean();
    type CommsEntitlement = {
      smsCreditsBalance?: number;
      whatsappCreditsBalance?: number;
    };
    const applied = sub?.appliedEntitlements as { communications?: CommsEntitlement } | undefined;
    const comms: CommsEntitlement = applied?.communications ?? {};
    return {
      creditPackPaymentId: String(intent._id),
      purchasedAddOnId: intent.purchasedAddOnId ? String(intent.purchasedAddOnId) : '',
      smsBalance: comms.smsCreditsBalance ?? 0,
      whatsappBalance: comms.whatsappCreditsBalance ?? 0,
    };
  }

  /**
   * History for the credits dashboard — `CREDIT_PACK` purchases that
   * succeeded plus their captured payments. Returns newest-first.
   */
  async listMyCreditPackPayments(userId: string) {
    return this.paymentModel
      .find({
        userId: new Types.ObjectId(userId),
        status: { $in: ['captured', 'activated'] },
      })
      .populate('addOnDefinitionId')
      .sort({ createdAt: -1 })
      .lean();
  }
}
