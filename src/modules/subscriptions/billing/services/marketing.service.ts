import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { env } from '../../../../config/env';
import { MarketingCampaignDispatch } from '../schemas/marketing-campaign-dispatch.schema';
import { MailService } from '../../../mail/mail.service';
import { AuditAction, AuditLogService } from './audit-log.service';

export type MarketingCampaign =
  | 'trial_reminder'
  | 'trial_ended'
  | 'renewal_notice'
  | 'win_back'
  | 'abandoned_checkout';

interface DispatchArgs {
  userId: string;
  campaign: MarketingCampaign;
  /** Idempotency key — see schema doc for convention. */
  anchorKey: string;
  recipientEmail: string;
  subject: string;
  html: string;
  subscriptionId?: string;
  paymentId?: string;
  metadata?: Record<string, unknown>;
}

interface TrialReminderArgs {
  userId: string;
  subscriptionId: string;
  recipientName: string;
  recipientEmail: string;
  planName: string;
  trialEndsAt: Date;
  daysRemaining: number;
  upgradeUrl: string;
  /**
   * Per-threshold dedup discriminator. The trial reminder now fires a small
   * cadence of nudges (e.g. 5/2/1 days out) rather than one email per cycle.
   * Each nudge dedups on its own threshold so a trial gets ~2-3 nudges total
   * — never a daily barrage. When set, the anchorKey becomes
   * `trial:<subId>:d<thresholdDay>`; when omitted it stays the legacy
   * `trial:<subId>` (one-per-cycle) so existing callers are unaffected.
   */
  thresholdDay?: number;
}

interface TrialEndedNoticeArgs {
  userId: string;
  subscriptionId: string;
  recipientName: string;
  recipientEmail: string;
  planName: string;
  upgradeUrl: string;
}

interface RenewalNoticeArgs {
  userId: string;
  subscriptionId: string;
  recipientName: string;
  recipientEmail: string;
  planName: string;
  currentPeriodEnd: Date;
  daysUntilRenewal: number;
  amountPaise: number;
  manageUrl: string;
}

interface WinBackArgs {
  userId: string;
  subscriptionId: string;
  recipientName: string;
  recipientEmail: string;
  planName: string;
  cancelledAt: Date;
  reactivateUrl: string;
  promoCode?: string;
  promoDescription?: string;
}

interface AbandonedCheckoutArgs {
  userId: string;
  paymentId: string;
  recipientName: string;
  recipientEmail: string;
  planName: string;
  totalPaise: number;
  resumeUrl: string;
}

/**
 * D4 — marketing campaign orchestrator.
 *
 * Each `send*` method is the public entry point a cron calls. The
 * service:
 *   1. Checks the BillingPolicy.marketing toggle.
 *   2. Reserves a dispatch row via unique-index `insertOne` — duplicate
 *      key error means already sent for this anchor; we no-op safely.
 *   3. Composes the HTML and sends via MailService.sendMarketingEmail.
 *   4. Audit-logs the dispatch.
 *   5. On SMTP failure, marks the dispatch row delivered=false (audit
 *      log still fires so the failure is recorded). Caller does NOT
 *      retry — next cron invocation will skip the row because the
 *      dispatch is already reserved.
 *
 * Why reserve-before-send (vs reserve-after): prevents the rare
 * SMTP-then-cron-retry race where the email lands twice. We accept
 * the trade that an SMTP failure may leave the user without that
 * particular email — operationally we'd flip `delivered=false` rows
 * back to active via an admin job if needed.
 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);
  private readonly appUrl: string;

  constructor(
    @InjectModel(MarketingCampaignDispatch.name)
    private readonly dispatchModel: Model<MarketingCampaignDispatch>,
    private readonly mail: MailService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = this.config.get<string>('app.frontendUrl') ?? 'http://localhost:3001';
  }

  // ── Public campaign entry points ─────────────────────────────────

  async sendTrialReminder(args: TrialReminderArgs): Promise<boolean> {
    const subject = `Your ${args.planName} trial ends in ${args.daysRemaining} day${args.daysRemaining === 1 ? '' : 's'}`;
    const html = this.composeTrialReminder(args);
    // Per-threshold dedup: `trial:<subId>:d<thresholdDay>` so each nudge in the
    // cadence sends at most once. Falls back to the legacy one-per-cycle
    // `trial:<subId>` key when no threshold is supplied (keeps old callers
    // working unchanged).
    const anchorKey =
      args.thresholdDay !== undefined
        ? `trial:${args.subscriptionId}:d${args.thresholdDay}`
        : `trial:${args.subscriptionId}`;
    return this.dispatch({
      userId: args.userId,
      campaign: 'trial_reminder',
      anchorKey,
      recipientEmail: args.recipientEmail,
      subject,
      html,
      subscriptionId: args.subscriptionId,
      metadata: {
        trialEndsAt: args.trialEndsAt,
        daysRemaining: args.daysRemaining,
        thresholdDay: args.thresholdDay,
      },
    });
  }

  /**
   * Post-expiry "you're now on Free" notice — fired once, the day after a
   * trial lapses and the account is downgraded. Deduped on
   * `trial-ended:<subId>` so the two callers of `downgradeToBasePlan` (expiry
   * cron + subscription guard) never double-send.
   */
  async sendTrialEndedNotice(args: TrialEndedNoticeArgs): Promise<boolean> {
    const subject = `Your ${args.planName} trial ended — you're now on the Free plan`;
    const html = this.composeTrialEndedNotice(args);
    return this.dispatch({
      userId: args.userId,
      campaign: 'trial_ended',
      anchorKey: `trial-ended:${args.subscriptionId}`,
      recipientEmail: args.recipientEmail,
      subject,
      html,
      subscriptionId: args.subscriptionId,
    });
  }

  async sendRenewalNotice(args: RenewalNoticeArgs): Promise<boolean> {
    const periodStamp = args.currentPeriodEnd.getTime();
    const subject = `Your ${args.planName} subscription renews in ${args.daysUntilRenewal} day${args.daysUntilRenewal === 1 ? '' : 's'}`;
    const html = this.composeRenewalNotice(args);
    return this.dispatch({
      userId: args.userId,
      campaign: 'renewal_notice',
      anchorKey: `renewal:${args.subscriptionId}:${periodStamp}`,
      recipientEmail: args.recipientEmail,
      subject,
      html,
      subscriptionId: args.subscriptionId,
      metadata: {
        currentPeriodEnd: args.currentPeriodEnd,
        amountPaise: args.amountPaise,
      },
    });
  }

  async sendWinBack(args: WinBackArgs): Promise<boolean> {
    const cancelStamp = args.cancelledAt.getTime();
    const subject = args.promoCode
      ? `Come back — ${args.promoDescription ?? 'special offer inside'}`
      : `We miss you at ManekHR`;
    const html = this.composeWinBack(args);
    return this.dispatch({
      userId: args.userId,
      campaign: 'win_back',
      anchorKey: `winback:${args.subscriptionId}:${cancelStamp}`,
      recipientEmail: args.recipientEmail,
      subject,
      html,
      subscriptionId: args.subscriptionId,
      metadata: {
        cancelledAt: args.cancelledAt,
        promoCode: args.promoCode,
      },
    });
  }

  async sendAbandonedCheckout(args: AbandonedCheckoutArgs): Promise<boolean> {
    const subject = `Finish setting up your ${args.planName} subscription`;
    const html = this.composeAbandonedCheckout(args);
    return this.dispatch({
      userId: args.userId,
      campaign: 'abandoned_checkout',
      anchorKey: `abandoned:${args.paymentId}`,
      recipientEmail: args.recipientEmail,
      subject,
      html,
      paymentId: args.paymentId,
      metadata: {
        totalPaise: args.totalPaise,
      },
    });
  }

  // ── Core dispatch (reserve → send → audit) ───────────────────────

  private async dispatch(args: DispatchArgs): Promise<boolean> {
    if (!args.recipientEmail) {
      this.logger.warn(`Skipping ${args.campaign} for user ${args.userId} — no recipientEmail`);
      return false;
    }

    // Reserve the slot atomically. Unique-index collision = already sent.
    let reserved: MarketingCampaignDispatch | null = null;
    try {
      reserved = await this.dispatchModel.create({
        userId: new Types.ObjectId(args.userId),
        campaign: args.campaign,
        anchorKey: args.anchorKey,
        recipientEmail: args.recipientEmail,
        subscriptionId: args.subscriptionId ? new Types.ObjectId(args.subscriptionId) : undefined,
        paymentId: args.paymentId ? new Types.ObjectId(args.paymentId) : undefined,
        metadata: args.metadata,
        delivered: true,
      });
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string };
      if (err?.code === 11000) {
        // Duplicate key — already sent. Idempotent no-op.
        return false;
      }
      this.logger.error(
        `Failed to reserve dispatch slot for ${args.campaign} user=${args.userId}: ${err.message}`,
      );
      return false;
    }

    // Send the email. If SMTP fails, flip delivered=false but keep the
    // reservation row so cron doesn't retry endlessly.
    try {
      await this.mail.sendMarketingEmail({
        to: args.recipientEmail,
        subject: args.subject,
        html: args.html,
        campaign: args.campaign,
      });
    } catch (e) {
      const err = e as { message?: string };
      this.logger.error(`SMTP failed for ${args.campaign} user=${args.userId}: ${err.message}`);
      await this.dispatchModel
        .updateOne({ _id: reserved._id }, { $set: { delivered: false } })
        .exec();
      return false;
    }

    // Audit log (best-effort).
    const auditAction = this.auditActionFor(args.campaign);
    await this.audit.log({
      action: auditAction,
      actorType: 'system',
      targetUserId: args.userId,
      subscriptionId: args.subscriptionId,
      paymentId: args.paymentId,
      metadata: {
        anchorKey: args.anchorKey,
        recipientEmail: args.recipientEmail,
        ...args.metadata,
      },
    });

    return true;
  }

  private auditActionFor(campaign: MarketingCampaign): string {
    switch (campaign) {
      case 'trial_reminder':
        return AuditAction.SystemMarketingTrialReminderSent;
      case 'trial_ended':
        return AuditAction.SystemMarketingTrialEndedSent;
      case 'renewal_notice':
        return AuditAction.SystemMarketingRenewalNoticeSent;
      case 'win_back':
        return AuditAction.SystemMarketingWinBackSent;
      case 'abandoned_checkout':
        return AuditAction.SystemMarketingAbandonedCheckoutSent;
    }
  }

  // ── Templates ────────────────────────────────────────────────────

  private composeTrialReminder(args: TrialReminderArgs): string {
    const dayLabel = args.daysRemaining === 1 ? 'tomorrow' : `in ${args.daysRemaining} days`;
    return wrapEmail(
      `Your trial ends ${dayLabel}`,
      `
      <p>Hi ${escape(args.recipientName)},</p>
      <p>Your <strong>${escape(args.planName)}</strong> free trial ends ${dayLabel}
      (${args.trialEndsAt.toLocaleDateString('en-IN', { dateStyle: 'medium' })}).</p>
      <p>Add a payment method now to keep your data, members, and history.</p>
      <p style="margin: 24px 0;">
        <a href="${args.upgradeUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Add payment method</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">If you don't act, your account will move to read-only at trial end.</p>
      `,
    );
  }

  private composeTrialEndedNotice(args: TrialEndedNoticeArgs): string {
    return wrapEmail(
      `You're now on the Free plan`,
      `
      <p>Hi ${escape(args.recipientName)},</p>
      <p>Your <strong>${escape(args.planName)}</strong> full-access trial has ended —
      your account is now on the <strong>Free plan</strong>. Nothing was deleted; your
      data is safe.</p>
      <p>Upgrade any time to use your whole team and unlock the modules and limits you
      had during the trial.</p>
      <p style="margin: 24px 0;">
        <a href="${args.upgradeUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Upgrade your plan</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Questions about which plan fits? Reply to this email — we're happy to help.</p>
      `,
    );
  }

  private composeRenewalNotice(args: RenewalNoticeArgs): string {
    const dayLabel = args.daysUntilRenewal === 1 ? 'tomorrow' : `in ${args.daysUntilRenewal} days`;
    const amount = `₹${(args.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    return wrapEmail(
      `Your subscription renews ${dayLabel}`,
      `
      <p>Hi ${escape(args.recipientName)},</p>
      <p>Your <strong>${escape(args.planName)}</strong> subscription will renew ${dayLabel}
      (${args.currentPeriodEnd.toLocaleDateString('en-IN', { dateStyle: 'medium' })}) for <strong>${amount}</strong>.</p>
      <p>No action needed — we'll automatically charge your saved payment method.</p>
      <p style="margin: 24px 0;">
        <a href="${args.manageUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Manage subscription</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Want to change plans, pause, or cancel? Visit Subscription settings before renewal.</p>
      `,
    );
  }

  private composeWinBack(args: WinBackArgs): string {
    const promoBlock = args.promoCode
      ? `<div style="margin: 24px 0; padding: 16px; background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 8px; text-align: center;">
          <p style="margin: 0 0 4px; color: #1e40af; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Welcome back offer</p>
          <p style="margin: 0; font-size: 24px; font-weight: bold; color: #1e3a8a;">${escape(args.promoCode)}</p>
          ${args.promoDescription ? `<p style="margin: 8px 0 0; color: #1e40af; font-size: 14px;">${escape(args.promoDescription)}</p>` : ''}
        </div>`
      : '';
    return wrapEmail(
      `We miss you at ManekHR`,
      `
      <p>Hi ${escape(args.recipientName)},</p>
      <p>It's been a couple of weeks since your <strong>${escape(args.planName)}</strong> subscription ended on
      ${args.cancelledAt.toLocaleDateString('en-IN', { dateStyle: 'medium' })}.</p>
      <p>Your data is safe — pick up exactly where you left off whenever you're ready.</p>
      ${promoBlock}
      <p style="margin: 24px 0;">
        <a href="${args.reactivateUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Reactivate subscription</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Got feedback that would bring you back? Hit reply — we read every email.</p>
      `,
    );
  }

  private composeAbandonedCheckout(args: AbandonedCheckoutArgs): string {
    const amount = `₹${(args.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    return wrapEmail(
      `Finish setting up ${args.planName}`,
      `
      <p>Hi ${escape(args.recipientName)},</p>
      <p>You started checking out <strong>${escape(args.planName)}</strong> (${amount}) but didn't finish.
      We're holding your spot — pick up where you left off.</p>
      <p style="margin: 24px 0;">
        <a href="${args.resumeUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Complete checkout</a>
      </p>
      <p style="color: #6b7280; font-size: 13px;">Run into a problem? Reply to this email and we'll help you finish in minutes.</p>
      `,
    );
  }

  // ── Helpers usable by crons ──────────────────────────────────────

  /** Convenience builder so callers don't repeat the appUrl. */
  buildAppUrl(path: string): string {
    if (path.startsWith('http')) return path;
    const base = this.appUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }
}

// ── Email shell ────────────────────────────────────────────────────

function wrapEmail(headline: string, body: string): string {
  const r2Base = env.branding.r2PublicUrl.replace(/\/$/, '');
  const headerUrl =
    env.branding.emailHeaderUrl || (r2Base ? `${r2Base}/brand/email-header.png` : '');
  const headerImg = headerUrl
    ? `<div style="text-align: center; margin: 0 0 24px;"><img src="${headerUrl}" alt="ManekHR" style="max-width: 240px; height: auto; border: 0; outline: none; text-decoration: none;" /></div>`
    : '';
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111827;">
  ${headerImg}
  <h2 style="font-size: 20px; font-weight: 800; margin: 0 0 16px; color: #111827;">${escape(headline)}</h2>
  <div style="font-size: 15px; line-height: 1.6;">${body}</div>
  <hr style="margin: 32px 0; border: none; border-top: 1px solid #e5e7eb;" />
  <p style="font-size: 12px; color: #9ca3af; margin: 0;">ManekHR — staff and salary, made simple</p>
</body></html>`;
}

function escape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
