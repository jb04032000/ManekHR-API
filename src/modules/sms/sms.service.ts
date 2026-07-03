import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SmsDispatchLog,
  SmsDispatchStatus,
} from './schemas/sms-dispatch-log.schema';
import { Msg91CostTable } from './schemas/msg91-cost-table.schema';
import { PlatformCreditPool } from './schemas/platform-credit-pool.schema';
import { PlatformCreditLedger } from './schemas/platform-credit-ledger.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { computeSegments, SmsEncoding } from './utils/sms-segments.util';
import { Msg91BalanceService } from './services/msg91-balance.service';

/**
 * Wave 8.1 — MSG91 raw error → normalized code map. Auto-refund REMOVED;
 * refunds are now manual-only (admin endpoint). Codes still normalized so
 * `SmsDispatchLog.errorCode` stays useful for ops dashboards + retry logic.
 *
 * Special case: `PROVIDER_INSUFFICIENT_BALANCE` is set by the pre-flight
 * `hasRunwayFor` check, NOT this normalizer — when MSG91 wallet is empty,
 * we never call the API. If MSG91 returns its own insufficient-balance
 * mid-flight (race: snapshot stale), we map to the same code from below.
 */

function normalizeMsg91Error(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).toLowerCase();
  if (s.includes('blacklist')) return 'BLACKLISTED';
  if (s.includes('invalid mobile') || s.includes('invalid number'))
    return 'INVALID_NUMBER';
  if (s.includes('dlt template') || s.includes('template not approved'))
    return 'DLT_TEMPLATE_REJECTED';
  if (s.includes('invalid template')) return 'INVALID_TEMPLATE';
  if (s.includes('invalid header') || s.includes('sender id'))
    return 'INVALID_HEADER';
  if (s.includes('deactivat')) return 'NUMBER_DEACTIVATED';
  if (s.includes('dnd')) return 'DND_BLOCKED';
  if (s.includes('reject')) return 'REJECTED';
  if (s.includes('timeout')) return 'TIMEOUT';
  if (s.includes('network')) return 'NETWORK_ERROR';
  if (s.includes('retry')) return 'RETRY_LATER';
  if (s.includes('insufficient') && s.includes('balance'))
    return 'PROVIDER_INSUFFICIENT_BALANCE';
  if (s.includes('low balance') || s.includes('balance is low'))
    return 'PROVIDER_INSUFFICIENT_BALANCE';
  return 'UNKNOWN';
}

/**
 * Mask a mobile number for logging — keep country prefix + last 4 digits.
 * Examples:
 *   "919876543210" → "91XXXXXX3210"
 *   "9876543210"   → "XXXXXX3210"
 */
function maskMobile(mobile: string): string {
  if (!mobile) return '***';
  const cleaned = String(mobile).replace(/\D/g, '');
  if (cleaned.length <= 4) return '*'.repeat(cleaned.length);
  if (cleaned.length === 12) {
    // 91XXXXXXXXXX — Indian with country code
    return `${cleaned.slice(0, 2)}XXXXXX${cleaned.slice(-4)}`;
  }
  return `${'X'.repeat(Math.max(0, cleaned.length - 4))}${cleaned.slice(-4)}`;
}

/**
 * Normalise a mobile number to MSG91 format: country code + 10-digit number,
 * digits only. Strips +, spaces, dashes. Adds default '91' prefix if missing.
 */
function normaliseMobileForMsg91(mobile: string, defaultCountryCode = '91'): string {
  const cleaned = String(mobile || '').replace(/\D/g, '');
  if (cleaned.length === 10) return `${defaultCountryCode}${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith(defaultCountryCode)) return cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('0')) {
    return `${defaultCountryCode}${cleaned.slice(1)}`;
  }
  return cleaned; // leave as-is — provider will reject if invalid
}

export interface SendDltSmsInput {
  /** Required: workspace owning the dispatch (for audit + counter). */
  workspaceId: string | Types.ObjectId;
  /** Optional firm scope. */
  firmId?: string | Types.ObjectId | null;
  /** Recipient mobile (any format — normalised internally). */
  mobile: string;
  /** DLT-approved template ID (MSG91 flow_id). */
  templateId: string;
  /** Template variables — passed as VAR1, VAR2, ... per MSG91 Flow API. */
  vars?: Record<string, string | number>;
  /** Optional sender ID override (default uses MSG91_SENDER_ID env var). */
  senderId?: string;
  /** For audit / traceability — link to source entity (invoice, machine etc.). */
  entityRef?: { id: string | Types.ObjectId; type: string };
  /**
   * Wave 8.2 — credit-source selector.
   *   'customer'        (default) — debits the workspace owner's subscription credit balance.
   *   'marketing_pool'  — debits the platform-side `PlatformCreditPool` (admin-only campaigns).
   *   'system'          — bypasses both credit ledgers (rare; ops-alert SMS to ops phone).
   * MSG91 wallet pre-flight + provider call are identical across all three.
   */
  creditSource?: 'customer' | 'marketing_pool' | 'system';
}

export interface SendDltSmsResult {
  status: SmsDispatchStatus;
  providerMessageId?: string;
  errorMessage?: string;
}

/**
 * SmsService — DLT-compliant SMS dispatch via MSG91 Flow API.
 *
 * Wave-3 Drift #35 — replaces previous stub that only logged to console.
 *
 * India SMS regulations (TRAI 2025): all transactional/promotional SMS MUST
 * use a DLT-approved template + DLT-approved sender ID. Free-text sends are
 * BLOCKED by all telcos in India. Hence `send()` (legacy free-text method)
 * remains a stub — only `sendDltSms()` actually dispatches.
 *
 * Provider: MSG91 Flow API
 *   POST https://control.msg91.com/api/v5/flow/
 *   Headers: { authkey: MSG91_AUTH_KEY, content-type: application/json }
 *   Body: { flow_id, sender, mobiles, VAR1, VAR2, ... }
 *
 * Future-ready: extend `provider` field on SmsDispatchLog to support Twilio /
 * Plivo / etc. For now MSG91 is the only India-compliant provider wired in.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly msg91Endpoint = 'https://control.msg91.com/api/v5/flow/';

  constructor(
    private readonly config: ConfigService,
    @InjectModel(SmsDispatchLog.name)
    private readonly dispatchLogModel: Model<SmsDispatchLog>,
    @InjectModel(Msg91CostTable.name)
    private readonly costTableModel: Model<Msg91CostTable>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(PlatformCreditPool.name)
    private readonly platformPoolModel: Model<PlatformCreditPool>,
    @InjectModel(PlatformCreditLedger.name)
    private readonly platformLedgerModel: Model<PlatformCreditLedger>,
    // Optional — fail-open when balance service unavailable (e.g. tests
    // that bootstrap SmsModule in isolation). Pre-flight short-circuits
    // to "always allow" when undefined.
    @Optional()
    private readonly msg91Balance?: Msg91BalanceService,
  ) {}

  /**
   * Wave 8.2 — atomic decrement on the platform marketing pool. Returns
   * `{ ok, balanceAfter }`. Writes a ledger row when a debit succeeds.
   */
  private async tryConsumeMarketingPool(
    channel: 'sms' | 'whatsapp',
    n: number,
    campaignRef?: { campaignId?: Types.ObjectId; ref?: string },
  ): Promise<{ ok: boolean; balanceAfter: number }> {
    if (n <= 0) return { ok: true, balanceAfter: 0 };
    const updated = await this.platformPoolModel.findOneAndUpdate(
      { channel, balance: { $gte: n } },
      { $inc: { balance: -n } },
      { new: true },
    );
    if (!updated) return { ok: false, balanceAfter: 0 };

    await this.platformLedgerModel
      .create({
        channel,
        type: 'send',
        amount: -n,
        balanceAfter: updated.balance,
        ref: campaignRef?.ref,
        campaignId: campaignRef?.campaignId,
        note: 'Marketing campaign send',
      })
      .catch((err) =>
        this.logger.warn(
          `Marketing ledger write failed (debit, non-fatal): ${err?.message}`,
        ),
      );
    return { ok: true, balanceAfter: updated.balance };
  }

  /**
   * Wave 8.2 — atomic refund onto the platform marketing pool. Used when
   * a marketing-mode send fails after debit (rare; symmetry with customer
   * refund flow but auto only for marketing pool, not customer credits).
   */
  private async refundMarketingPool(
    channel: 'sms' | 'whatsapp',
    n: number,
  ): Promise<void> {
    if (n <= 0) return;
    const updated = await this.platformPoolModel.findOneAndUpdate(
      { channel },
      { $inc: { balance: n } },
      { new: true, upsert: true },
    );
    await this.platformLedgerModel
      .create({
        channel,
        type: 'adjustment',
        amount: n,
        balanceAfter: updated?.balance ?? n,
        note: 'Auto-refund (marketing send failed)',
      })
      .catch(() => {
        /* never cascade */
      });
  }

  /**
   * Resolve workspace owner's userId — used to scope subscription credit ops.
   */
  private async getWorkspaceOwnerId(
    workspaceId: Types.ObjectId,
  ): Promise<Types.ObjectId | null> {
    const ws = await this.workspaceModel
      .findById(workspaceId, { ownerId: 1 })
      .lean();
    if (!ws?.ownerId) return null;
    return ws.ownerId instanceof Types.ObjectId
      ? ws.ownerId
      : new Types.ObjectId(String(ws.ownerId));
  }

  /**
   * Wave 8 — atomic decrement of N SMS credits on the workspace owner's
   * subscription. `n` defaults to 1 (single-segment SMS). Returns true if
   * the requested credits were consumed, false if balance was insufficient
   * (caller MUST persist 'skipped' and abort).
   *
   * Atomic via `findOneAndUpdate` with `$gte: n` precondition — safe under
   * concurrent dispatcher fan-out.
   */
  private async tryConsumeSmsCredit(
    workspaceId: Types.ObjectId,
    n: number = 1,
  ): Promise<boolean> {
    if (n <= 0) return true;
    const ownerId = await this.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return false;
    const result = await this.subscriptionModel.findOneAndUpdate(
      {
        userId: ownerId,
        status: { $in: ['active', 'trial'] },
        'appliedEntitlements.communications.smsCreditsBalance': { $gte: n },
      },
      { $inc: { 'appliedEntitlements.communications.smsCreditsBalance': -n } },
      { new: true, projection: { _id: 1 } },
    );
    return result !== null;
  }

  /**
   * Wave 8 — atomic increment of N SMS credits on the workspace owner's
   * subscription. Used by `handleProviderFailure` for deterministic-error
   * refunds. Inverse of `tryConsumeSmsCredit`. Best-effort — caller logs.
   */
  private async refundSmsCredit(
    workspaceId: Types.ObjectId,
    n: number,
  ): Promise<boolean> {
    if (n <= 0) return false;
    const ownerId = await this.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return false;
    const result = await this.subscriptionModel.updateOne(
      {
        userId: ownerId,
        status: { $in: ['active', 'trial'] },
      },
      { $inc: { 'appliedEntitlements.communications.smsCreditsBalance': n } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Wave 8 — wholesale cost lookup. Reads the latest active row from
   * `Msg91CostTable` matching `(provider, country, encoding, segments)`.
   * Returns 0 (best-effort) when no matching row exists — drives a non-fatal
   * "missing cost row" log so ops can backfill.
   */
  private async lookupProviderCost(
    encoding: SmsEncoding,
    segments: number,
    country: string = 'IN',
  ): Promise<number> {
    const now = new Date();
    const row = await this.costTableModel
      .findOne({
        provider: 'msg91',
        channel: 'sms',
        country,
        encoding,
        segments: Math.min(Math.max(segments, 1), 10),
        effectiveFrom: { $lte: now },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
      })
      .sort({ effectiveFrom: -1 })
      .lean();
    if (!row) {
      this.logger.warn(
        `MSG91 cost-table miss: encoding=${encoding} segments=${segments} country=${country}`,
      );
      return 0;
    }
    return row.costPaise;
  }

  /**
   * @deprecated Use sendDltSms() — free-text SMS is blocked by Indian telcos
   * since DLT enforcement (TRAI 2025). This method only logs and skips.
   */
  async send(mobile: string, message: string): Promise<void> {
    this.logger.warn(
      `[SMS DEPRECATED] Free-text SMS to ${maskMobile(mobile)} skipped — DLT requires sendDltSms() with template_id. Message: ${message.slice(0, 100)}...`,
    );
  }

  /**
   * Send a DLT-compliant SMS via MSG91 Flow API.
   *
   * Always writes a SmsDispatchLog entry (status: sent | failed | skipped),
   * regardless of dispatch outcome — log = source of truth for billing + audit.
   *
   * Returns result without throwing (callers usually want to record + continue
   * rather than fail their parent operation on SMS errors).
   */
  async sendDltSms(input: SendDltSmsInput): Promise<SendDltSmsResult> {
    const wsId =
      input.workspaceId instanceof Types.ObjectId
        ? input.workspaceId
        : new Types.ObjectId(String(input.workspaceId));
    const firmId = input.firmId
      ? input.firmId instanceof Types.ObjectId
        ? input.firmId
        : new Types.ObjectId(String(input.firmId))
      : null;

    const authKey = this.config.get<string>('app.msg91.authKey');
    const senderId =
      input.senderId || this.config.get<string>('app.msg91.senderId');
    const mobileMasked = maskMobile(input.mobile);

    // Pre-flight: missing config → skip (never crash app)
    if (!authKey) {
      const reason = 'MSG91_AUTH_KEY not configured';
      this.logger.warn(`[SMS SKIP] ${mobileMasked}: ${reason}`);
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId,
        senderId,
        status: 'skipped',
        errorMessage: reason,
        entityRef: input.entityRef,
      });
      return { status: 'skipped', errorMessage: reason };
    }

    if (!input.templateId) {
      const reason = 'templateId required for DLT-compliant SMS';
      this.logger.warn(`[SMS SKIP] ${mobileMasked}: ${reason}`);
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId || '(missing)',
        senderId,
        status: 'skipped',
        errorMessage: reason,
        entityRef: input.entityRef,
      });
      return { status: 'skipped', errorMessage: reason };
    }

    const normalisedMobile = normaliseMobileForMsg91(input.mobile);
    if (!normalisedMobile || normalisedMobile.length < 10) {
      const reason = `Invalid mobile number: ${mobileMasked}`;
      this.logger.warn(`[SMS SKIP] ${reason}`);
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId,
        senderId,
        status: 'skipped',
        errorMessage: reason,
        entityRef: input.entityRef,
      });
      return { status: 'skipped', errorMessage: reason };
    }

    // Wave 8 — segment-aware billing. Compute segments + encoding from the
    // rendered preview text (concatenation of template vars). MSG91 itself
    // does final substitution + segment math on the wire; we mirror it
    // closely enough for honest credit charging (drift > 5% triggers
    // monthly invoice reconciler alert in Wave 9).
    const renderedPreview = this.buildSegmentPreview(input);
    const seg = computeSegments(renderedPreview);
    const segments = seg.segments;
    const encoding = seg.encoding;
    const country = 'IN';

    // Lookup wholesale provider cost for this (encoding, segments).
    // Done BEFORE the credit deduct so the pre-flight wallet check has a
    // concrete `estCostPaise` to compare against the latest snapshot.
    const providerCostPaise = await this.lookupProviderCost(
      encoding,
      segments,
      country,
    );

    // Wave 8.1 — pre-flight MSG91 wallet check. If our wallet doesn't
    // have runway for this segment cost (× safety multiplier), skip BEFORE
    // debiting the customer credit. Customer keeps their balance; ops gets
    // alerted (handled by AddOnsService.dispatchOpsLowMsg91Alert via the
    // dispatcher path — direct sends from non-cron callers fall back to
    // logging only). Idempotent retry: next-day cron creates a fresh log.
    if (
      this.msg91Balance &&
      !(await this.msg91Balance.hasRunwayFor(providerCostPaise))
    ) {
      const reason = 'Provider wallet low — message queued for retry';
      this.logger.warn(
        `[SMS SKIP — provider empty] ${mobileMasked}: balance below required runway, customer credit retained`,
      );
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId,
        senderId,
        status: 'skipped',
        errorMessage: reason,
        errorCode: 'PROVIDER_INSUFFICIENT_BALANCE',
        segments,
        encoding,
        country,
        providerCostPaise: 0,
        entityRef: input.entityRef,
      });
      return {
        status: 'skipped',
        errorMessage: reason,
      };
    }

    // Wave 8 / 8.2 — atomic credit deduct BEFORE provider call. Branch on
    // `creditSource`:
    //   'customer'        → workspace owner's subscription balance (default)
    //   'marketing_pool'  → platform-side marketing pool
    //   'system'          → bypass credit accounting (ops alerts only)
    const creditSource = input.creditSource ?? 'customer';
    if (creditSource === 'customer') {
      const consumed = await this.tryConsumeSmsCredit(wsId, segments);
      if (!consumed) {
        const reason = `Insufficient SMS credits — ${segments} needed for this message`;
        this.logger.warn(`[SMS SKIP] ${mobileMasked}: ${reason}`);
        await this.persistLog({
          workspaceId: wsId,
          firmId,
          mobileMasked,
          templateId: input.templateId,
          senderId,
          status: 'skipped',
          errorMessage: reason,
          segments,
          encoding,
          country,
          entityRef: input.entityRef,
        });
        return { status: 'skipped', errorMessage: reason };
      }
    } else if (creditSource === 'marketing_pool') {
      const pool = await this.tryConsumeMarketingPool('sms', segments);
      if (!pool.ok) {
        const reason = `Insufficient marketing pool credits — ${segments} SMS needed`;
        this.logger.warn(`[SMS SKIP] ${mobileMasked}: ${reason}`);
        await this.persistLog({
          workspaceId: wsId,
          firmId,
          mobileMasked,
          templateId: input.templateId,
          senderId,
          status: 'skipped',
          errorMessage: reason,
          segments,
          encoding,
          country,
          entityRef: input.entityRef,
        });
        return { status: 'skipped', errorMessage: reason };
      }
    }
    // creditSource === 'system' falls through with no debit.

    const body: Record<string, unknown> = {
      flow_id: input.templateId,
      sender: senderId,
      mobiles: normalisedMobile,
    };
    // Spread template variables as VAR1, VAR2, ... (MSG91 expects these flat)
    if (input.vars) {
      for (const [k, v] of Object.entries(input.vars)) {
        body[k] = String(v);
      }
    }

    try {
      const response = await fetch(this.msg91Endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authkey: authKey,
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = { raw: responseText };
      }

      // MSG91 success response shape: { type: 'success', message: 'request_id' }
      if (response.ok && parsed?.type === 'success') {
        const providerMessageId = parsed.message || parsed.request_id;
        this.logger.log(
          `[SMS SENT] ${mobileMasked} via template=${input.templateId} segments=${segments} encoding=${encoding} → ${providerMessageId}`,
        );
        await this.persistLog({
          workspaceId: wsId,
          firmId,
          mobileMasked,
          templateId: input.templateId,
          senderId,
          status: 'sent',
          providerMessageId,
          segments,
          encoding,
          country,
          providerCostPaise,
          entityRef: input.entityRef,
        });
        return { status: 'sent', providerMessageId };
      }

      // Failure: HTTP non-2xx OR { type: 'error' }. Wave 8.1 — credit stays
      // debited, ops investigates via admin dashboard, manual refund only.
      const errorMessage =
        parsed?.message ||
        parsed?.error ||
        `MSG91 returned ${response.status}: ${responseText.slice(0, 200)}`;
      const errorCode = normalizeMsg91Error(String(errorMessage));
      this.recordProviderFailure(wsId, segments, errorCode);
      this.logger.error(
        `[SMS FAIL] ${mobileMasked}: ${errorMessage} code=${errorCode}`,
      );
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId,
        senderId,
        status: 'failed',
        errorMessage: String(errorMessage).slice(0, 500),
        errorCode,
        segments,
        encoding,
        country,
        providerCostPaise,
        creditRefunded: false,
        entityRef: input.entityRef,
      });
      return { status: 'failed', errorMessage: String(errorMessage) };
    } catch (err: any) {
      const errorMessage = err?.message ?? 'Unknown SMS dispatch error';
      const errorCode = normalizeMsg91Error(errorMessage);
      this.recordProviderFailure(wsId, segments, errorCode);
      this.logger.error(
        `[SMS ERROR] ${mobileMasked} via template=${input.templateId}: ${errorMessage} code=${errorCode}`,
      );
      await this.persistLog({
        workspaceId: wsId,
        firmId,
        mobileMasked,
        templateId: input.templateId,
        senderId,
        status: 'failed',
        errorMessage: errorMessage.slice(0, 500),
        errorCode,
        segments,
        encoding,
        country,
        providerCostPaise,
        creditRefunded: false,
        entityRef: input.entityRef,
      });
      return { status: 'failed', errorMessage };
    }
  }

  /**
   * Wave 8 — Build a preview string used for segment math. MSG91 substitutes
   * VAR1..VARn into the DLT template at send time; we don't have the DLT
   * template body locally (it lives on MSG91). Best-effort: concatenate the
   * variable values + a stable estimated boilerplate-length pad of 60 chars.
   *
   * If a future enhancement caches the DLT template body (admin-uploaded),
   * swap this for actual substitution. Drift between estimate and actual is
   * caught by Wave-9 monthly reconciler.
   */
  private buildSegmentPreview(input: SendDltSmsInput): string {
    const varValues = input.vars
      ? Object.values(input.vars)
          .map((v) => String(v))
          .join(' ')
      : '';
    const boilerplatePad = 'x'.repeat(60);
    return `${boilerplatePad} ${varValues}`.trim();
  }

  /**
   * Wave 8.1 — record provider failure. NO automatic refund. The consumed
   * credit stays debited; refund (if warranted) goes through the manual
   * admin endpoint. Caller stamps `errorCode` on the dispatch log so ops
   * can investigate via `/admin/communications/cost-margin` refund-queue.
   */
  private recordProviderFailure(
    workspaceId: Types.ObjectId,
    segments: number,
    errorCode: string | undefined,
  ): void {
    this.logger.warn(
      `[SMS FAIL — credit retained] workspace=${workspaceId} segments=${segments} code=${errorCode ?? 'UNKNOWN'}`,
    );
  }

  /**
   * Convenience wrapper — send a payment-reminder SMS using the default
   * configured payment-reminder template (MSG91_PAYMENT_REMINDER_TEMPLATE_ID).
   * Used by reminders dispatcher email/SMS adapter.
   */
  async sendPaymentReminderSms(input: {
    workspaceId: string | Types.ObjectId;
    firmId?: string | Types.ObjectId | null;
    mobile: string;
    partyName: string;
    invoiceNumber: string;
    amountDue: string;
    daysPastDue: number;
    invoiceId?: string | Types.ObjectId;
  }): Promise<SendDltSmsResult> {
    const templateId = this.config.get<string>(
      'app.msg91.paymentReminderTemplateId',
    );
    if (!templateId) {
      this.logger.warn(
        `[SMS SKIP] payment reminder for ${maskMobile(input.mobile)} — MSG91_PAYMENT_REMINDER_TEMPLATE_ID not configured`,
      );
      return {
        status: 'skipped',
        errorMessage: 'paymentReminderTemplateId not configured',
      };
    }
    return this.sendDltSms({
      workspaceId: input.workspaceId,
      firmId: input.firmId,
      mobile: input.mobile,
      templateId,
      vars: {
        VAR1: input.partyName.slice(0, 30), // most DLT templates cap variable length
        VAR2: input.invoiceNumber,
        VAR3: input.amountDue,
        VAR4: String(input.daysPastDue),
      },
      entityRef: input.invoiceId
        ? { id: input.invoiceId, type: 'SaleInvoice' }
        : undefined,
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async persistLog(params: {
    workspaceId: Types.ObjectId;
    firmId: Types.ObjectId | null;
    mobileMasked: string;
    templateId: string;
    senderId?: string;
    status: SmsDispatchStatus;
    providerMessageId?: string;
    errorMessage?: string;
    errorCode?: string;
    segments?: number;
    encoding?: SmsEncoding;
    country?: string;
    providerCostPaise?: number;
    creditRefunded?: boolean;
    refundReason?: string;
    entityRef?: { id: string | Types.ObjectId; type: string };
  }): Promise<void> {
    try {
      const entityRefId = params.entityRef?.id
        ? params.entityRef.id instanceof Types.ObjectId
          ? params.entityRef.id
          : new Types.ObjectId(String(params.entityRef.id))
        : null;
      const segments = params.segments ?? 1;
      // creditsConsumed = segments on success; 0 on skip; 0 if refunded.
      const creditsConsumed =
        params.status === 'sent'
          ? segments
          : params.creditRefunded
            ? 0
            : 0;
      await this.dispatchLogModel.create({
        workspaceId: params.workspaceId,
        firmId: params.firmId,
        mobileMasked: params.mobileMasked,
        provider: 'msg91',
        templateId: params.templateId,
        senderId: params.senderId,
        status: params.status,
        providerMessageId: params.providerMessageId,
        errorMessage: params.errorMessage,
        errorCode: params.errorCode,
        creditsConsumed,
        segments,
        encoding: params.encoding ?? 'GSM7',
        country: params.country ?? 'IN',
        providerCostPaise: params.providerCostPaise ?? 0,
        creditRefunded: params.creditRefunded ?? false,
        refundReason: params.refundReason,
        entityRefId,
        entityRefType: params.entityRef?.type,
      });
    } catch (err: any) {
      // Logging failure must NEVER cascade. Just log and move on.
      this.logger.error(`Failed to persist SMS dispatch log: ${err?.message}`);
    }
  }
}
