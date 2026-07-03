import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MailerService } from '@nestjs-modules/mailer';
import * as nodemailer from 'nodemailer';
import { env } from '../../config/env';
import { Workspace } from '../workspaces/schemas/workspace.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';

/**
 * Quota check result. `allowed: false` lets fire-and-forget callers
 * skip the send without throwing (use enforceEmailQuota when you want
 * a hard failure instead).
 */
export interface EmailQuotaResult {
  allowed: boolean;
  reason?: string;
  effectiveLimit: number;
  currentCount: number;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly webAppUrl: string;
  private readonly monthLabels = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ] as const;

  constructor(
    private mailerService: MailerService,
    private configService: ConfigService,
    @InjectModel(Workspace.name) private workspaceModel: Model<Workspace>,
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<Subscription>,
  ) {
    this.webAppUrl = this.configService.get<string>('app.webAppUrl') || 'https://app.manekhr.in';

    // Auto-inject brand asset URLs into every Handlebars template render.
    // Templates reference `{{brand.emailHeader}}`, `{{brand.emailSignature}}`,
    // etc. — values resolved from `branding.config.ts` (R2-backed).
    type SendMailOpts = { context?: Record<string, unknown>; [k: string]: unknown };
    type MailerLike = { sendMail: (opts: SendMailOpts) => Promise<unknown> };
    const mailerLike = this.mailerService as unknown as MailerLike;
    const originalSend = mailerLike.sendMail.bind(mailerLike) as (
      opts: SendMailOpts,
    ) => Promise<unknown>;
    mailerLike.sendMail = (opts: SendMailOpts) =>
      originalSend({
        ...opts,
        context: { brand: this.getBrandContext(), ...(opts.context ?? {}) },
      });
  }

  private getBrandContext() {
    return {
      name: 'ManekHR',
      webAppUrl: this.webAppUrl,
      emailHeader: this.configService.get<string>('branding.emailHeader') || '',
      emailSignature: this.configService.get<string>('branding.emailSignature') || '',
      taglineInline: this.configService.get<string>('branding.taglineInline') || '',
      taglineStacked: this.configService.get<string>('branding.taglineStacked') || '',
      taglineEditorial: this.configService.get<string>('branding.taglineEditorial') || '',
    };
  }

  // ── Quota helpers (Wave-3 Drift #32 — universal mail enforcement) ─────────────
  // All mail-sending callers SHOULD invoke these helpers BEFORE actually sending,
  // to centralise enforcement of `entitlements.emailsPerMonth` from the workspace
  // owner's subscription. System mails (signup verification, password reset)
  // are EXEMPT — call sites for those skip the check.

  private currentMonthKey(): string {
    return new Date().toISOString().slice(0, 7);
  }

  /**
   * Check email quota without throwing. Returns { allowed, reason, ... }.
   * Use this for fire-and-forget callers that want to skip silently when over quota.
   */
  async checkEmailQuota(workspaceId: string | Types.ObjectId): Promise<EmailQuotaResult> {
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(workspaceId);

    const workspace = await this.workspaceModel
      .findById(wsObjectId)
      .select('ownerId emailConfig')
      .lean()
      .exec();

    if (!workspace) {
      return {
        allowed: false,
        reason: 'Workspace not found',
        effectiveLimit: 0,
        currentCount: 0,
      };
    }

    type EmailUsage = { monthKey?: string; count?: number };
    type EmailConfig = {
      emailLimitOverride?: number | null;
      usage?: EmailUsage;
    };
    type AppliedEntitlements = { emailsPerMonth?: number };
    const wsAny = workspace as { emailConfig?: EmailConfig; ownerId?: unknown };
    const emailLimitOverride = wsAny.emailConfig?.emailLimitOverride ?? null;
    let effectiveLimit = 0;

    if (emailLimitOverride !== null) {
      effectiveLimit = emailLimitOverride;
    } else if (workspace.ownerId) {
      const ownerObjectId =
        workspace.ownerId instanceof Types.ObjectId
          ? workspace.ownerId
          : new Types.ObjectId(workspace.ownerId as string);
      const sub = await this.subscriptionModel
        .findOne({ userId: ownerObjectId, status: { $in: ['active', 'trial'] } })
        .select('appliedEntitlements.emailsPerMonth')
        .lean()
        .exec();
      const applied = sub?.appliedEntitlements as AppliedEntitlements | undefined;
      effectiveLimit = applied?.emailsPerMonth ?? 0;
    }

    // -1 (or any negative) treated as unlimited per existing convention
    if (effectiveLimit < 0) {
      return {
        allowed: true,
        effectiveLimit: -1,
        currentCount: 0,
      };
    }

    // 0 = no quota configured; deny to surface mis-config (matches old salary.service behaviour)
    const usage = wsAny.emailConfig?.usage;
    const monthKey = this.currentMonthKey();
    const currentCount = usage?.monthKey === monthKey ? (usage.count ?? 0) : 0;

    if (effectiveLimit === 0) {
      return {
        allowed: false,
        reason: 'No email quota configured for this workspace',
        effectiveLimit: 0,
        currentCount,
      };
    }

    if (currentCount >= effectiveLimit) {
      return {
        allowed: false,
        reason: `Monthly email limit reached (${effectiveLimit})`,
        effectiveLimit,
        currentCount,
      };
    }

    return {
      allowed: true,
      effectiveLimit,
      currentCount,
    };
  }

  /**
   * Throw ForbiddenException if quota exceeded. Use this for user-initiated
   * mail sends where a hard failure (with HTTP 403) is preferred.
   */
  async enforceEmailQuota(workspaceId: string | Types.ObjectId): Promise<void> {
    const result = await this.checkEmailQuota(workspaceId);
    if (!result.allowed) {
      throw new ForbiddenException({
        message: result.reason || 'Email quota exceeded',
        code: 'EMAIL_QUOTA_EXCEEDED',
        effectiveLimit: result.effectiveLimit,
        currentCount: result.currentCount,
      });
    }
  }

  /**
   * Increment email-usage counter for the workspace. Call AFTER a successful
   * send. Resets to 1 if month boundary crossed.
   */
  async incrementEmailUsage(workspaceId: string | Types.ObjectId): Promise<void> {
    const wsObjectId =
      workspaceId instanceof Types.ObjectId ? workspaceId : new Types.ObjectId(workspaceId);
    const monthKey = this.currentMonthKey();

    // Try to increment within the current month first
    const incResult = await this.workspaceModel.updateOne(
      { _id: wsObjectId, 'emailConfig.usage.monthKey': monthKey },
      { $inc: { 'emailConfig.usage.count': 1 } },
    );

    if (incResult.modifiedCount === 0) {
      // Month rolled over (or first ever send) — reset counter to 1
      await this.workspaceModel.updateOne(
        { _id: wsObjectId },
        {
          $set: {
            'emailConfig.usage.count': 1,
            'emailConfig.usage.monthKey': monthKey,
          },
        },
      );
    }
  }

  private getMonthLabel(month: number): string {
    return this.monthLabels[month - 1] || `Month ${month}`;
  }

  /**
   * Send a verification email using a handlebar template
   */
  async sendUserVerificationEmail(user: { email: string; name: string }, token: string) {
    try {
      this.logger.log(`Sending verification email to ${user.email}...`);

      // Mock output to console for local development (if no SMTP is actually configured)
      this.logger.log(`\n\n========== 📧 EMAIL DISPATCH ==========`);
      this.logger.log(`To: ${user.email}`);
      this.logger.log(`Template: email-verification`);
      this.logger.log(`Token Data: ${token}`);
      this.logger.log(`=======================================\n\n`);

      const result = (await this.mailerService.sendMail({
        to: user.email,
        subject: 'Welcome to ManekHR! Confirm your Email',
        template: './email-verification', // `.hbs` extension is appended automatically
        context: {
          name: user.name,
          token: token,
          // Example front-end URL that your app router catches
          verificationUrl: `zari360://verify-email?token=${token}`,
        },
      })) as { messageId?: string };

      this.logger.log(`Email sent successfully: ${result?.messageId}`);
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send verification email: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      // Un-commenting throw so that the Frontend receives the error if SMTP is misconfigured
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Send a 6-digit registration OTP to the email address the user just typed
   * in SignupMode. Mirrors the SMS-OTP register flow — the OTP gates account
   * creation, so we throw on SMTP failure for the caller to surface as a
   * "could not send" error (no anti-enumeration concern at template level —
   * the AuthService caller decides whether to silent-success).
   */
  async sendEmailRegistrationOtp(to: string, otp: string, expiresInMinutes: number): Promise<void> {
    try {
      this.logger.log(`Sending registration OTP to ${to}...`);
      const result = (await this.mailerService.sendMail({
        to,
        subject: `Your ManekHR verification code: ${otp}`,
        template: './email-registration-otp',
        context: {
          otp,
          expiresInMinutes,
        },
      })) as { messageId?: string };
      this.logger.log(`Registration OTP email sent: ${result?.messageId}`);
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send registration OTP to ${to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Send a password-reset email containing a single-use reset link. Called
   * by `AuthService.forgotPassword` after the raw token has been bcrypt-hashed
   * and persisted on `User.resetPasswordTokenHash` with a 15-min expiry.
   *
   * The reset URL points at the web reset page (`/auth/reset-password`); the
   * page POSTs to `/auth/reset-password` with the unhashed token. Mobile-app
   * users do not currently use the email-forgot flow (they have the SMS-OTP
   * forgot flow instead), so we don't ship a `zari360://` deep link here.
   *
   * Throws on SMTP failure so the caller can decide how to handle it. The
   * forgot-password caller swallows + audits to preserve anti-enumeration
   * (the user must never be able to tell whether their email exists from a
   * delivery error).
   */
  async sendPasswordResetEmail(
    user: { email: string; name: string },
    resetToken: string,
  ): Promise<void> {
    const resetUrl = `${this.webAppUrl}/auth/reset-password?token=${encodeURIComponent(resetToken)}`;
    try {
      this.logger.log(`Sending password reset to ${user.email}...`);
      const result = (await this.mailerService.sendMail({
        to: user.email,
        subject: 'Reset your ManekHR password',
        template: './password-reset',
        context: {
          name: user.name,
          resetUrl,
          // 15 min — mirrors AuthService.forgotPassword's persisted expiry.
          expiresInMinutes: 15,
        },
      })) as { messageId?: string };
      this.logger.log(`Password reset email sent: ${result?.messageId}`);
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send password reset email to ${user.email}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Send workspace invitation email
   */
  async sendWorkspaceInvitationEmail(
    to: string,
    context: {
      inviterName: string;
      workspaceName: string;
      workspaceType?: string;
      role: string;
      inviteUrl: string;
      mobileDeepLink: string;
      expiryDays: number;
    },
  ) {
    try {
      this.logger.log(`Sending workspace invitation to ${to}...`);

      const result = (await this.mailerService.sendMail({
        to,
        subject: `You're invited to join ${context.workspaceName} on ManekHR`,
        template: './invitation-workspace',
        context,
      })) as { messageId?: string };

      this.logger.log(`Invitation email sent: ${result?.messageId}`);
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send workspace invitation email: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Send a customer-portal share link (finance party portal, view-only).
   * Cross-link: triggered by PortalTokenController.share (channel='email'); the URL is the
   * tokenised /portal/<token> link issued by PortalTokenService. View-only - no payment link
   * (feedback_no_payments_in_billing). Throws on SMTP error so the caller can surface it.
   */
  async sendPortalLinkEmail(
    to: string,
    context: { partyName: string; firmName: string; portalUrl: string; expiryNote?: string },
  ): Promise<boolean> {
    try {
      this.logger.log(`Sending customer portal link to ${to}...`);
      const result = (await this.mailerService.sendMail({
        to,
        subject: `Your account portal with ${context.firmName}`,
        template: './portal-link',
        context,
      })) as { messageId?: string };
      this.logger.log(`Portal link email sent: ${result?.messageId}`);
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send portal link email: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Send team app access invitation email
   */
  async sendTeamAccessInvitationEmail(
    to: string,
    context: {
      memberName: string;
      workspaceName: string;
      appRole: string;
      inviteUrl: string;
      mobileDeepLink: string;
      expiryDays: number;
    },
  ) {
    try {
      this.logger.log(`Sending team access invitation to ${to}...`);

      const result = (await this.mailerService.sendMail({
        to,
        subject: `You've been granted app access to ${context.workspaceName}`,
        template: './invitation-team-access',
        context,
      })) as { messageId?: string };

      this.logger.log(`Team access invitation email sent: ${result?.messageId}`);
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send team access invitation email: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  async sendPayslipEmail(params: {
    to: string;
    employeeName: string;
    workspaceName: string;
    month: number;
    year: number;
    netSalary: string;
    paymentStatus: string;
    currencySymbol: string;
    pdfBase64: string;
    filename: string;
    replyToEmail?: string;
    replyToName?: string;
    customSmtpConfig?: {
      host?: string;
      port?: number;
      user?: string;
      pass?: string;
      fromEmail?: string;
      fromName?: string;
      secure?: boolean;
      enabled?: boolean;
    };
  }): Promise<void> {
    const monthLabel = this.getMonthLabel(params.month);
    const normalizedNetSalary = params.netSalary.startsWith(params.currencySymbol)
      ? params.netSalary.slice(params.currencySymbol.length)
      : params.netSalary;

    const subject = `Your Payslip for ${monthLabel} ${params.year} — ${params.workspaceName}`;
    const context = {
      employeeName: params.employeeName,
      workspaceName: params.workspaceName,
      monthLabel,
      year: params.year,
      netSalary: normalizedNetSalary,
      paymentStatus: params.paymentStatus,
      currencySymbol: params.currencySymbol,
    };
    const attachments = [
      {
        filename: params.filename,
        content: Buffer.from(params.pdfBase64, 'base64'),
        contentType: 'application/pdf',
      },
    ];

    const smtp = params.customSmtpConfig;
    if (smtp?.enabled && smtp.host && smtp.user && smtp.pass && smtp.fromEmail) {
      try {
        this.logger.log(`Sending payslip via custom SMTP to ${params.to}...`);
        const transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port || 587,
          secure: smtp.secure ?? true,
          auth: { user: smtp.user, pass: smtp.pass },
        });
        const htmlTemplate = await this.renderPayslipTemplate(context);
        await transport.sendMail({
          from: `"${smtp.fromName || params.workspaceName}" <${smtp.fromEmail}>`,
          to: params.to,
          subject,
          html: htmlTemplate,
          attachments,
        });
        this.logger.log(`Payslip email sent via custom SMTP`);
      } catch (e: unknown) {
        this.logger.error(
          `Failed to send payslip via custom SMTP: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
      }
      return;
    }

    try {
      this.logger.log(`Sending payslip email to ${params.to}...`);
      const platformFrom = this.configService.get<string>('SMTP_FROM') || '';
      const result = (await this.mailerService.sendMail({
        from: `"${params.workspaceName} via ManekHR" <${platformFrom}>`,
        to: params.to,
        replyTo: params.replyToEmail
          ? `"${params.replyToName || ''}" <${params.replyToEmail}>`
          : undefined,
        subject,
        template: './payslip',
        context,
        attachments,
      })) as { messageId?: string };
      this.logger.log(`Payslip email sent: ${result?.messageId}`);
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send payslip email: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  private async renderPayslipTemplate(context: Record<string, unknown>): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const Handlebars = await import('handlebars');
    const templatePath = path.join(__dirname, 'templates', 'payslip.hbs');
    const source = fs.readFileSync(templatePath, 'utf-8');
    const compiled = Handlebars.compile(source);
    return compiled(context);
  }

  /**
   * Send a pending-device alert email when a new biometric device is auto-registered.
   * Fire-and-forget safe — caller should .catch(() => {}).
   */
  async sendPendingDeviceEmail(
    recipient: { email: string; name: string },
    data: { serial: string; wsName: string; approveUrl: string },
  ): Promise<void> {
    this.logger.log(`Sending pending-device email to ${recipient.email} for SN ${data.serial}`);
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `New biometric device detected — ${data.wsName}`,
      template: './pending-device',
      context: {
        name: recipient.name,
        serial: data.serial,
        wsName: data.wsName,
        approveUrl: data.approveUrl,
      },
    });
  }

  /**
   * Send a daily unassigned-punch digest email for workspaces with unmapped device users.
   * Fire-and-forget safe — caller should .catch(() => {}).
   */
  async sendUnassignedDigestEmail(
    recipient: { email: string; name: string },
    data: { wsName: string; unassignedCount: number; manageUrl: string },
  ): Promise<void> {
    this.logger.log(`Sending unassigned digest email to ${recipient.email} for ws ${data.wsName}`);
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `${data.unassignedCount} unmapped device users — ${data.wsName}`,
      template: './unassigned-digest',
      context: {
        name: recipient.name,
        wsName: data.wsName,
        unassignedCount: data.unassignedCount,
        manageUrl: data.manageUrl,
      },
    });
  }

  /**
   * Phase D: notify current-level approver that a regularization is pending.
   * Fire-and-forget safe — caller should .catch(() => {}).
   */
  async sendRegularizationPendingApprover(
    recipient: { email: string; name: string },
    data: {
      raiserName: string;
      memberName: string;
      date: string;
      requestedStatus: string;
      reason: string;
      wsName: string;
      reviewUrl: string;
    },
  ): Promise<void> {
    this.logger.log(
      `Sending regularization-pending email to ${recipient.email} for member ${data.memberName} date ${data.date}`,
    );
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `Regularization awaiting approval — ${data.memberName} (${data.date})`,
      template: './regularization-pending-approver',
      context: { name: recipient.name, ...data },
    });
  }

  async sendRegularizationNextApprover(
    recipient: { email: string; name: string },
    data: {
      level: number;
      memberName: string;
      date: string;
      requestedStatus: string;
      wsName: string;
      reviewUrl: string;
    },
  ): Promise<void> {
    this.logger.log(
      `Sending regularization-next email to ${recipient.email} for level ${data.level}`,
    );
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `Regularization level ${data.level} awaiting your approval — ${data.memberName}`,
      template: './regularization-next-approver',
      context: { name: recipient.name, ...data },
    });
  }

  async sendRegularizationApproved(
    recipient: { email: string; name: string },
    data: {
      memberName: string;
      date: string;
      requestedStatus: string;
      wsName: string;
      viewUrl: string;
    },
  ): Promise<void> {
    this.logger.log(`Sending regularization-approved email to ${recipient.email} for ${data.date}`);
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `Regularization approved — ${data.memberName} (${data.date})`,
      template: './regularization-approved',
      context: { name: recipient.name, ...data },
    });
  }

  async sendRegularizationRejected(
    recipient: { email: string; name: string },
    data: {
      memberName: string;
      date: string;
      requestedStatus: string;
      decisionByName: string;
      decisionType: 'rejected' | 'cancelled';
      note: string | null;
      wsName: string;
      viewUrl: string;
    },
  ): Promise<void> {
    this.logger.log(`Sending regularization-${data.decisionType} email to ${recipient.email}`);
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: `Regularization ${data.decisionType} — ${data.memberName} (${data.date})`,
      template: './regularization-rejected',
      context: { name: recipient.name, ...data },
    });
  }

  /**
   * Leave epic L3c4 — one parameterised template covers every leave /
   * comp-off lifecycle email (applied / approval needed / decided /
   * cancelled / withdrawn). Fire-and-forget safe — caller should .catch().
   */
  async sendLeaveNotification(
    recipient: { email: string; name: string },
    data: {
      subject: string;
      headline: string;
      intro: string;
      lines: Array<{ label: string; value: string }>;
      reason?: string | null;
      note?: string | null;
      ctaUrl: string;
      ctaLabel: string;
      wsName: string;
    },
  ): Promise<void> {
    this.logger.log(`Sending leave-notification email to ${recipient.email} — ${data.subject}`);
    await this.mailerService.sendMail({
      to: recipient.email,
      subject: data.subject,
      template: './leave-notification',
      context: { name: recipient.name, ...data },
    });
  }

  /**
   * Send a transactional invoice email with PDF attachment, inline UPI QR, and Razorpay link.
   * D-27: email channel for sendVoucher — NOT a stub. Wires directly to Nodemailer via MailerService.
   *
   * Supports inline cid: attachments (e.g. UPI QR as embedded image).
   */
  async sendInvoiceEmail(args: {
    to: string;
    subject: string;
    html: string;
    attachments: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
      cid?: string;
    }>;
  }): Promise<void> {
    this.logger.log(`Sending invoice email to ${args.to} — subject: ${args.subject}`);
    try {
      const result = (await this.mailerService.sendMail({
        to: args.to,
        subject: args.subject,
        html: args.html,
        attachments: args.attachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
          cid: att.cid,
        })),
      })) as { messageId?: string };
      this.logger.log(`Invoice email sent: ${result?.messageId}`);
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send invoice email to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * F-11: Send a deemed-supply or pre-warning alert email for a JW lot.
   * Accepts a raw HTML body — no Handlebars template needed for operational alerts.
   * Fire-and-forget safe — caller should .catch(() => {}).
   *
   * TODO(F-11): Recipient `to` email must be resolved by caller from
   * workspace.ownerId → User.email or firm.adminEmail.
   * Until that resolution is wired, callers skip this call if `to` is falsy.
   */
  async sendDeemedSupplyAlertEmail(args: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    if (!args.to) return;
    this.logger.log(`Sending deemed-supply alert to ${args.to}: ${args.subject}`);
    try {
      await this.mailerService.sendMail({
        to: args.to,
        subject: args.subject,
        html: args.html,
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send deemed-supply alert to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Generic billing-event email — used by D1g dunning service for
   * "payment failed", "grace period reminder", and "subscription
   * expired" notifications. Intentionally takes raw HTML so the
   * dunning service can vary copy per event type without a Handlebars
   * template per event.
   *
   * Fire-and-forget safe — caller should `.catch(() => {})`.
   */
  async sendBillingDunningEmail(args: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    if (!args.to) return;
    this.logger.log(`Sending dunning email to ${args.to}: ${args.subject}`);
    try {
      await this.mailerService.sendMail({
        to: args.to,
        subject: args.subject,
        html: args.html,
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send dunning email to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * D4 — generic marketing-campaign sender. Identical wire-shape to
   * dunning, but bucketed under a separate logger label so SMTP
   * failures across campaigns are easy to triage in production logs.
   * Caller composes the HTML so authoring lives next to the campaign
   * cron — one place to change copy.
   */
  async sendMarketingEmail(args: {
    to: string;
    subject: string;
    html: string;
    campaign: string;
  }): Promise<void> {
    if (!args.to) return;
    this.logger.log(`Sending marketing email (${args.campaign}) to ${args.to}: ${args.subject}`);
    try {
      await this.mailerService.sendMail({
        to: args.to,
        subject: args.subject,
        html: args.html,
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send marketing email (${args.campaign}) to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new Error(`SMTP Error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  /**
   * Reminder dispatcher — payment-reminder email for overdue / due-soon
   * invoices. Fired by `EmailAdapter.send()` for `invoice_overdue`,
   * `invoice_due_soon`, `final_notice` events. Template selects panel
   * by escalationLevel (1 = friendly, 2 = overdue, 3 = final notice).
   *
   * NOT quota-checked here — reminder dispatcher runs system-wide and
   * the dispatcher itself owns workspace-level rate limiting.
   */
  async sendPaymentReminderEmail(args: {
    to: string;
    partyName: string;
    invoiceNumber: string;
    amountDue: string;
    daysPastDue: number;
    dueDate: string;
    paymentLink?: string;
    workspaceName: string;
    escalationLevel: 1 | 2 | 3;
  }): Promise<void> {
    const subject =
      args.escalationLevel === 3
        ? `FINAL NOTICE — Invoice ${args.invoiceNumber} (${args.daysPastDue} days overdue)`
        : args.escalationLevel === 2
          ? `Payment overdue — Invoice ${args.invoiceNumber}`
          : `Payment reminder — Invoice ${args.invoiceNumber}`;
    this.logger.log(
      `Sending payment-reminder email to ${args.to} L${args.escalationLevel} invoice=${args.invoiceNumber}`,
    );
    await this.mailerService.sendMail({
      to: args.to,
      subject,
      template: './payment-reminder',
      context: {
        partyName: args.partyName,
        invoiceNumber: args.invoiceNumber,
        amountDue: args.amountDue,
        daysPastDue: args.daysPastDue,
        dueDate: args.dueDate,
        paymentLink: args.paymentLink,
        workspaceName: args.workspaceName,
        isLevel1: args.escalationLevel === 1,
        isLevel2: args.escalationLevel === 2,
        isLevel3: args.escalationLevel === 3,
        currentYear: new Date().getFullYear(),
      },
    });
  }

  /**
   * Reminder dispatcher — service-maintenance reminder email for machines
   * approaching or past their next-maintenance date. Fired by
   * `EmailAdapter.send()` for `service_maintenance` event.
   */
  async sendServiceMaintenanceReminderEmail(args: {
    to: string;
    machineName: string;
    daysOverdue: number;
    lastMaintenanceDate: string;
    workspaceName: string;
  }): Promise<void> {
    const isOverdue = args.daysOverdue > 0;
    const subject = isOverdue
      ? `Maintenance overdue — ${args.machineName} (${args.daysOverdue} days)`
      : `Maintenance due soon — ${args.machineName}`;
    this.logger.log(
      `Sending service-maintenance email to ${args.to} machine=${args.machineName} overdue=${args.daysOverdue}`,
    );
    await this.mailerService.sendMail({
      to: args.to,
      subject,
      template: './service-reminder',
      context: {
        machineName: args.machineName,
        daysOverdue: Math.abs(args.daysOverdue),
        daysUntilDue: isOverdue ? 0 : Math.abs(args.daysOverdue),
        lastMaintenanceDate: args.lastMaintenanceDate,
        workspaceName: args.workspaceName,
        isOverdue,
        currentYear: new Date().getFullYear(),
      },
    });
  }

  /**
   * Wave 5 credit-pack: low-balance alert. Triggered by the daily
   * communications-credit cron when a paid-tier subscription's SMS or
   * WhatsApp balance drops below threshold AND auto-recharge is OFF.
   *
   * Inline HTML — no template. Subject includes the channel + remaining
   * balance so the alert is actionable from the inbox preview.
   */
  async sendLowCreditBalanceEmail(args: {
    to: string;
    userName: string;
    channel: 'SMS' | 'WhatsApp';
    balance: number;
    threshold: number;
    rechargeUrl: string;
  }): Promise<void> {
    const subject = `Low ${args.channel} credit balance — ${args.balance} left`;
    const channelLabel = args.channel === 'SMS' ? 'SMS' : 'WhatsApp';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto;">
  <div style="background: #fff7e6; padding: 16px; border-left: 4px solid #fa8c16;">
    <h2 style="color: #fa8c16; margin: 0;">${channelLabel} credits running low</h2>
  </div>
  <p>Hi ${args.userName},</p>
  <p>Your ${channelLabel} credit balance is <strong>${args.balance}</strong>, below your alert threshold of <strong>${args.threshold}</strong>.</p>
  <p>To keep ${channelLabel} reminders flowing without interruption, top up a pack now.</p>
  <p style="margin: 24px 0;">
    <a href="${args.rechargeUrl}" style="background: #1890ff; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Buy ${channelLabel} pack</a>
  </p>
  <p style="color: #666; font-size: 13px;">Tip: enable <strong>auto-recharge</strong> in Subscription &rarr; Credits to never run out again.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">Sent by ManekHR. You can mute these alerts from Subscription &rarr; Credits.</p>
</body>
</html>`;
    this.logger.log(
      `Sending low-${channelLabel}-balance email to ${args.to} balance=${args.balance}`,
    );
    try {
      await this.mailerService.sendMail({
        to: args.to,
        subject,
        html,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error(`Failed to send low-balance email to ${args.to}: ${msg}`);
    }
  }

  /**
   * Wave 8.1 — ops-side MSG91 wallet top-up alert.
   *
   * Fired when:
   *   - Customer purchases a credit pack but our MSG91 wallet runway can't
   *     cover the implied volume (pre-emptive — usually no customer impact).
   *   - A reminder dispatch is skipped because MSG91 wallet is empty
   *     (active — customer's send is queued for tomorrow's cron).
   *
   * Recipient is the platform ops mailbox (`OPS_MSG91_ALERT_EMAIL`), NOT the
   * customer. Throttled at the caller level via `OpsAlertState`.
   */
  async sendOpsMsg91TopUpAlert(args: {
    to: string;
    balancePaise: number;
    requiredPaise: number;
    runwayDays: number;
    context: 'pack_purchase' | 'send_skipped';
    workspaceId?: string;
    note?: string;
  }): Promise<void> {
    const balRupees = (args.balancePaise / 100).toLocaleString('en-IN');
    const reqRupees = (args.requiredPaise / 100).toLocaleString('en-IN');
    const recommendedRupees = Math.max(
      Math.ceil((args.requiredPaise * 7) / 100),
      500,
    ).toLocaleString('en-IN');
    const subject = `[ops] MSG91 wallet low — runway ${args.runwayDays}d, top up now`;
    const ctxLabel =
      args.context === 'pack_purchase' ? 'Customer purchased credit pack' : 'Reminder send skipped';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 640px; margin: 0 auto;">
  <div style="background: #fff1f0; padding: 16px; border-left: 4px solid #f5222d;">
    <h2 style="color: #f5222d; margin: 0;">MSG91 wallet top-up required</h2>
    <p style="margin: 4px 0 0; color: #555;">Trigger: ${ctxLabel}</p>
  </div>
  <p style="margin-top: 16px;">
    Current MSG91 wallet balance: <strong>₹${balRupees}</strong><br>
    Required runway for this trigger: <strong>₹${reqRupees}</strong><br>
    Projected runway days at 30d burn: <strong>${args.runwayDays}d</strong>
  </p>
  <p>Recommended top-up: <strong>₹${recommendedRupees}</strong> (covers ~7 days at current burn rate).</p>
  ${args.workspaceId ? `<p style="color: #666; font-size: 13px;">Triggering workspace: <code>${args.workspaceId}</code></p>` : ''}
  ${args.note ? `<p style="color: #666; font-size: 13px;">Note: ${args.note}</p>` : ''}
  <p style="margin: 24px 0;">
    <a href="https://control.msg91.com/app/balance" style="background: #f5222d; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Open MSG91 dashboard</a>
  </p>
  <p style="color: #666; font-size: 13px;">After topping up on MSG91, record it at <a href="${env.webAppUrl}/admin/communications/msg91-balance">/admin/communications/msg91-balance</a> for audit trail.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">Sent by ManekHR ops alert system. Throttled to one email per 7 days for the same incident.</p>
</body>
</html>`;
    this.logger.log(
      `Sending ops MSG91 top-up alert to ${args.to} balance=₹${balRupees} runway=${args.runwayDays}d ctx=${args.context}`,
    );
    try {
      await this.mailerService.sendMail({
        to: args.to,
        subject,
        html,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error(`Failed to send ops MSG91 alert to ${args.to}: ${msg}`);
    }
  }

  /**
   * Phase 2.2 — Permission-change notification email.
   * Sent when a member's permissions or role is updated by an admin.
   * Uses inline text rather than a template so it works without a
   * Handlebars file — mirrors the resilience posture of invite emails.
   *
   * Note: a proper Handlebars template (`permission-update`) can be added
   * later for branded HTML; this inline path is intentional for v1 so the
   * dispatcher is not blocked on template creation.
   */
  async sendPermissionUpdateEmail(args: {
    recipientEmail: string;
    workspaceName: string;
    actorName: string;
    changeKind: 'overrides_updated' | 'role_changed';
    diffSummary: string;
  }): Promise<void> {
    const subject =
      args.changeKind === 'role_changed'
        ? `Your role was changed in ${args.workspaceName}`
        : `Your permissions were updated in ${args.workspaceName}`;

    const body = [
      `Hi,`,
      ``,
      args.changeKind === 'role_changed'
        ? `${args.actorName} changed your role in ${args.workspaceName}.`
        : `${args.actorName} updated your permissions in ${args.workspaceName}.`,
      args.diffSummary ? `Details: ${args.diffSummary}` : ``,
      ``,
      `Open zari360 to view your current access.`,
    ].join('\n');

    this.logger.log(
      `Sending permission-update email to ${args.recipientEmail} (kind=${args.changeKind})`,
    );
    await this.mailerService.sendMail({
      to: args.recipientEmail,
      subject,
      text: body,
    });
  }

  /**
   * Send an attendance-defaulter digest email to a manager or workspace admin.
   * Fire-and-forget safe — caller should .catch(() => {}).
   *
   * Called by DefaulterAlertService.sendEmailChannel after quota is confirmed.
   * Renders the `defaulter-alert` Handlebars template with the digest context.
   */
  async sendDefaulterAlertEmail(args: {
    to: string;
    monthLabel: string;
    thresholdPct: number;
    defaulters: Array<{ name: string; designation: string; ratePct: number }>;
    complianceUrl: string;
  }): Promise<void> {
    const subject = `Attendance defaulters — ${args.monthLabel}`;
    this.logger.log(`Sending defaulter-alert email to ${args.to} for ${args.monthLabel}`);
    await this.mailerService.sendMail({
      to: args.to,
      subject,
      template: './defaulter-alert',
      context: {
        monthLabel: args.monthLabel,
        thresholdPct: args.thresholdPct,
        defaulters: args.defaulters,
        complianceUrl: args.complianceUrl,
      },
    });
  }

  /**
   * Account-deletion Phase 2 (plan §3C / §7) — confirmation email sent the
   * moment a user schedules whole-account deletion. States the recover-by date
   * and the contact channel. Recovery is admin-mediated (NO self-cancel link):
   * to recover, the user contacts Zari within the window. Inline HTML (no
   * Handlebars template); fire-and-forget safe — a send failure must NEVER abort
   * the already-committed suspend, so SMTP errors are swallowed + logged.
   */
  async sendAccountDeletionScheduledEmail(args: {
    to: string;
    name: string;
    recoverByDate: Date;
    contactUrl: string;
  }): Promise<void> {
    if (!args.to) return;
    const recoverBy = this.formatDeletionDate(args.recoverByDate);
    const subject = 'Your ManekHR account is scheduled for deletion';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #1A2A6C; max-width: 600px; margin: 0 auto;">
  <div style="background: #FAF8F3; padding: 20px; border-left: 4px solid #C9A227;">
    <h2 style="color: #1A2A6C; margin: 0;">Account scheduled for deletion</h2>
  </div>
  <p>Hi ${args.name || 'there'},</p>
  <p>We have received a request to permanently delete your ManekHR account. Your account is now
     suspended and you have been signed out everywhere.</p>
  <p><strong>You can recover your account until ${recoverBy}.</strong> After that date your personal
     data is permanently removed and recovery is no longer possible.</p>
  <p>To recover your account, contact us before that date:</p>
  <p style="margin: 24px 0;">
    <a href="${args.contactUrl}" style="background: #1A2A6C; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Contact us to recover</a>
  </p>
  <p style="color: #555; font-size: 13px;">If you requested this, no further action is needed. Statutory
     payroll, wage, tax and GST records are retained de-identified for their fixed legal periods, then
     auto-deleted, as required by law.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">Sent by ManekHR because a deletion was scheduled for your account.</p>
</body>
</html>`;
    try {
      await this.mailerService.sendMail({ to: args.to, subject, html });
      this.logger.log(`Account-deletion scheduled email sent to ${args.to}`);
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send account-deletion scheduled email to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }

  /**
   * Account-deletion Phase 2 (plan §3C / §7) — the ~Day-25 "recovery window
   * closing" reminder, sent once (deduped by `accountDeletion.reminderSentAt`)
   * a few days before the irreversible Day-30 purge. Inline HTML; fire-and-forget
   * safe (SMTP errors swallowed + logged).
   */
  async sendAccountDeletionReminderEmail(args: {
    to: string;
    name: string;
    recoverByDate: Date;
    daysLeft: number;
    contactUrl: string;
  }): Promise<void> {
    if (!args.to) return;
    const recoverBy = this.formatDeletionDate(args.recoverByDate);
    const dayWord = args.daysLeft === 1 ? 'day' : 'days';
    const subject = `${args.daysLeft} ${dayWord} left to recover your ManekHR account`;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #1A2A6C; max-width: 600px; margin: 0 auto;">
  <div style="background: #FAF8F3; padding: 20px; border-left: 4px solid #C9A227;">
    <h2 style="color: #1A2A6C; margin: 0;">Last chance to recover your account</h2>
  </div>
  <p>Hi ${args.name || 'there'},</p>
  <p>Your ManekHR account is scheduled to be <strong>permanently deleted on ${recoverBy}</strong>
     (${args.daysLeft} ${dayWord} from now). After that date your personal data is removed and
     recovery is no longer possible.</p>
  <p>If you want to keep your account, contact us to recover it before then:</p>
  <p style="margin: 24px 0;">
    <a href="${args.contactUrl}" style="background: #1A2A6C; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Contact us to recover</a>
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">Sent by ManekHR because your account is scheduled for deletion.</p>
</body>
</html>`;
    try {
      await this.mailerService.sendMail({ to: args.to, subject, html });
      this.logger.log(
        `Account-deletion reminder email sent to ${args.to} (${args.daysLeft}d left)`,
      );
    } catch (e: unknown) {
      this.logger.error(
        `Failed to send account-deletion reminder email to ${args.to}: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }

  /** Format a deletion recover-by date in IST for the deletion emails. */
  private formatDeletionDate(date: Date): string {
    return date.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
  }

  /**
   * Phase I: Send an anomaly alert email to workspace admins.
   * Fire-and-forget safe — caller should .catch(() => {}).
   */
  async sendAnomalyAlertEmail(
    recipient: { email: string; name: string },
    ctx: {
      ruleType: string;
      severity: 'high' | 'medium' | 'low';
      title: string;
      detail: string;
      feedUrl: string;
    },
  ): Promise<void> {
    const subject = `[${ctx.severity.toUpperCase()}] Attendance anomaly: ${ctx.title}`;
    this.logger.log(
      `Sending anomaly-alert email to ${recipient.email} for ruleType=${ctx.ruleType}`,
    );
    await this.mailerService.sendMail({
      to: recipient.email,
      subject,
      template: './anomaly-alert',
      context: {
        recipientName: recipient.name,
        ruleType: ctx.ruleType,
        severity: ctx.severity,
        title: ctx.title,
        detail: ctx.detail,
        feedUrl: ctx.feedUrl,
      },
    });
  }
}
