import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { Subscription } from '../../schemas/subscription.schema';
import { Plan } from '../../schemas/plan.schema';
import { User } from '../../../users/schemas/user.schema';
import { BillingPolicyService } from './billing-policy.service';
import { MailService } from '../../../mail/mail.service';
import { AuditAction, AuditLogService } from './audit-log.service';

export const DUNNING_QUEUE = 'billing-dunning';

export interface DunningJobData {
  type: 'grace_reminder' | 'grace_expiry';
  subscriptionId: string;
  /**
   * Stamp of the gracePeriodUntil at the time the job was scheduled.
   * The processor re-reads the subscription and skips the job if the
   * stamp no longer matches — handles the case where the user paid
   * mid-grace and a new grace period started later for a separate
   * failure (the old job is now stale).
   */
  gracePeriodUntilStamp: number;
}

interface DunningStatus {
  subscriptionId: string;
  status: string;
  inDunning: boolean;
  inGracePeriod: boolean;
  gracePeriodUntil?: Date;
  daysRemaining?: number;
  failedPaymentAttempts: number;
  isReadOnly: boolean;
  showContactSalesCta: boolean;
  salesContact?: { email?: string; phone?: string };
  paymentRecoveryUrl?: string;
}

/**
 * Failed-payment dunning + grace-period orchestrator (D1g).
 *
 * Flow on `subscription.halted` (Razorpay has exhausted its retry
 * attempts):
 *   1. `enterGrace(subscriptionId)` — set status='grace_period',
 *      stamp `gracePeriodUntil = now + policy.gracePeriod.durationDays`,
 *      send "your payment failed" email with CTA to update mandate,
 *      schedule a reminder 1 day before grace expires, schedule the
 *      grace-expiry job at `gracePeriodUntil`.
 *   2. During grace: `SubscriptionGuard` blocks non-GET requests when
 *      `policy.gracePeriod.readOnlyMode=true` (default). Reads stay
 *      open so the user can see the dunning state + recovery CTA.
 *   3. On `subscription.charged`: if status was `grace_period` →
 *      `recoverFromGrace(subscriptionId)` clears the grace stamp,
 *      flips back to `active`, sends "you're back on track" email.
 *   4. On grace-expiry job firing: `expireGrace(subscriptionId)` flips
 *      to `expired`, sends final "subscription expired" email.
 *
 * Idempotency: every transition is guarded by status filters
 * (`grace_period` → only enter from non-grace; recovery → only from
 * `grace_period`; expiry → only from `grace_period`). Replays are no-ops.
 *
 * Stale-job defence: scheduled jobs carry a `gracePeriodUntilStamp`.
 * The processor re-reads the subscription; if the stamp no longer
 * matches the current `gracePeriodUntil`, the job is skipped. Catches
 * the recovery-then-re-enter-grace race without manual job cancel.
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectQueue(DUNNING_QUEUE) private readonly queue: Queue<DunningJobData>,
    @Inject(forwardRef(() => BillingPolicyService))
    private readonly policyService: BillingPolicyService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly audit: AuditLogService,
  ) {}

  // ── webhook entry points ────────────────────────────────────────────

  /**
   * Razorpay halted the subscription after exhausting retries. Move
   * the subscription into the local grace period.
   */
  async enterGrace(subscriptionId: string): Promise<void> {
    const policy = await this.policyService.getPolicy();
    const graceDays = policy.gracePeriod?.durationDays ?? 7;
    const gracePeriodUntil = new Date(
      Date.now() + graceDays * 24 * 60 * 60 * 1000,
    );

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(subscriptionId),
          status: { $nin: ['cancelled', 'expired', 'superseded'] },
        },
        {
          $set: {
            status: 'grace_period',
            gracePeriodUntil,
          },
          $inc: { failedPaymentAttempts: 1 },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      this.logger.log(
        `Skip enterGrace — subscription ${subscriptionId} not in eligible state`,
      );
      return;
    }

    await this.scheduleDunningJobs(updated, gracePeriodUntil);
    await this.sendPaymentFailedEmail(updated, gracePeriodUntil).catch(
      (err) =>
        this.logger.warn(
          `enterGrace email failed sub=${updated._id} err=${(err as Error).message}`,
        ),
    );

    this.logger.log(
      `Subscription ${updated._id} entered grace_period until ${gracePeriodUntil.toISOString()}`,
    );
    await this.audit.log({
      action: AuditAction.SystemDunningGraceEntered,
      actorType: 'system',
      targetUserId: String(updated.userId),
      subscriptionId: String(updated._id),
      metadata: {
        gracePeriodUntil,
        graceDays,
        failedPaymentAttempts: updated.failedPaymentAttempts,
      },
    });
  }

  /**
   * Recovery path — Razorpay charged successfully while the
   * subscription was in grace. Clear the grace stamp, flip back to
   * active, send a confirmation email. Stale scheduled jobs are
   * neutralised by the processor's `gracePeriodUntilStamp` check.
   *
   * Use this entry when the caller has NOT already flipped status →
   * `recoverFromGraceAfterCharge` is the variant the webhook uses
   * because the charged-event handler does the status flip itself.
   */
  async recoverFromGrace(subscriptionId: string): Promise<void> {
    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(subscriptionId),
          status: { $in: ['grace_period', 'past_due'] },
        },
        {
          $set: {
            status: 'active',
            failedPaymentAttempts: 0,
          },
          $unset: { gracePeriodUntil: '' },
        },
        { new: true },
      )
      .exec();
    if (!updated) return;

    await this.sendRecoveryEmail(updated).catch((err) =>
      this.logger.warn(
        `Recovery email failed sub=${updated._id} err=${(err as Error).message}`,
      ),
    );
    this.logger.log(`Subscription ${updated._id} recovered from grace_period`);
    await this.audit.log({
      action: AuditAction.SystemDunningRecovered,
      actorType: 'system',
      targetUserId: String(updated.userId),
      subscriptionId: String(updated._id),
    });
  }

  /**
   * Notify-only recovery — used by `subscription.charged` webhook
   * handler which has already flipped the local status to `active`
   * + cleared `gracePeriodUntil` + reset `failedPaymentAttempts` as
   * part of its period-extension logic. We just need to send the
   * email here. Stale scheduled jobs are auto-neutralised by the
   * processor's `gracePeriodUntilStamp` check.
   */
  async notifyRecovery(subscriptionId: string): Promise<void> {
    const sub = await this.subscriptionModel
      .findById(subscriptionId)
      .exec();
    if (!sub) return;
    await this.sendRecoveryEmail(sub).catch((err) =>
      this.logger.warn(
        `Recovery notify failed sub=${sub._id} err=${(err as Error).message}`,
      ),
    );
    this.logger.log(`Subscription ${sub._id} recovery notification sent`);
    await this.audit.log({
      action: AuditAction.SystemDunningRecovered,
      actorType: 'system',
      targetUserId: String(sub.userId),
      subscriptionId: String(sub._id),
      metadata: { trigger: 'webhook_subscription_charged' },
    });
  }

  // ── processor entry points ──────────────────────────────────────────

  /**
   * Scheduled reminder fire — sends "X days remaining in your grace
   * period" email if the subscription is still in grace AND the stamp
   * matches.
   */
  async dispatchReminder(job: DunningJobData): Promise<void> {
    const sub = await this.fetchIfStampValid(job);
    if (!sub) return;
    await this.sendGraceReminderEmail(sub);
  }

  /**
   * Scheduled grace-expiry fire — flip to `expired` if still in grace
   * AND the stamp matches. Send final notice email.
   */
  async dispatchExpiry(job: DunningJobData): Promise<void> {
    const sub = await this.fetchIfStampValid(job);
    if (!sub) return;

    const expired = await this.subscriptionModel
      .findOneAndUpdate(
        {
          _id: sub._id,
          status: 'grace_period',
          gracePeriodUntil: { $lte: new Date() },
        },
        { $set: { status: 'expired' } },
        { new: true },
      )
      .exec();
    if (!expired) return;

    await this.sendExpiredEmail(expired).catch((err) =>
      this.logger.warn(
        `Expiry email failed sub=${expired._id} err=${(err as Error).message}`,
      ),
    );
    this.logger.log(`Subscription ${expired._id} expired after grace period`);
    await this.audit.log({
      action: AuditAction.SystemDunningGraceExpired,
      actorType: 'system',
      targetUserId: String(expired.userId),
      subscriptionId: String(expired._id),
    });
  }

  // ── self-serve status ───────────────────────────────────────────────

  async getStatusForUser(userId: string): Promise<DunningStatus | null> {
    const sub = await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: { $in: ['active', 'past_due', 'grace_period', 'trial'] },
      })
      .sort({ createdAt: -1 })
      .exec();
    if (!sub) return null;

    const policy = await this.policyService.getPolicy();
    const inGrace = sub.status === 'grace_period';
    const inDunning = inGrace || sub.status === 'past_due';

    let daysRemaining: number | undefined;
    if (inGrace && sub.gracePeriodUntil) {
      const diffMs = sub.gracePeriodUntil.getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    }

    return {
      subscriptionId: String(sub._id),
      status: sub.status,
      inDunning,
      inGracePeriod: inGrace,
      gracePeriodUntil: sub.gracePeriodUntil,
      daysRemaining,
      failedPaymentAttempts: sub.failedPaymentAttempts ?? 0,
      isReadOnly: inGrace && (policy.gracePeriod?.readOnlyMode ?? true),
      showContactSalesCta:
        inDunning && (policy.gracePeriod?.showContactSalesCta ?? true),
      salesContact:
        policy.salesContactEmail || policy.salesContactPhone
          ? {
              email: policy.salesContactEmail,
              phone: policy.salesContactPhone,
            }
          : undefined,
      paymentRecoveryUrl: inDunning
        ? '/api/subscriptions/checkout/mandate'
        : undefined,
    };
  }

  // ── internals ───────────────────────────────────────────────────────

  private async scheduleDunningJobs(
    sub: Subscription,
    gracePeriodUntil: Date,
  ): Promise<void> {
    const stamp = gracePeriodUntil.getTime();
    const now = Date.now();
    const reminderAt = stamp - 24 * 60 * 60 * 1000; // 1 day before expiry
    const reminderDelay = Math.max(0, reminderAt - now);
    const expiryDelay = Math.max(0, stamp - now);

    await this.queue.add(
      'grace_reminder',
      {
        type: 'grace_reminder',
        subscriptionId: String(sub._id),
        gracePeriodUntilStamp: stamp,
      },
      {
        delay: reminderDelay,
        // Per-subscription job id ensures replay-safe enqueue — if a
        // second halted event fires for the same sub at the same stamp
        // we don't double-schedule.
        jobId: `reminder-${sub._id}-${stamp}`,
        removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    );

    await this.queue.add(
      'grace_expiry',
      {
        type: 'grace_expiry',
        subscriptionId: String(sub._id),
        gracePeriodUntilStamp: stamp,
      },
      {
        delay: expiryDelay,
        jobId: `expiry-${sub._id}-${stamp}`,
        removeOnComplete: { age: 30 * 24 * 3600, count: 1000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    );
  }

  private async fetchIfStampValid(
    job: DunningJobData,
  ): Promise<Subscription | null> {
    const sub = await this.subscriptionModel
      .findById(job.subscriptionId)
      .exec();
    if (!sub) return null;
    if (sub.status !== 'grace_period') return null;
    const currentStamp = sub.gracePeriodUntil?.getTime() ?? 0;
    if (currentStamp !== job.gracePeriodUntilStamp) {
      this.logger.log(
        `Skip stale dunning job sub=${sub._id} expectedStamp=${job.gracePeriodUntilStamp} actualStamp=${currentStamp}`,
      );
      return null;
    }
    return sub;
  }

  // ── emails ──────────────────────────────────────────────────────────

  private async fetchEmailContext(sub: Subscription) {
    const [user, plan, policy] = await Promise.all([
      this.userModel.findById(sub.userId).select('name email').exec(),
      this.planModel.findById(sub.planId).select('name').exec(),
      this.policyService.getPolicy(),
    ]);
    if (!user?.email) return null;
    const supplierName =
      this.configService.get<string>('app.platformLegalEntity.name') ??
      'ManekHR';
    const frontendUrl =
      this.configService.get<string>('app.frontendUrl') ??
      'https://app.manekhr.in';
    return { user, plan, policy, supplierName, frontendUrl };
  }

  private async sendPaymentFailedEmail(
    sub: Subscription,
    gracePeriodUntil: Date,
  ): Promise<void> {
    const ctx = await this.fetchEmailContext(sub);
    if (!ctx) return;
    const { user, plan, policy, supplierName, frontendUrl } = ctx;
    const graceDays = policy.gracePeriod?.durationDays ?? 7;
    const cta = `${frontendUrl}/dashboard/subscription`;
    const salesCta =
      policy.gracePeriod?.showContactSalesCta && policy.salesContactEmail
        ? `<p>For high-volume accounts, our sales team can help: <a href="mailto:${policy.salesContactEmail}">${policy.salesContactEmail}</a>${policy.salesContactPhone ? ' · ' + policy.salesContactPhone : ''}.</p>`
        : '';

    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #b91c1c;">Your payment didn't go through</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>We tried to renew your <strong>${plan?.name ?? 'subscription'}</strong>
           plan but the payment couldn't be collected.</p>
        <p>You have a <strong>${graceDays}-day grace period</strong> to update
           your payment method before access is suspended. Grace period ends
           on <strong>${gracePeriodUntil.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</strong>.</p>
        <p>
          <a href="${cta}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
            Update payment method
          </a>
        </p>
        ${salesCta}
        <p style="color:#666;font-size:13px;margin-top:24px;">
          This is an automated billing notification from ${supplierName}.
        </p>
      </div>
    `;

    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `Action required: payment failed for ${plan?.name ?? 'your subscription'}`,
      html,
    });
  }

  private async sendGraceReminderEmail(sub: Subscription): Promise<void> {
    const ctx = await this.fetchEmailContext(sub);
    if (!ctx) return;
    const { user, plan, supplierName, frontendUrl } = ctx;
    const cta = `${frontendUrl}/dashboard/subscription`;
    const expiresOn = sub.gracePeriodUntil
      ? sub.gracePeriodUntil.toLocaleDateString('en-IN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : 'tomorrow';

    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #b91c1c;">Last chance: 24 hours to update payment</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>Your <strong>${plan?.name ?? 'subscription'}</strong> grace period
           ends on <strong>${expiresOn}</strong>. After that your account will
           be suspended until payment is restored.</p>
        <p>
          <a href="${cta}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
            Update payment method now
          </a>
        </p>
        <p style="color:#666;font-size:13px;margin-top:24px;">
          ${supplierName} billing.
        </p>
      </div>
    `;

    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `Final reminder: ${plan?.name ?? 'subscription'} grace period ending`,
      html,
    });
  }

  private async sendExpiredEmail(sub: Subscription): Promise<void> {
    const ctx = await this.fetchEmailContext(sub);
    if (!ctx) return;
    const { user, plan, supplierName, frontendUrl, policy } = ctx;
    const cta = `${frontendUrl}/dashboard/subscription`;
    const salesCta =
      policy.gracePeriod?.showContactSalesCta && policy.salesContactEmail
        ? `<p>Need help reactivating? Our team can assist: <a href="mailto:${policy.salesContactEmail}">${policy.salesContactEmail}</a></p>`
        : '';

    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #b91c1c;">Your subscription has been suspended</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>Your <strong>${plan?.name ?? 'subscription'}</strong> grace period
           has ended without a successful payment. Your account is now
           read-only.</p>
        <p>You can reactivate at any time:</p>
        <p>
          <a href="${cta}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
            Reactivate subscription
          </a>
        </p>
        ${salesCta}
        <p style="color:#666;font-size:13px;margin-top:24px;">
          ${supplierName} billing.
        </p>
      </div>
    `;

    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `${plan?.name ?? 'Subscription'} suspended — reactivate any time`,
      html,
    });
  }

  private async sendRecoveryEmail(sub: Subscription): Promise<void> {
    const ctx = await this.fetchEmailContext(sub);
    if (!ctx) return;
    const { user, plan, supplierName, frontendUrl } = ctx;
    const cta = `${frontendUrl}/dashboard/subscription`;

    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a;">Payment received — you're back on track</h2>
        <p>Hi${user.name ? ' ' + user.name : ''},</p>
        <p>Thanks — your payment for the <strong>${plan?.name ?? 'subscription'}</strong>
           plan came through and your account is active again.</p>
        <p>
          <a href="${cta}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
            View subscription
          </a>
        </p>
        <p style="color:#666;font-size:13px;margin-top:24px;">
          ${supplierName} billing.
        </p>
      </div>
    `;

    await this.mailService.sendBillingDunningEmail({
      to: user.email!,
      subject: `You're all set — ${plan?.name ?? 'subscription'} reactivated`,
      html,
    });
  }
}
