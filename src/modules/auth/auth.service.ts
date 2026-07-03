import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/nestjs';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { env } from '../../config/env';
import { issueTokens } from './utils/token-issuer';
import { normaliseIndianMobile } from './utils/mobile-normalizer';
import { appLockKey } from './utils/app-lock-key';
import {
  buildPendingDeletionSignupError,
  buildSuspendedAccountError,
  isPendingDeletion,
} from './utils/account-status';
import { UsersService } from '../users/users.service';
import { User } from '../users/schemas/user.schema';
import {
  RegisterDto,
  LoginDto,
  GoogleAuthDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SendVerificationEmailDto,
  VerifyEmailDto,
  SetupAdminDto,
  TerminateAndLoginUnauthDto,
  SetPinDto,
  ChangePinDto,
  VerifyPinDto,
  ForgotPinCredentialDto,
  ForgotPinResetDto,
} from './dto/auth.dto';
import {
  AuthResult,
  RefreshResult,
  AuthJwtPayload,
  DecodedJwtMeta,
  OtpVerifyJwtPayload,
  EmailOtpJwtPayload,
} from './types/auth.types';
import { checkSlidingWindow } from './utils/otp-rate-limiter';
import { isDisposableEmailDomain } from './utils/disposable-email';
import { OAuth2Client } from 'google-auth-library';
import { MailService } from '../mail/mail.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PlatformAccess, Platform } from '../../common/enums/platform-access.enum';
import { SessionsService } from '../sessions/sessions.service';
import { SessionPlatform } from '../sessions/schemas/session.schema';
import { WorkspaceMember } from '../workspaces/schemas/workspace-member.schema';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { InviteNotificationDispatcher } from '../workspaces/invite-notification.dispatcher';
import { Model, Types } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';
// Connect Referral Program — best-effort signup attribution. Provided by
// ConnectReferralsModule (imported by AuthModule); the attach call is internally
// try/caught AND .catch()-guarded here so a referral failure can never fail auth.
import { ReferralService } from '../connect/referrals/services/referral.service';

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;
  private readonly logger = new Logger(AuthService.name);
  private readonly tracer = trace.getTracer('auth');

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
    private subscriptionsService: SubscriptionsService,
    private sessionsService: SessionsService,
    private moduleRef: ModuleRef,
    private auditService: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private workspacesService: WorkspacesService,
    private postHog: PostHogService,
    // Connect Referral Program: signup attribution (best-effort, never blocks auth).
    private referralService: ReferralService,
  ) {
    this.googleClient = new OAuth2Client(this.configService.get<string>('google.clientId'));
  }

  /**
   * SHA-256 hex of a signup IP for referral fraud signals -- NEVER stores the raw
   * IP/PII. Returns undefined when no IP was supplied (the field is then omitted
   * from signupContext). Connect Referral Program; consumed by
   * ReferralService.attachReferralAtSignup.
   */
  private hashIp(ip?: string): string | undefined {
    const trimmed = (ip || '').trim();
    if (!trimmed) return undefined;
    return crypto.createHash('sha256').update(trimmed).digest('hex');
  }

  /**
   * Fire the best-effort referral attribution after a fresh signup. The
   * underlying service is internally try/caught AND we add `.catch` here, so a
   * referral failure can NEVER fail or delay the signup response. Connect
   * Referral Program. No-ops when the program is disabled or no code was given.
   *
   * Public so SmsOtpService (the mobile-OTP signup path) can reuse the SAME
   * fire-and-forget call after it creates the User + session via
   * finalizeAuthSuccess -- one attribution code path for both signup entry points.
   */
  attachReferralBestEffort(args: {
    refereeUserId: string;
    code?: string | null;
    ipAddress?: string;
    mobile?: string | null;
    email?: string | null;
  }): void {
    const ipHash = this.hashIp(args.ipAddress);
    void this.referralService
      .attachReferralAtSignup({
        refereeUserId: args.refereeUserId,
        code: args.code,
        signupContext: {
          ...(ipHash ? { ipHash } : {}),
          ...(args.mobile ? { refereeMobileSnapshot: args.mobile } : {}),
          ...(args.email ? { refereeEmailSnapshot: args.email } : {}),
        },
      })
      .catch(() => undefined);
  }

  /**
   * Wrap a handler body with an OpenTelemetry span. Empty
   * `OTEL_EXPORTER_OTLP_ENDPOINT` makes the span a safe no-op (the SDK
   * registers no exporter), but the helper still tags errors via
   * `recordException` + sets ERROR status, mirroring Sentry posture.
   */
  private async withAuthSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async checkUser(checkUserDto: { identifier: string }): Promise<{
    exists: boolean;
    hasPassword: boolean;
    hasMobile: boolean;
    authMethod: 'password' | 'google' | 'otp_only' | null;
    otpAllowed: boolean;
  }> {
    // Mobile-OTP users are stored with the canonical `91XXXXXXXXXX` form.
    // The FE sends bare 10-digit input from CheckMode, so a literal match on
    // `mobile` would miss them — normalize here so existing OTP-registered
    // users land on `login` instead of `register`.
    const raw = checkUserDto.identifier?.trim() ?? '';
    const norm = normaliseIndianMobile(raw);
    const lookup = norm ? norm.full : raw;
    const user = await this.usersService.findByIdentifierWithCredentials(lookup);

    if (!user) {
      return {
        exists: false,
        hasPassword: false,
        hasMobile: false,
        authMethod: null,
        otpAllowed: false,
      };
    }

    const hasPassword = !!user.passwordHash;
    const hasMobile = !!user.mobile;
    let authMethod: 'password' | 'google' | 'otp_only' | null;
    if (user.googleId) {
      authMethod = 'google';
    } else if (hasPassword) {
      authMethod = 'password';
    } else if (hasMobile) {
      authMethod = 'otp_only';
    } else {
      authMethod = null;
    }

    return {
      exists: true,
      hasPassword,
      hasMobile,
      authMethod,
      otpAllowed: hasMobile,
    };
  }

  async register(registerDto: RegisterDto): Promise<AuthResult> {
    const isWebCombined = !!registerDto.workspace;
    const isInviteAccept = !!registerDto.inviteToken;

    // Wave 4.8 (2026-05-10) — mutex with workspace-create branch.
    if (isWebCombined && isInviteAccept) {
      throw new BadRequestException({
        code: 'INVALID_SIGNUP_VARIANT',
        message: 'Cannot create a new workspace and accept an invite in the same request.',
      });
    }

    return this.withAuthSpan(
      'auth.register',
      {
        mode: registerDto.email ? 'email' : 'mobile',
        variant: isWebCombined ? 'web-combined' : isInviteAccept ? 'invite-accept' : 'legacy',
      },
      async () => {
        // Backstop: reject disposable-email signups even on paths that skip the
        // OTP-send gate (legacy mobile-app email register). Mobile-only signups
        // (no email) pass through untouched. See utils/disposable-email.ts.
        if (
          registerDto.email &&
          env.signup.blockDisposableEmail &&
          isDisposableEmailDomain(registerDto.email)
        ) {
          throw new BadRequestException({
            code: 'DISPOSABLE_EMAIL_BLOCKED',
            message:
              'Please use a permanent email address. Temporary email providers are not allowed.',
          });
        }

        const existingUser = await this.usersService.findByIdentifierWithCredentials(
          registerDto.email || registerDto.mobile,
        );

        if (existingUser) {
          // Option B (ACCOUNT-DELETION §9): if the identifier belongs to a
          // whole-account deletion still in its 30-day grace, say so + how to
          // recover, instead of the generic conflict. Checked BEFORE the
          // Google-linked branch so a password-less account in grace still gets
          // the recover-it notice. Mirrors the suspended-LOGIN message
          // (account-status.ts); the auth UI localizes both from the shared
          // ACCOUNT_SCHEDULED_FOR_DELETION code.
          const pendingDeletionErr = buildPendingDeletionSignupError(
            existingUser,
            env.accountDeletion.contactUrl,
          );
          if (pendingDeletionErr) throw pendingDeletionErr;
          if (!existingUser.passwordHash) {
            throw new BadRequestException(
              'This account is linked to Google. Please sign in with Google or set a password in your Profile Settings.',
            );
          }
          throw new BadRequestException('User with these credentials already exists');
        }

        // Web combined-signup (email path) MUST present a verified emailOtp before
        // we create the User. Without it, anyone could register with someone
        // else's email — mirror parity with the mobile path (which is gated by
        // /auth/verify-otp). Legacy User-only register (mobile-app, /auth/register
        // without `workspace`) keeps its existing behaviour.
        // Wave 4.8 — invite-accept (email path) extends the same OTP gate.
        if (registerDto.email && (isWebCombined || isInviteAccept)) {
          if (!registerDto.emailOtp) {
            throw new BadRequestException({
              code: 'EMAIL_OTP_REQUIRED',
              message: 'Email verification code is required.',
            });
          }
          await this.consumeEmailRegistrationOtp(registerDto.email, registerDto.emailOtp);
        }

        // Wave 4.8 — pre-flight invite token validation. Look up the bridge
        // row BEFORE creating a User so an invalid / expired / mismatched
        // token fails fast (no compensating delete needed).
        if (isInviteAccept) {
          const tokenHash = crypto
            .createHash('sha256')
            .update(registerDto.inviteToken)
            .digest('hex');
          interface InviteRow {
            inviteExpiry?: Date | null;
            inviteeIdentifier?: string | null;
            inviteeType?: 'email' | 'mobile' | null;
          }
          const memberModel = this.workspacesService['memberModel'] as
            | { findOne(q: unknown): { exec(): Promise<InviteRow | null> } }
            | undefined;
          if (!memberModel) {
            throw new HttpException(
              { code: 'SIGNUP_FAILED', message: 'Invite resolution unavailable.' },
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
          }
          const inviteRow = await memberModel
            .findOne({ inviteTokenHash: tokenHash, status: 'invited' })
            .exec();
          if (!inviteRow) {
            throw new BadRequestException({
              code: 'INVITE_INVALID',
              message: 'This invite is no longer valid.',
            });
          }
          if (inviteRow.inviteExpiry && inviteRow.inviteExpiry.getTime() < Date.now()) {
            throw new HttpException(
              {
                code: 'INVITE_EXPIRED',
                message: 'This invite has expired. Ask the workspace owner to resend.',
              },
              HttpStatus.GONE,
            );
          }
          // Identifier match — email path.
          const expectedIdentifier = inviteRow.inviteeIdentifier ?? undefined;
          if (
            inviteRow.inviteeType === 'email' &&
            expectedIdentifier &&
            registerDto.email?.toLowerCase() !== expectedIdentifier.toLowerCase()
          ) {
            throw new BadRequestException({
              code: 'INVITE_IDENTIFIER_MISMATCH',
              message:
                'This invite was sent to a different email address. Sign up with that email to accept.',
            });
          }
          if (inviteRow.inviteeType === 'mobile') {
            throw new BadRequestException({
              code: 'INVITE_IDENTIFIER_MISMATCH',
              message:
                'This invite was sent to a phone number. Use the mobile signup option to accept.',
            });
          }
        }

        const salt = await bcrypt.genSalt(12);
        const passwordHash = await bcrypt.hash(registerDto.password, salt);

        // Wave 5 (2026-05-21) — atomic product-policy consent at signup. The
        // FE captures the T&C checkbox tick in SignupMode and forwards the
        // chosen product as `acceptedPolicy`. Stamping the matching
        // `*PolicyAcceptedAt` field as part of the user-creation save makes
        // the policy gate read-side see the stamp on the FIRST navigation
        // after signup — eliminating the race-prone post-signup round-trip
        // (and the visible "you just accepted, accept again?" bug it caused).
        const policyStampedAt = registerDto.acceptedPolicy ? new Date() : null;

        const user = await this.usersService.create({
          name: registerDto.name,
          email: registerDto.email,
          mobile: registerDto.mobile,
          passwordHash,
          // Email-OTP just verified ownership — flip the verified flag now so the
          // user doesn't have to click the post-signup email-verification link.
          ...(registerDto.email && registerDto.workspace && registerDto.emailOtp
            ? { isEmailVerified: true }
            : {}),
          ...(registerDto.acceptedPolicy === 'connect' && policyStampedAt
            ? { connectPolicyAcceptedAt: policyStampedAt }
            : {}),
          ...(registerDto.acceptedPolicy === 'erp' && policyStampedAt
            ? { erpPolicyAcceptedAt: policyStampedAt }
            : {}),
        });

        // Wave 4.8 (2026-05-10) — invite-accept variant: create the User
        // (above) then join the existing workspace via the bridge invite
        // row. Compensating User-delete on failure mirrors the web-combined
        // pattern.
        let createdWorkspaceId: string | undefined;
        let userAfterWorkspace: User = user;
        if (isInviteAccept && registerDto.inviteToken) {
          try {
            await this.workspacesService.joinWithToken(
              registerDto.inviteToken,
              this.getUserId(user),
            );
            const refreshed = await this.usersService.findByIdWithCredentials(this.getUserId(user));
            if (refreshed) userAfterWorkspace = refreshed;
          } catch (err) {
            try {
              await this.usersService.remove(this.getUserId(user));
            } catch (cleanupErr) {
              this.logger.error(
                `[register.invite-accept] User cleanup failed for ${this.getUserId(user)}: ${(cleanupErr as Error)?.message ?? cleanupErr}`,
              );
              Sentry.captureException(cleanupErr, {
                tags: {
                  module: 'auth',
                  op: 'register.compensate-user-delete-invite',
                },
                extra: { userId: this.getUserId(user) },
              });
            }
            Sentry.captureException(err, {
              tags: { module: 'auth', op: 'register.invite-accept-join' },
              extra: { userId: this.getUserId(user) },
            });
            if (err instanceof HttpException) throw err;
            throw new BadRequestException({
              code: 'INVITE_ACCEPT_FAILED',
              message: 'Could not accept the invite. Please try again.',
            });
          }
        }

        // Web combined-signup variant (email-path SignupMode): create the
        // Workspace right after the User. On failure, compensate by hard-deleting
        // the User row so the user can retry signup without hitting
        // EMAIL_ALREADY_REGISTERED. Mirrors the OTP-path web-combined branch in
        // SmsOtpService.verifyOtp — true Mongo transactions across User+Workspace
        // would require a replica set + threading a session through
        // WorkspacesService.create (workspace + member + firm + addons), so the
        // compensating delete is the simpler portable approach.
        if (registerDto.workspace) {
          try {
            const ws = await this.workspacesService.create(this.getUserId(user), {
              name: registerDto.workspace.name,
              location: registerDto.workspace.location,
              businessType: registerDto.workspace.businessType,
              gstin: registerDto.workspace.gstin,
              pan: registerDto.workspace.pan,
              fyStartMonth: registerDto.workspace.fyStartMonth,
            });
            createdWorkspaceId = ws._id.toString();
            // WorkspacesService.create flips User.hasWorkspace=true on the DB
            // row but the local `user` Mongoose doc is stale. Refetch so the
            // AuthResult returned to the FE reflects the real state — without
            // this, DashboardLayout sees hasWorkspace=false and bounces the
            // user to /auth/setup-workspace, then back to /dashboard once the
            // bootstrap getMe lands. Net effect: /dashboard/settings unreachable
            // immediately after signup.
            //
            // Use findByIdWithCredentials (not findById) — sanitizeUser computes
            // `hasPassword: !!passwordHash` and `hasPin: !!pinHash`. A bare
            // findById strips both fields via `select: false`, making the FE
            // believe the user has no password (PasswordSetupPrompt nags + the
            // Settings password card swaps to "Set" instead of "Change").
            const refreshed = await this.usersService.findByIdWithCredentials(this.getUserId(user));
            if (refreshed) userAfterWorkspace = refreshed;
          } catch (err) {
            try {
              await this.usersService.remove(this.getUserId(user));
            } catch (cleanupErr) {
              this.logger.error(
                `[register.web-combined] User cleanup failed for ${this.getUserId(user)}: ${(cleanupErr as Error)?.message ?? cleanupErr}`,
              );
              Sentry.captureException(cleanupErr, {
                tags: { module: 'auth', op: 'register.compensate-user-delete' },
                extra: { userId: this.getUserId(user) },
              });
            }
            Sentry.captureException(err, {
              tags: { module: 'auth', op: 'register.workspace-create' },
              extra: { userId: this.getUserId(user) },
            });
            if (err instanceof BadRequestException || err instanceof ForbiddenException) {
              throw err;
            }
            throw new BadRequestException({
              code: 'SIGNUP_FAILED',
              message: 'Could not complete signup. Please try again.',
            });
          }
        }

        // Auto-link pending invitations
        await this.linkPendingInvitations(
          this.getUserId(user),
          registerDto.email,
          registerDto.mobile,
        );

        // Auto-assign free subscription for new users
        await this.subscriptionsService
          .createFreeSubscription(this.getUserId(user), 'self')
          .catch((e) => {
            this.logger.warn(
              `[register] createFreeSubscription failed for ${this.getUserId(user)}: ${(e as Error)?.message ?? e}`,
            );
            Sentry.captureException(e, {
              tags: { module: 'auth', op: 'register.createFreeSubscription' },
              extra: { userId: this.getUserId(user) },
            });
          });

        // Auto-generate the public-profile slug (`User.handle`) from the user's
        // display name. Best-effort + fire-and-forget — a handle-generation
        // failure must NOT block signup; the user can claim one manually later
        // from `/account/profile`. Idempotent: if the row already has a handle
        // (race, retry), the service short-circuits.
        await this.usersService.generateHandleForUser(this.getUserId(user)).catch((e) => {
          this.logger.warn(
            `[register] generateHandleForUser failed for ${this.getUserId(user)}: ${(e as Error)?.message ?? e}`,
          );
          Sentry.captureException(e, {
            tags: { module: 'auth', op: 'register.generateHandleForUser' },
            extra: { userId: this.getUserId(user) },
          });
        });

        const tokens = await this.generateTokens(this.getUserId(user), registerDto.platform);
        const platformAccess = await this.getPlatformAccess(this.getUserId(user));

        await this.sessionsService.createSessionForLogin(this.getUserId(user), tokens.accessToken, {
          deviceId: crypto.randomUUID(),
          deviceName: registerDto.deviceName || 'Unknown Device',
          platform:
            registerDto.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
          ipAddress: registerDto.ipAddress,
          userAgent: registerDto.userAgent,
        });

        // App Lock — newly-registered users have no PIN yet; issue a 5-min grace
        // window so the next API call doesn't 423-lock them before they reach the
        // /auth/setup-pin screen.
        await this.writeSetupGraceIfNeeded(this.getUserId(user), tokens.accessToken);

        this.auditAuthEvent({
          action: 'register_success',
          userId: this.getUserId(user),
          actorNameSnapshot: user.name,
          meta: {
            platform: registerDto.platform,
            viaEmail: !!registerDto.email,
            viaMobile: !!registerDto.mobile,
            variant: registerDto.workspace ? 'web-combined' : 'legacy',
            workspaceCreated: !!createdWorkspaceId,
            ...(createdWorkspaceId ? { workspaceId: createdWorkspaceId } : {}),
          },
        });

        // Connect Referral Program — best-effort, fire-and-forget attribution.
        // The user + session exist here; a referral failure must NEVER fail or
        // delay signup (the service is internally try/caught AND .catch-guarded).
        this.attachReferralBestEffort({
          refereeUserId: this.getUserId(user),
          code: registerDto.referralCode,
          ipAddress: registerDto.ipAddress,
          mobile: user.mobile,
          email: user.email,
        });

        if (createdWorkspaceId) {
          const distinctId = this.getUserId(user);
          this.postHog.identify({
            distinctId,
            properties: {
              email: registerDto.email,
              name: user.name,
              workspaceId: createdWorkspaceId,
            },
          });
          this.postHog.capture({
            distinctId,
            event: 'auth.signup_completed',
            properties: {
              mode: registerDto.email ? 'email' : 'mobile',
              variant: 'web-combined',
              workspaceId: createdWorkspaceId,
              tier: 'trial',
            },
          });
        }

        return {
          ...tokens,
          user: this.sanitizeUser(userAfterWorkspace) as unknown as User,
          isNewUser: true,
          platformAccess,
        };
      },
    );
  }

  /**
   * Resolve a User document's `_id` to its string form. Centralised so the
   * stringification call site is typed consistently across this service.
   */
  private getUserId(user: User): string {
    return user._id.toString();
  }

  /**
   * Fire-and-forget audit log for identity-layer events. Passes
   * `workspaceId: null` (auth events are tenant-agnostic) and stamps the
   * acting User as both `actorId` and `entityId` (the user is the entity
   * being audited). Errors are swallowed with a Logger.warn — audit failures
   * never block an auth flow, but they do surface in logs + Sentry for
   * follow-up.
   *
   * Public so collaborator services (SmsOtpService) can emit auth-event audit
   * rows without re-implementing the swallow-and-tag plumbing.
   */
  auditAuthEvent(input: {
    action: string;
    userId: string;
    actorNameSnapshot?: string;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: input.userId,
        action: input.action,
        actorId: input.userId,
        actorNameSnapshot: input.actorNameSnapshot,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for auth event ${input.action} (user ${input.userId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'auth', op: `audit.${input.action}` },
          extra: { userId: input.userId },
        });
      });
  }

  /**
   * Bind pending workspace-member invites to a freshly-created User so the
   * invites appear in `GET /me/invites/pending` for the user's first session.
   *
   * Public so SmsOtpService.verifyOtp can call it on the mobile-OTP signup
   * path (P1.4 2026-05-14 — previously only the email/web-combined register
   * branch ran this sweep, mobile-OTP signups orphaned matching invites).
   *
   * P1.4 hardening:
   *   - Matches on BOTH email AND mobile (was: one-or-the-other, email
   *     winning when both were provided).
   *   - Refuses to clobber an existing `userId` binding — only sets
   *     `userId` when the row's binding is null. A pre-bound invite is
   *     intentional (e.g. owner re-invited a known user); the auto-bind
   *     sweep MUST be additive, never destructive.
   *   - Does NOT auto-accept. The invite remains in `status: 'invited'`
   *     until the user explicitly clicks Accept from the switcher / bell
   *     / dedicated /invites page (per owner Q4 decision 2026-05-14).
   *
   * Failures are logged + Sentry-tagged but never thrown — a failed
   * invite-link must not block the signup itself.
   */
  async linkPendingInvitations(userId: string, email?: string, mobile?: string): Promise<void> {
    if (!email && !mobile) return;

    try {
      const memberModel = this.moduleRef.get<Model<WorkspaceMember>>(
        getModelToken(WorkspaceMember.name),
        { strict: false },
      );

      const identifierClauses: Array<Record<string, unknown>> = [];
      if (email) identifierClauses.push({ inviteeIdentifier: email, inviteeType: 'email' });
      if (mobile) identifierClauses.push({ inviteeIdentifier: mobile, inviteeType: 'mobile' });

      const pendingMembers = await memberModel
        .find({
          $or: identifierClauses,
          status: 'invited',
          inviteExpiry: { $gt: new Date() },
          // Defensive — only bind rows that don't already have a userId so
          // a pre-existing intentional binding is never overwritten.
          $and: [{ $or: [{ userId: null }, { userId: { $exists: false } }] }],
        })
        // Populated for the in-app notification dispatched below.
        .populate('workspaceId', 'name')
        .populate('roleId', 'name')
        .populate('invitedBy', 'name')
        .exec();

      if (pendingMembers.length === 0) return;

      const webAppUrl = this.configService.get<string>('app.webAppUrl') || 'https://app.manekhr.in';
      const mobileDeepLink =
        this.configService.get<string>('app.mobileDeepLink') || 'zari360://invite';

      for (const member of pendingMembers) {
        member.userId = new Types.ObjectId(userId);
        await member.save();
        const memberIdStr = member._id.toString();
        this.logger.log(
          `Auto-linked pending invitation ${memberIdStr} for user ${userId} ` +
            `(identifier=${member.inviteeIdentifier}, type=${member.inviteeType})`,
        );

        // Surface the freshly-bound invite in the user's in-app bell. Reuses
        // the canonical invite dispatcher with `channels: ['in_app']` so only
        // the in-app notification + mobile push fire — email/SMS already went
        // out when the invite was first created. Resolved via ModuleRef
        // (mirrors the model lookup above) so AuthService's constructor stays
        // unchanged. Per-invite try/catch — one failure must not block the
        // remaining binds, and a bind itself must never fail over a notify.
        try {
          const dispatcher = this.moduleRef.get(InviteNotificationDispatcher, { strict: false });
          const workspace = member.workspaceId as unknown as {
            _id: Types.ObjectId;
            name?: string;
          };
          const role = member.roleId as unknown as { name?: string } | undefined;
          const inviter = member.invitedBy as unknown as { name?: string } | undefined;
          const token = member.inviteToken;
          await dispatcher.dispatch({
            workspaceId: String(workspace._id),
            workspaceName: workspace?.name || 'a workspace',
            inviterName: inviter?.name || 'Someone',
            inviteeIdentifier: member.inviteeIdentifier ?? '',
            inviteeType: (member.inviteeType as 'email' | 'mobile') || 'email',
            inviteeUserId: userId,
            role: role?.name || 'Member',
            inviteUrl: token
              ? `${webAppUrl}/invite?token=${token}&type=workspace`
              : `${webAppUrl}/dashboard/invitations`,
            mobileDeepLink: token ? `${mobileDeepLink}/${token}` : mobileDeepLink,
            channels: ['in_app'],
          });
        } catch (notifyErr) {
          this.logger.warn(
            `linkPendingInvitations: in-app notification failed for member ` +
              `${memberIdStr}: ${(notifyErr as Error)?.message ?? notifyErr}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to link pending invitations for user ${userId}: ${(error as Error)?.message ?? error}`,
        (error as Error)?.stack,
      );
      Sentry.captureException(error, {
        tags: { module: 'auth', op: 'linkPendingInvitations' },
        extra: { userId },
      });
    }
  }

  async login(loginDto: LoginDto): Promise<AuthResult> {
    const user = await this.usersService.findByIdentifierWithCredentials(loginDto.identifier);
    if (!user) {
      // Per W4 spec: don't audit login failures for non-existent users
      // (avoids log noise for typo'd identifiers + would require a synthetic
      // actorId since the schema requires one).
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      // A DPDP self-serve deletion (accountDeletion.state==='pending') gets a
      // specific "scheduled for deletion — contact us to recover" message; every
      // other inactive account keeps the generic deactivated message (§A.2).
      const pendingDeletion = isPendingDeletion(user);
      this.auditAuthEvent({
        action: 'login_failure',
        userId: this.getUserId(user),
        actorNameSnapshot: user.name,
        meta: {
          reason: pendingDeletion ? 'scheduled_for_deletion' : 'account_deactivated',
          platform: loginDto.platform,
        },
      });
      throw buildSuspendedAccountError(user, env.accountDeletion.contactUrl);
    }

    if (!user.passwordHash) {
      this.auditAuthEvent({
        action: 'login_failure',
        userId: this.getUserId(user),
        actorNameSnapshot: user.name,
        meta: { reason: 'google_only_account', platform: loginDto.platform },
      });
      throw new UnauthorizedException(
        'This account is linked to Google. Please sign in with Google or set a password in your Profile Settings.',
      );
    }

    const isMatch = await bcrypt.compare(loginDto.password, user.passwordHash);
    if (!isMatch) {
      this.auditAuthEvent({
        action: 'login_failure',
        userId: this.getUserId(user),
        actorNameSnapshot: user.name,
        meta: { reason: 'invalid_password', platform: loginDto.platform },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(this.getUserId(user), loginDto.platform);
    const platformAccess = await this.getPlatformAccess(this.getUserId(user));

    await this.sessionsService.createSessionForLogin(this.getUserId(user), tokens.accessToken, {
      deviceId: crypto.randomUUID(),
      deviceName: loginDto.deviceName || 'Unknown Device',
      platform:
        loginDto.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
      ipAddress: loginDto.ipAddress,
      userAgent: loginDto.userAgent,
    });

    // App Lock — write setup-grace key for users who haven't set a PIN yet
    // (existing users hit this on first login post-deploy; new Google users
    // hit it after register too). No-op for users with a PIN already set.
    await this.writeSetupGraceIfNeeded(this.getUserId(user), tokens.accessToken);

    this.auditAuthEvent({
      action: 'login_success',
      userId: this.getUserId(user),
      actorNameSnapshot: user.name,
      meta: { platform: loginDto.platform },
    });

    return {
      ...tokens,
      user: this.sanitizeUser(user) as unknown as User,
      isNewUser: false,
      platformAccess,
    };
  }

  /**
   * Atomic credential-validate + terminate-target-session + issue-new-tokens
   * for the unauthenticated session-limit modal flow. Reuses the same
   * credential checks as login(); diverges only by replacing the createSession
   * call with `sessionsService.terminateAndCreate` (which hard-revokes the
   * target session via the existing token-hash denylist before issuing the
   * new one).
   */
  async terminateAndLoginUnauth(dto: TerminateAndLoginUnauthDto): Promise<AuthResult> {
    const user = await this.usersService.findByIdentifierWithCredentials(dto.identifier);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      throw buildSuspendedAccountError(user, env.accountDeletion.contactUrl);
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account is linked to Google. Please sign in with Google or set a password in your Profile Settings.',
      );
    }
    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const userIdStr = this.getUserId(user);
    const tokens = await this.generateTokens(userIdStr, dto.platform);
    const platformAccess = await this.getPlatformAccess(userIdStr);

    await this.sessionsService.terminateAndCreate(userIdStr, dto.sessionId, tokens.accessToken, {
      deviceId: crypto.randomUUID(),
      deviceName: dto.deviceName || 'Unknown Device',
      platform: dto.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    // App Lock — same grace as login() path.
    await this.writeSetupGraceIfNeeded(userIdStr, tokens.accessToken);

    this.auditAuthEvent({
      action: 'login_success',
      userId: userIdStr,
      actorNameSnapshot: user.name,
      meta: {
        platform: dto.platform,
        variant: 'terminate_and_login',
        terminatedSessionId: dto.sessionId,
      },
    });

    return {
      ...tokens,
      user: this.sanitizeUser(user) as unknown as User,
      isNewUser: false,
      platformAccess,
    };
  }

  /**
   * Auth-success finaliser shared by login/register/google + SmsOtpService.
   * Issues tokens, creates the session row (or terminates a target row first
   * via session-limit modal flow), writes the App-Lock setup grace, audits,
   * and returns a fully-shaped `AuthResult`. Mirrors the work currently
   * inlined in `login()` / `register()` so SmsOtpService can avoid copying.
   *
   * Throws `SESSION_LIMIT_REACHED` from `sessionsService.createSession` when
   * the user is at their session cap — controller surface re-throws.
   */
  async finalizeAuthSuccess(opts: {
    user: User;
    platform?: Platform;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
    isNewUser?: boolean;
    mustResetPassword?: boolean;
    auditAction: string;
    auditMeta?: Record<string, unknown>;
    /** When set, terminates this session FIRST then issues the new pair. */
    terminateSessionId?: string;
  }): Promise<AuthResult> {
    const userIdStr = this.getUserId(opts.user);
    // When `mustResetPassword` is set (today: only the SMS-OTP forgot path)
    // embed `forgotPasswordReset: true` in the JWT so the subsequent
    // /users/change-password call can skip the "current password" check
    // server-side. The claim is single-session — the change-password handler
    // revokes this jti and re-issues a fresh pair without the claim once the
    // password is reset.
    const tokens = await this.generateTokens(
      userIdStr,
      opts.platform,
      opts.mustResetPassword ? { forgotPasswordReset: true } : undefined,
    );
    const platformAccess = await this.getPlatformAccess(userIdStr);

    const deviceInfo = {
      deviceId: crypto.randomUUID(),
      deviceName: opts.deviceName || 'Unknown Device',
      platform: opts.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
      ipAddress: opts.ipAddress,
      userAgent: opts.userAgent,
    };

    if (opts.terminateSessionId) {
      await this.sessionsService.terminateAndCreate(
        userIdStr,
        opts.terminateSessionId,
        tokens.accessToken,
        deviceInfo,
      );
    } else {
      // Newest-device-wins (2026-06-14): evict-oldest instead of throwing at
      // the session cap, matching login()/register()/Google. The explicit
      // `terminateSessionId` branch above stays for the modal-chosen flow.
      await this.sessionsService.createSessionForLogin(userIdStr, tokens.accessToken, deviceInfo);
    }

    await this.writeSetupGraceIfNeeded(userIdStr, tokens.accessToken);

    this.auditAuthEvent({
      action: opts.auditAction,
      userId: userIdStr,
      actorNameSnapshot: opts.user.name,
      meta: opts.auditMeta,
    });

    return {
      ...tokens,
      user: this.sanitizeUser(opts.user) as unknown as User,
      isNewUser: opts.isNewUser,
      platformAccess,
      ...(opts.mustResetPassword ? { mustResetPassword: true } : {}),
    };
  }

  /**
   * Audit a failed/blocked OTP attempt where no User exists yet (register-flow
   * unknown phone, anti-enumeration silent-success, etc.). Uses the configured
   * SYSTEM_USER_ID as the actor — schema requires a non-null actorId.
   */
  auditAnonOtpEvent(input: {
    action: string;
    mobileMasked: string;
    meta?: Record<string, unknown>;
  }): void {
    const systemUserId = env.systemUserId;
    void this.auditService
      .logEvent({
        workspaceId: null,
        module: AppModule.AUTH,
        entityType: 'auth_event',
        entityId: systemUserId,
        action: input.action,
        actorId: systemUserId,
        actorNameSnapshot: `Anonymous (mobile: ${input.mobileMasked})`,
        meta: { ...input.meta, mobileMasked: input.mobileMasked },
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for anon OTP event ${input.action} (${input.mobileMasked}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'auth', op: `audit.${input.action}` },
          extra: { mobileMasked: input.mobileMasked },
        });
      });
  }

  private async getPlatformAccess(userId: string): Promise<PlatformAccess> {
    const subscription = await this.subscriptionsService.getUserSubscription(userId);
    if (!subscription) {
      return PlatformAccess.BOTH;
    }

    const entitlements = subscription.appliedEntitlements || subscription.planId?.entitlements;
    const platformAccess = entitlements?.platformAccess;

    if (!platformAccess || platformAccess === PlatformAccess.BOTH) {
      return PlatformAccess.BOTH;
    }
    if (platformAccess === PlatformAccess.WEB_ONLY) {
      return PlatformAccess.WEB_ONLY;
    }
    if (platformAccess === PlatformAccess.MOBILE_ONLY) {
      return PlatformAccess.MOBILE_ONLY;
    }
    return PlatformAccess.BOTH;
  }

  /**
   * Normalise a Google credential from EITHER kind of token the clients send:
   *  - an OIDC **ID token** (JWT) - the mobile app (`@react-native-google-signin`,
   *    via the web client id) and any GIS One-Tap `credential`; verified locally
   *    by signature + audience.
   *  - an OAuth **access token** - the web app (`@react-oauth/google`
   *    `useGoogleLogin` implicit flow returns `access_token`, not an id_token);
   *    validated by calling Google's tokeninfo (to confirm it was minted for OUR
   *    client - anti token-substitution) then userinfo (for the profile).
   *
   * Cross-module: used by `googleAuth` (login) and the forgot-PIN google branch.
   * Keep the audience check tied to `google.clientId`, which MUST equal the web
   * OAuth client used by web + mobile (see .env GOOGLE_CLIENT_ID).
   */
  private async resolveGoogleIdentity(token: string): Promise<{
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
    emailVerified?: boolean;
  }> {
    const clientId = this.configService.get<string>('google.clientId');

    // 1) ID-token path (mobile + GIS credential). Local verify; no network call.
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: token,
        audience: clientId,
      });
      const p = ticket.getPayload();
      if (p?.sub) {
        return {
          sub: p.sub,
          email: p.email,
          name: p.name,
          picture: p.picture,
          emailVerified: p.email_verified,
        };
      }
    } catch {
      // Not a valid ID token - fall through to the access-token path (web).
    }

    // 2) Access-token path (web implicit flow). Verify the token was issued for
    // OUR client before trusting it, then read the profile.
    const tiRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
    );
    if (!tiRes.ok) {
      throw new BadRequestException('Invalid Google token');
    }
    const ti = (await tiRes.json()) as {
      aud?: string;
      azp?: string;
      sub?: string;
      email?: string;
      email_verified?: string | boolean;
    };
    if (ti.aud !== clientId && ti.azp !== clientId) {
      throw new BadRequestException('Google token was issued for a different app');
    }

    let sub = ti.sub;
    let email = ti.email;
    let emailVerified = ti.email_verified === true || ti.email_verified === 'true';
    let name: string | undefined;
    let picture: string | undefined;

    // userinfo fills name/picture (and email when the email scope was granted).
    const uiRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (uiRes.ok) {
      const ui = (await uiRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      sub = sub || ui.sub;
      email = email || ui.email;
      emailVerified = emailVerified || !!ui.email_verified;
      name = ui.name;
      picture = ui.picture;
    }

    if (!sub) {
      throw new BadRequestException('Invalid Google token');
    }
    return { sub, email, name, picture, emailVerified };
  }

  async googleAuth(googleDto: GoogleAuthDto): Promise<AuthResult> {
    try {
      // Accepts a web access_token OR a mobile/GIS id_token (see resolveGoogleIdentity).
      const payload = await this.resolveGoogleIdentity(googleDto.idToken);

      if (!payload || !payload.email) {
        throw new BadRequestException('Invalid Google token');
      }

      let user = await this.usersService.findByGoogleId(payload.sub);
      let isNewUser = false;

      if (!user) {
        // Fallback check by email if googleId not yet linked
        user = await this.usersService.findByIdentifier(payload.email);

        if (user) {
          // Link existing account with Google
          user = await this.usersService.update(this.getUserId(user), {
            googleId: payload.sub,
            isEmailVerified: true,
          });
        } else {
          // Create new user
          isNewUser = true;
          user = await this.usersService.create({
            email: payload.email,
            name: payload.name || 'Google User',
            googleId: payload.sub,
            isEmailVerified: true,
            profilePicture: payload.picture,
          });
          // Auto-assign free subscription for new Google users
          await this.subscriptionsService
            .createFreeSubscription(this.getUserId(user), 'self')
            .catch((e) => {
              this.logger.warn(
                `[googleAuth] createFreeSubscription failed for ${this.getUserId(user)}: ${(e as Error)?.message ?? e}`,
              );
              Sentry.captureException(e, {
                tags: {
                  module: 'auth',
                  op: 'googleAuth.createFreeSubscription',
                },
                extra: { userId: this.getUserId(user) },
              });
            });
          // Same fire-and-forget handle generation as the email-register path.
          await this.usersService.generateHandleForUser(this.getUserId(user)).catch((e) => {
            this.logger.warn(
              `[googleAuth] generateHandleForUser failed for ${this.getUserId(user)}: ${(e as Error)?.message ?? e}`,
            );
            Sentry.captureException(e, {
              tags: { module: 'auth', op: 'googleAuth.generateHandleForUser' },
              extra: { userId: this.getUserId(user) },
            });
          });
        }
      }

      if (!user.isActive) {
        throw buildSuspendedAccountError(user, env.accountDeletion.contactUrl);
      }

      const tokens = await this.generateTokens(this.getUserId(user), googleDto.platform);
      const platformAccess = await this.getPlatformAccess(this.getUserId(user));

      await this.sessionsService.createSessionForLogin(this.getUserId(user), tokens.accessToken, {
        deviceId: crypto.randomUUID(),
        deviceName: googleDto.deviceName || 'Unknown Device',
        platform:
          googleDto.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
        ipAddress: googleDto.ipAddress,
        userAgent: googleDto.userAgent,
      });

      // App Lock — Google sign-in users without a PIN get the same grace.
      await this.writeSetupGraceIfNeeded(this.getUserId(user), tokens.accessToken);

      this.auditAuthEvent({
        action: 'oauth_google_success',
        userId: this.getUserId(user),
        actorNameSnapshot: user.name,
        meta: { platform: googleDto.platform, isNewUser },
      });

      return {
        ...tokens,
        user: this.sanitizeUser(user) as unknown as User,
        isNewUser,
        platformAccess,
      };
    } catch (e) {
      this.logger.error(
        `Google authentication failed: ${(e as Error)?.message ?? e}`,
        (e as Error)?.stack,
      );
      Sentry.captureException(e, {
        tags: { module: 'auth', op: 'googleAuth' },
      });
      throw new UnauthorizedException(
        'Google authentication failed: ' + ((e as Error)?.message || 'Unknown error'),
      );
    }
  }

  async refreshToken(refreshDto: RefreshTokenDto, oldAccessToken?: string): Promise<RefreshResult> {
    // OQ-1: refreshToken is now optional in the DTO (web supplies it via the
    // httpOnly cookie, resolved cookie-first in the controller). If neither the
    // cookie nor the body produced one, fail closed — never mint a new pair.
    if (!refreshDto.refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    try {
      const payload = this.jwtService.verify<AuthJwtPayload>(refreshDto.refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      // Refresh route is @Public so JwtAuthGuard never runs — re-check the jti
      // denylist here so a logged-out refresh token can't be used to mint new
      // tokens. Fail-open on Redis errors (mirrors guard's pattern).
      if (payload?.jti) {
        try {
          const revoked = await this.redis.get(`denylist:jti:${payload.jti}`);
          if (revoked) {
            throw new UnauthorizedException('Token has been revoked');
          }
        } catch (jtiErr) {
          if (jtiErr instanceof UnauthorizedException) throw jtiErr;
          this.logger.warn(
            `[refreshToken] jti denylist check failed, allowing refresh: ${(jtiErr as Error)?.message ?? jtiErr}`,
          );
        }
      }

      const user = await this.usersService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException('User no longer exists');
      }

      // Carry the session family across the refresh so App-Lock unlock state
      // (keyed to `family`) survives token rotation.
      const tokens = await this.generateTokens(
        this.getUserId(user),
        payload.platform,
        undefined,
        payload.family,
      );
      const platformAccess = await this.getPlatformAccess(this.getUserId(user));

      try {
        // A refresh ROTATES an existing session — it must net-zero the active
        // session count, not add a row. Step 1: retire the rotated-out token's
        // session row precisely (the FE forwards the old access token in the
        // Bearer header; the row is keyed by token hash so even an expired token
        // matches). Step 2: create the new row via the refresh-specific path,
        // which EVICTS the oldest session(s) instead of throwing if somehow at
        // the cap — so a refresh never balloons the count and never rejects an
        // active session. (Previously this called createSession, which inserted
        // a new row every refresh while leaving the old one active when the FE
        // didn't forward the token — the cause of the runaway session count —
        // and whose SESSION_LIMIT_REACHED throw was swallowed below, so refresh
        // returned 201 while silently doing nothing once the cap was hit.)
        if (oldAccessToken) {
          const oldHash = crypto.createHash('sha256').update(oldAccessToken).digest('hex');
          await this.sessionsService.invalidateSessionByTokenHash(oldHash, this.getUserId(user));
        }
        await this.sessionsService.createSessionForRefresh(
          this.getUserId(user),
          tokens.accessToken,
          {
            deviceId: crypto.randomUUID(),
            deviceName: refreshDto.deviceName || 'Unknown Device',
            platform:
              payload.platform === Platform.MOBILE ? SessionPlatform.MOBILE : SessionPlatform.WEB,
            ipAddress: refreshDto.ipAddress,
            userAgent: refreshDto.userAgent,
          },
        );

        // App Lock — refresh issues a new jti so a fresh grace key is needed
        // for users still without a PIN.
        await this.writeSetupGraceIfNeeded(this.getUserId(user), tokens.accessToken);
      } catch (sessionErr) {
        // The rotation path no longer throws on the session cap (it evicts),
        // so this now only catches genuine bookkeeping failures (e.g. Mongo/Redis
        // hiccup). A refresh still succeeds — we don't fail a token rotation over
        // a session-row write — but the failure is logged + Sentry-tagged.
        this.logger.warn(
          `Session management during refresh failed: ${(sessionErr as Error)?.message ?? sessionErr}`,
        );
        Sentry.captureException(sessionErr, {
          tags: { module: 'auth', op: 'refreshToken.sessionMgmt' },
        });
      }

      return { ...tokens, platformAccess };
    } catch (e) {
      // JWT verify failures are expected (expired/invalid tokens) — don't spam
      // Sentry. Capture only unexpected errors (e.g. Redis denylist explosions
      // surfacing through the inner try, DB outages on findById).
      if (
        !(e instanceof UnauthorizedException) &&
        (e as Error)?.name !== 'JsonWebTokenError' &&
        (e as Error)?.name !== 'TokenExpiredError' &&
        (e as Error)?.name !== 'NotBeforeError'
      ) {
        this.logger.warn(`Unexpected refreshToken failure: ${(e as Error)?.message ?? e}`);
        Sentry.captureException(e, {
          tags: { module: 'auth', op: 'refreshToken' },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async generateTokens(
    userId: string,
    platform?: Platform,
    extraClaims?: { forgotPasswordReset?: true },
    family?: string,
  ) {
    return issueTokens(this.jwtService, this.configService, userId, platform, extraClaims, family);
  }

  /**
   * Revoke a logout pair by writing each token's jti into a Redis denylist
   * with TTL = remaining lifetime of the token. JwtAuthGuard checks this
   * denylist on every authenticated request and rejects revoked jtis.
   *
   * Decoding (not verifying) is intentional — the access token was just
   * verified by JwtAuthGuard before this controller method ran, and a forged
   * refresh token only causes a wasted Redis write (no security risk). If
   * Redis is down we log + swallow so logout still returns 200 to the client.
   */
  async revokeTokens(
    refreshToken: string,
    accessToken?: string,
    actorUserId?: string,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);

    const tokens = [
      { label: 'access', value: accessToken },
      { label: 'refresh', value: refreshToken },
    ];

    for (const { label, value } of tokens) {
      if (!value) continue;
      try {
        const decoded: DecodedJwtMeta | null = this.jwtService.decode(value);
        const jti = decoded?.jti;
        const exp = decoded?.exp;
        if (!jti || !exp) {
          this.logger.warn(
            `[revokeTokens] ${label} token missing jti/exp — skipping (likely a legacy token signed before jti was added).`,
          );
          continue;
        }
        const ttl = exp - nowSec;
        if (ttl <= 0) {
          // Already expired — no need to denylist.
          continue;
        }
        await this.redis.set(`denylist:jti:${jti}`, '1', 'EX', ttl);

        // App Lock — also drop the unlock + setup-grace Redis keys so a
        // resurrected token (somehow) cannot reuse them.
        await this.redis.del(`unlocked:jti:${jti}`).catch(() => undefined);
        await this.redis.del(`setup-grace:jti:${jti}`).catch(() => undefined);
        if (decoded?.family) {
          await this.redis.del(`unlocked:fam:${decoded.family}`).catch(() => undefined);
          await this.redis.del(`setup-grace:fam:${decoded.family}`).catch(() => undefined);
        }
      } catch (err) {
        this.logger.warn(
          `[revokeTokens] Failed to denylist ${label} token: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    // Deactivate the session row so countActiveSessions stops counting it
    // toward the per-user limit. Without this, repeated logout/login cycles
    // would trip SESSION_LIMIT_REACHED even though the prior tokens are
    // already denylisted. The session row maps to the access token's hash;
    // we mirror what `refreshToken` does for the rotated-out token.
    //
    // Errors here MUST surface to the controller — the prior silent-swallow
    // path let the caller's session row stay `isActive: true` while the
    // client thought logout succeeded, causing the just-logged-out device
    // to keep showing as active in /dashboard/settings/devices on other
    // surfaces until the JWT TTL fired (up to 7 days).
    if (accessToken && actorUserId) {
      const accessHash = crypto.createHash('sha256').update(accessToken).digest('hex');
      this.logger.log(
        `[revokeTokens] Deactivating session row for user ${actorUserId} hash ${accessHash.slice(0, 12)}...`,
      );
      await this.sessionsService.invalidateSessionByTokenHash(accessHash, actorUserId);
    }

    // Audit the logout — actorUserId is the JwtAuthGuard-resolved caller from
    // the controller. If it's missing (e.g. legacy callers passing only the
    // tokens) we skip the audit rather than synthesizing an actor.
    if (actorUserId) {
      this.auditAuthEvent({
        action: 'logout_success',
        userId: actorUserId,
      });
    }
  }

  /**
   * Complete a forgot-password reset for a session that was authenticated via
   * the SMS-OTP forgot flow. The controller (`POST /auth/change-password-after-forgot`)
   * gates entry on `req.user.forgotPasswordReset === true` so we don't need
   * to re-check the claim here — but we DO need to:
   *
   *   1. Hash + persist the new password.
   *   2. Denylist the old access + refresh jtis (so the still-valid old
   *      tokens, which carry the `forgotPasswordReset` claim, can't be
   *      replayed against this same endpoint).
   *   3. Deactivate the old session row (so it stops counting toward the
   *      per-user session limit).
   *   4. Issue a fresh token pair WITHOUT the claim (default
   *      `mustResetPassword: false` path inside `finalizeAuthSuccess`).
   *
   * Returns the fresh `AuthResult` so the FE can swap tokens immediately.
   */
  async completeForgotPasswordReset(opts: {
    userId: string;
    newPassword: string;
    // OQ-1: optional — web supplies the old refresh token via cookie (resolved
    // in the controller), mobile via body. Only used to denylist the old pair.
    refreshToken?: string;
    accessToken?: string;
    platform?: Platform;
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthResult> {
    return this.withAuthSpan(
      'auth.changePasswordAfterForgot',
      { userId: opts.userId },
      async () => {
        const user = await this.usersService.findById(opts.userId);
        if (!user) {
          throw new UnauthorizedException();
        }

        // 1. Hash + persist new password.
        const salt = await bcrypt.genSalt(12);
        const passwordHash = await bcrypt.hash(opts.newPassword, salt);
        await this.usersService.update(opts.userId, { passwordHash });

        // 2 + 3. Denylist old jtis + deactivate old session row. We deliberately
        //        DO NOT call `revokeTokens` because it audits a `logout_success`
        //        event — that would be misleading. We emit
        //        `password_reset_via_forgot_otp` via finalizeAuthSuccess below.
        const nowSec = Math.floor(Date.now() / 1000);
        for (const value of [opts.accessToken, opts.refreshToken]) {
          if (!value) continue;
          try {
            const decoded: DecodedJwtMeta | null = this.jwtService.decode(value);
            const jti = decoded?.jti;
            const exp = decoded?.exp;
            if (!jti || !exp) continue;
            const ttl = exp - nowSec;
            if (ttl <= 0) continue;
            await this.redis.set(`denylist:jti:${jti}`, '1', 'EX', ttl);
            // Drop both the family-keyed and the legacy jti-keyed App-Lock keys.
            await this.redis.del(`unlocked:jti:${jti}`).catch(() => undefined);
            await this.redis.del(`setup-grace:jti:${jti}`).catch(() => undefined);
            if (decoded?.family) {
              await this.redis.del(`unlocked:fam:${decoded.family}`).catch(() => undefined);
              await this.redis.del(`setup-grace:fam:${decoded.family}`).catch(() => undefined);
            }
          } catch (err) {
            this.logger.warn(
              `[completeForgotPasswordReset] denylist failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            );
          }
        }
        if (opts.accessToken) {
          const accessHash = crypto.createHash('sha256').update(opts.accessToken).digest('hex');
          await this.sessionsService
            .invalidateSessionByTokenHash(accessHash, opts.userId)
            .catch((err: unknown) => {
              this.logger.warn(
                `[completeForgotPasswordReset] session invalidate failed: ${err instanceof Error ? err.message : 'unknown error'}`,
              );
            });
        }

        // 4. Issue fresh pair WITHOUT the claim. mustResetPassword defaults to
        //    false — finalizeAuthSuccess only embeds the claim when explicitly
        //    set. Audits `password_reset_via_forgot_otp`.
        const refreshed = (await this.usersService.findById(opts.userId)) ?? user;
        const result = await this.finalizeAuthSuccess({
          user: refreshed,
          platform: opts.platform,
          deviceName: opts.deviceName,
          ipAddress: opts.ipAddress,
          userAgent: opts.userAgent,
          isNewUser: false,
          auditAction: 'password_reset_via_forgot_otp',
          auditMeta: { variant: 'otp_forgot_password_change' },
        });

        this.postHog.capture({
          distinctId: opts.userId,
          event: 'auth.forgot_completed',
          properties: { mode: refreshed.email ? 'email' : 'mobile' },
        });

        return result;
      },
    );
  }

  /**
   * Email-flow forgot-password. Anti-enumeration: returns the same generic
   * success whether the identifier matches a User or not.
   *
   * On match:
   *   1. Mint a 256-bit raw token (`crypto.randomBytes(32).toString('hex')`).
   *   2. bcrypt-hash it and persist as `resetPasswordTokenHash` with a
   *      15-min `resetPasswordExpiresAt`.
   *   3. Email the unhashed token via `MailService.sendPasswordResetEmail`.
   *      Mail-send failures are logged + Sentry'd but never bubble to the
   *      caller — the response is identical to the "no such user" case.
   *
   * Single-use: `AuthService.resetPassword` clears the hash + expiry on
   * successful reset.
   */
  /**
   * Mint a 6-digit registration OTP, JWT-sign it, store in Redis keyed by
   * email, and dispatch via MailService. Mirrors the SMS-OTP register flow:
   *   - Anti-enumeration silent-success when the email is already registered
   *     (audit logs the differentiator so ops can spot probing).
   *   - Per-email + per-IP sliding-window rate limit (reuses authOtp config).
   *   - Idempotency window keyed by (email, register) — same as SMS.
   * Returns a generic shape regardless of branch so the FE always reaches the
   * OTP-entry screen.
   */
  async sendEmailRegistrationOtp(
    email: string,
    ipAddress?: string,
  ): Promise<{
    ok: true;
    sent: true;
    expiresAt: string;
    resendCooldownSec: number;
  }> {
    return this.withAuthSpan(
      'auth.sendEmailRegistrationOtp',
      { 'email.domain': email.split('@')[1] ?? '' },
      async () => {
        const normEmail = email.trim().toLowerCase();

        // Block known disposable / throwaway inboxes (yopmail, mailinator, …)
        // BEFORE spending an OTP send. Gated by env so it can be switched off
        // instantly. See utils/disposable-email.ts. Backstopped in register().
        if (env.signup.blockDisposableEmail && isDisposableEmailDomain(normEmail)) {
          throw new BadRequestException({
            code: 'DISPOSABLE_EMAIL_BLOCKED',
            message:
              'Please use a permanent email address. Temporary email providers are not allowed.',
          });
        }

        const expiresInSec = Math.floor(env.authOtp.expiryMs / 1000);
        const expiresAt = new Date(Date.now() + env.authOtp.expiryMs);
        const resendCooldownSec = env.authOtp.resendCooldownSec;

        const generic = {
          ok: true as const,
          sent: true as const,
          expiresAt: expiresAt.toISOString(),
          resendCooldownSec,
        };

        // Per-email hourly + daily caps + per-IP daily.
        const hourly = await checkSlidingWindow(this.redis, `email-otp:hourly:${normEmail}`, {
          windowSec: 3600,
          limit: env.authOtp.rateLimitHourly,
        });
        if (!hourly.allowed) {
          throw new HttpException(
            {
              code: 'OTP_RATE_LIMITED',
              message: `Too many verification codes for this email. Try again in ${hourly.retryAfterSec}s.`,
              retryAfterSec: hourly.retryAfterSec,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        const daily = await checkSlidingWindow(this.redis, `email-otp:daily:${normEmail}`, {
          windowSec: 86400,
          limit: env.authOtp.rateLimitDaily,
        });
        if (!daily.allowed) {
          throw new HttpException(
            {
              code: 'OTP_RATE_LIMITED',
              message: `Daily verification-code limit reached for this email.`,
              retryAfterSec: daily.retryAfterSec,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        if (ipAddress) {
          const ipDaily = await checkSlidingWindow(this.redis, `email-otp:ip:daily:${ipAddress}`, {
            windowSec: 86400,
            limit: env.authOtp.perIpDaily,
          });
          if (!ipDaily.allowed) {
            throw new HttpException(
              {
                code: 'OTP_RATE_LIMITED',
                message: 'Too many verification codes from this network.',
                retryAfterSec: ipDaily.retryAfterSec,
              },
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
        }

        // Anti-enum: silent success when email is already registered (mirror SMS
        // register flow). Audit so ops can spot probing.
        const existing = await this.usersService.findByIdentifier(normEmail);
        if (existing) {
          const systemUserId = env.systemUserId;
          void this.auditService
            .logEvent({
              workspaceId: null,
              module: AppModule.AUTH,
              entityType: 'auth_event',
              entityId: systemUserId,
              actorId: systemUserId,
              action: 'email_otp_send_blocked_existing_user',
              actorNameSnapshot: 'Anonymous',
              meta: { channel: 'email', flowType: 'register' },
            })
            .catch(() => undefined);
          return generic;
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        const token = await this.jwtService.signAsync(
          {
            otp,
            email: normEmail,
            flowType: 'register',
            type: 'email-otp',
          } satisfies Omit<EmailOtpJwtPayload, 'iat' | 'exp'>,
          {
            secret: this.configService.get<string>('jwt.accessSecret'),
            expiresIn: `${expiresInSec}s`,
          },
        );
        await this.redis.set(`pending-email-otp:register:${normEmail}`, token, 'EX', expiresInSec);

        try {
          await this.mailService.sendEmailRegistrationOtp(
            normEmail,
            otp,
            Math.floor(env.authOtp.expiryMs / 60_000),
          );
        } catch (err) {
          // Mail-send failure is observable to the user (UX) but we don't leak
          // SMTP detail. Log + Sentry for ops; the OTP key stays in Redis so
          // a subsequent dev-fix retry can re-send without minting a new code.
          this.logger.warn(
            `[sendEmailRegistrationOtp] dispatch failed for ${normEmail}: ${(err as Error)?.message ?? err}`,
          );
          Sentry.captureException(err, {
            tags: { module: 'auth', op: 'sendEmailRegistrationOtp' },
            extra: { email: normEmail },
          });
          throw new HttpException(
            {
              code: 'EMAIL_OTP_DISPATCH_FAILED',
              message: 'Could not send the verification code. Please try again in a moment.',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }

        void this.auditService
          .logEvent({
            workspaceId: null,
            module: AppModule.AUTH,
            entityType: 'auth_event',
            entityId: env.systemUserId,
            actorId: env.systemUserId,
            action: 'email_otp_sent',
            actorNameSnapshot: 'Anonymous',
            meta: { channel: 'email', flowType: 'register' },
          })
          .catch(() => undefined);

        return generic;
      },
    );
  }

  /**
   * Verify a 6-digit registration OTP against the JWT stored in Redis. On
   * match the Redis key is cleared (single-use). Throws BadRequestException
   * with discriminating codes so the FE can show specific errors:
   *   - OTP_NOT_REQUESTED: no pending JWT for this email
   *   - OTP_EXPIRED: JWT decode failed with TokenExpiredError
   *   - OTP_INVALID: any other decode/shape error
   *   - OTP_INCORRECT: code mismatch (constant-time compare)
   */
  private async consumeEmailRegistrationOtp(email: string, otp: string): Promise<void> {
    const normEmail = email.trim().toLowerCase();
    const key = `pending-email-otp:register:${normEmail}`;
    const stored = await this.redis.get(key);
    if (!stored) {
      throw new BadRequestException({
        code: 'OTP_NOT_REQUESTED',
        message: 'Please request a verification code first.',
      });
    }
    let payload: EmailOtpJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<EmailOtpJwtPayload>(stored, {
        secret: this.configService.get<string>('jwt.accessSecret'),
      });
    } catch (e) {
      if ((e as Error)?.name === 'TokenExpiredError') {
        throw new BadRequestException({
          code: 'OTP_EXPIRED',
          message: 'Code expired. Tap Resend to get a new one.',
        });
      }
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'Invalid code. Please try again.',
      });
    }
    if (
      payload.type !== 'email-otp' ||
      payload.flowType !== 'register' ||
      payload.email !== normEmail
    ) {
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'Invalid code.',
      });
    }
    const submitted = Buffer.from(otp.padStart(6, '0'));
    const expected = Buffer.from(payload.otp.padStart(6, '0'));
    if (submitted.length !== expected.length || !crypto.timingSafeEqual(submitted, expected)) {
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code. Please try again.',
      });
    }
    // Clear key so the OTP cannot be reused (single-use semantics — same as
    // SmsOtpService.clearOtpState for register flow).
    await this.redis.del(key).catch(() => undefined);
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<{ message: string }> {
    // Explicit-feedback policy (decided 2026-05-09 for SMB owner audience):
    //   - Unknown identifier → 400 IDENTIFIER_NOT_REGISTERED so the user
    //     immediately knows to retype or sign up. Anti-enumeration is left
    //     to the upstream rate-limiter (5/min per IP on this endpoint).
    //   - Account exists but has no email on file → 400 EMAIL_NOT_ON_FILE
    //     with a "use mobile OTP instead" hint. Mobile-only legacy users
    //     have no inbox to mail to.
    //   - Mail-send failures still don't leak: caller sees a generic 500
    //     so ops can debug without surfacing SMTP/template issues to users.
    const user = await this.usersService.findByIdentifier(forgotPasswordDto.identifier);
    if (!user) {
      const systemUserId = env.systemUserId;
      void this.auditService
        .logEvent({
          workspaceId: null,
          module: AppModule.AUTH,
          entityType: 'auth_event',
          entityId: systemUserId,
          actorId: systemUserId,
          action: 'password_reset_unknown_identifier',
          actorNameSnapshot: 'Anonymous',
          meta: {
            channel: 'email',
            identifierShape: this.shapeOfIdentifier(forgotPasswordDto.identifier),
          },
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : 'unknown error';
          this.logger.warn(`[forgotPassword] audit unknown-identifier failed: ${detail}`);
        });
      throw new BadRequestException({
        code: 'IDENTIFIER_NOT_REGISTERED',
        message: 'No account found with that email or mobile number.',
      });
    }

    if (!user.email) {
      throw new BadRequestException({
        code: 'EMAIL_NOT_ON_FILE',
        message:
          'This account has no email on file. Reset your password using your mobile number instead.',
      });
    }

    try {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await bcrypt.hash(rawToken, 12);
      const expiresAt = new Date(Date.now() + 15 * 60_000);

      await this.usersService.update(this.getUserId(user), {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: expiresAt,
      } as Partial<User>);

      await this.mailService.sendPasswordResetEmail(
        { email: user.email, name: user.name },
        rawToken,
      );

      this.auditAuthEvent({
        action: 'password_reset_link_sent',
        userId: this.getUserId(user),
        actorNameSnapshot: user.name,
        meta: { channel: 'email' },
      });

      return {
        message: 'A password reset link has been sent to your email.',
      };
    } catch (err) {
      // Mail-send / token-persist failure. Don't leak SMTP details — log +
      // Sentry, return a generic 500 so the user knows to retry without
      // assuming their account state is broken.
      this.logger.warn(
        `[forgotPassword] reset-link dispatch failed for user ${this.getUserId(user)}: ${(err as Error)?.message ?? err}`,
      );
      Sentry.captureException(err, {
        tags: { module: 'auth', op: 'forgotPassword' },
        extra: { userId: this.getUserId(user) },
      });
      throw new HttpException(
        {
          code: 'RESET_DISPATCH_FAILED',
          message: 'Could not send the reset link right now. Please try again in a moment.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Coarse classifier used in audit metadata when we don't have a userId to
   * attach. Avoids logging the raw identifier (which may be PII / a typo'd
   * email belonging to a different person).
   */
  private shapeOfIdentifier(identifier: string): 'email' | 'mobile' | 'other' {
    const trimmed = identifier.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'email';
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) return 'mobile';
    return 'other';
  }

  /**
   * Consume a single-use email reset link. The raw token is bcrypt-compared
   * against `User.resetPasswordTokenHash` for every candidate User whose
   * `resetPasswordExpiresAt` is in the future. First match wins; the hash
   * + expiry are cleared on success so the token cannot be reused.
   *
   * Returns a generic `Invalid or expired reset token` for ALL failure
   * shapes (no candidate found, bcrypt mismatch, expired) so attackers can't
   * differentiate token-shape errors from actual mismatches.
   */
  async resetPassword(resetDto: ResetPasswordDto): Promise<{ message: string }> {
    try {
      const candidates = await this.usersService.findManyWithResetTokenAndExpiry();

      let matchedUser: User | null = null;
      for (const candidate of candidates) {
        const hash = candidate.resetPasswordTokenHash;
        if (!hash) continue;
        // bcrypt.compare is constant-time within itself; the for-loop is
        // not — but the candidate set is bounded by pending-reset count,
        // and timing across candidates does not leak which user matches
        // (only that *some* user does, which the success/failure split
        // already discloses).
        const matched = await bcrypt.compare(resetDto.token, hash);
        if (matched) {
          matchedUser = candidate;
          break;
        }
      }

      if (!matchedUser) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      const salt = await bcrypt.genSalt(12);
      const newPasswordHash = await bcrypt.hash(resetDto.newPassword, salt);

      // Single-use semantics — clear the hash + expiry alongside the
      // password update so the link cannot be replayed.
      await this.usersService.update(this.getUserId(matchedUser), {
        passwordHash: newPasswordHash,
        resetPasswordTokenHash: null,
        resetPasswordExpiresAt: null,
      });

      this.auditAuthEvent({
        action: 'password_reset_success',
        userId: this.getUserId(matchedUser),
        actorNameSnapshot: matchedUser.name,
        meta: { channel: 'email' },
      });

      return { message: 'Password reset successfully' };
    } catch (e) {
      // Token-shape / candidate-mismatch errors are expected — surface via
      // the BadRequest envelope without Sentry noise. Other failures (DB
      // outage, bcrypt failure) deserve a capture.
      if (!(e instanceof BadRequestException)) {
        this.logger.error(
          `Unexpected resetPassword failure: ${(e as Error)?.message ?? e}`,
          (e as Error)?.stack,
        );
        Sentry.captureException(e, {
          tags: { module: 'auth', op: 'resetPassword' },
        });
      }
      throw new BadRequestException('Invalid or expired reset token');
    }
  }
  async sendVerificationEmail(
    dto: SendVerificationEmailDto,
    userId: string,
  ): Promise<{ message: string }> {
    // Look up the CALLER by their authenticated userId
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('Account not found.');
    }

    // Check conflict FIRST — by design, only verified email rows survive in
    // the User collection (unverified candidates live only in Redis), so a
    // hit here always means a verified collision.
    const emailOwner = await this.usersService.findByIdentifier(dto.email);
    if (emailOwner && this.getUserId(emailOwner) !== userId) {
      throw new BadRequestException(
        'This email address is already linked to another account. Please use a different email.',
      );
    }

    // Only AFTER confirming no conflict — check if the current user is already verified
    if (user.isEmailVerified) {
      throw new BadRequestException('Your email address is already verified.');
    }

    // Verified email is immutable — defence-in-depth (the early
    // isEmailVerified throw above already covers this for normal flows).
    if (user.email && user.email !== dto.email && user.isEmailVerified) {
      throw new BadRequestException(
        'You cannot change your existing email address. Please contact support.',
      );
    }

    // INTENTIONAL: do NOT write `email` to the User record at this stage.
    // The candidate identifier lives in the signed OTP-JWT staged below in
    // Redis. Final write happens atomically inside verifyEmail via
    // claimEmailVerified — that's what stops User A's unverified candidate
    // from blocking User B's signup uniqueness check.

    // Generate a secure 6-digit OTP using the crypto module (cryptographically secure)
    const crypto = await import('crypto');
    const otp = crypto.randomInt(100000, 999999).toString();

    // Sign a short-lived JWT containing the OTP — expiry is enforced by the JWT itself
    const otpToken = await this.jwtService.signAsync(
      { otp, email: dto.email, type: 'email-verify' },
      {
        secret: this.configService.get<string>('jwt.accessSecret'),
        expiresIn: '15m',
      },
    );

    // Stage the signed JWT in Redis instead of writing to
    // User.emailVerificationToken. TTL mirrors the JWT expiry.
    await this.redis.set(`pending-verify:email:${userId}`, otpToken, 'EX', 15 * 60);

    // Send the plain OTP code to the user's email (the JWT stays server-side)
    await this.mailService.sendUserVerificationEmail({ email: dto.email, name: user.name }, otp);

    return { message: 'Verification email sent.' };
  }

  async verifyEmail(
    dto: VerifyEmailDto & { email?: string },
    userId: string,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('Account not found.');
    }

    if (user.isEmailVerified) {
      return { message: 'Email is already verified.' };
    }

    // Read the signed JWT from the Redis pending-verify slot. The candidate
    // email lives inside the JWT payload, so we never need to consult a User
    // field for the candidate value.
    const pendingKey = `pending-verify:email:${userId}`;
    const otpToken = await this.redis.get(pendingKey);
    if (!otpToken) {
      throw new BadRequestException('No verification was requested. Please request a new code.');
    }

    // Verify the JWT — this automatically throws TokenExpiredError if expired or tampered
    let payload: OtpVerifyJwtPayload & { email?: string };
    try {
      payload = this.jwtService.verify<OtpVerifyJwtPayload & { email?: string }>(otpToken, {
        secret: this.configService.get<string>('jwt.accessSecret'),
      });
    } catch (e) {
      if ((e as Error)?.name === 'TokenExpiredError') {
        await this.redis.del(pendingKey).catch(() => undefined);
        throw new BadRequestException('Verification code has expired. Please request a new one.');
      }
      throw new BadRequestException('Invalid verification token. Please request a new code.');
    }

    // Guard against cross-flow token reuse (e.g. a password reset token can't be used here)
    if (payload.type !== 'email-verify') {
      throw new BadRequestException('Invalid verification token.');
    }

    // Compare the OTP the user submitted with the one embedded in the JWT
    if (payload.otp !== dto.token) {
      throw new BadRequestException('Incorrect verification code. Please try again.');
    }

    if (!payload.email) {
      throw new BadRequestException('Invalid verification token.');
    }

    // Atomic claim — relies on the unique index on User.email to surface a
    // race during the OTP window (E11000 → EMAIL_TAKEN_DURING_VERIFY).
    await this.usersService.claimEmailVerified(userId, payload.email);
    await this.redis.del(pendingKey).catch(() => undefined);

    return { message: 'Email verified successfully.' };
  }

  async setupAdmin(dto: SetupAdminDto): Promise<{ message: string }> {
    const adminSetupSecret = this.configService.get<string>('app.adminSetupSecret');
    if (!adminSetupSecret || dto.secret !== adminSetupSecret) {
      throw new BadRequestException('Invalid setup secret');
    }

    const existingAdmin = await this.usersService.findOneByFilter({
      isAdmin: true,
    });
    if (existingAdmin) {
      throw new BadRequestException('An admin user already exists');
    }

    const user = await this.usersService.findByIdentifier(dto.identifier);
    if (!user) {
      throw new BadRequestException('No user found with that email or mobile');
    }

    await this.usersService.update(this.getUserId(user), {
      isAdmin: true,
    });
    return { message: `User ${dto.identifier} has been granted admin access` };
  }

  async getUserProfile(userId: string) {
    const user = await this.usersService.findByIdWithCredentials(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitizeUser(user);
  }

  /**
   * Strip EVERY sensitive credential / OTP / reset field from a User before it
   * is returned to the client (auth-hardening Pillar 2, AC-2.5).
   *
   * `select:false` on the schema only filters `.find()` projections — a
   * freshly-created doc (register/google), and the credential-helper queries
   * that `+select` some of these back in (findByIdWithCredentials adds
   * passwordHash/emailVerificationToken/pinHash), still carry the field IN
   * MEMORY. So we strip explicitly here, listing the full set rather than
   * relying on the schema projection, so a new `+select` helper or a new write
   * path can never accidentally leak a secret through this single choke point.
   *
   * Fields stripped: password hash; email/mobile verification JWT tokens +
   * their expiries/attempt-counters/lockouts; PIN hash + attempts + lockout;
   * reset-token hash + expiry. `hasPassword`/`hasPin` booleans are derived so
   * the FE can render "Set vs Change" without ever seeing the hash.
   */
  private sanitizeUser(
    user: User,
  ): Record<string, unknown> & { hasPassword: boolean; hasPin: boolean } {
    const obj = user.toObject() as Record<string, unknown> & {
      passwordHash?: string;
      pinHash?: string;
    };
    const { passwordHash, pinHash } = obj;
    // Allowlist-by-deletion of the full sensitive set. Keeping this list
    // exhaustive (not just the in-memory-by-default fields) is the AC-2.5
    // guarantee: no credential, OTP, or reset field can ride out in any
    // sanitizeUser-returned payload regardless of how the doc was loaded.
    const SENSITIVE_KEYS = [
      'passwordHash',
      'pinHash',
      'pinAttempts',
      'pinLockedUntil',
      'resetPasswordTokenHash',
      'resetPasswordExpiresAt',
      'emailVerificationToken',
      'mobileVerificationToken',
      'mobileVerificationExpiresAt',
      'mobileOtpAttempts',
      'mobileOtpLockedUntil',
      'mobileOtpLastSentAt',
      'mobileVerificationFlow',
    ] as const;
    for (const key of SENSITIVE_KEYS) {
      delete obj[key];
    }
    return {
      ...obj,
      hasPassword: !!passwordHash,
      hasPin: !!pinHash,
    };
  }

  // ───────────────── App Lock (Quick PIN) ─────────────────

  /**
   * Write a `setup-grace:fam:${family}` Redis key (or `setup-grace:jti:${jti}`
   * for legacy tokens without a family claim) for users who don't yet have a
   * PIN. The PinUnlockGuard honours this grace window (default 5 min) so the
   * user can land on /auth/setup-pin and submit before the next API call
   * 423-locks them. No-op for users with a PIN already.
   */
  private async writeSetupGraceIfNeeded(userId: string, accessToken: string): Promise<void> {
    try {
      const userPinFields = await this.usersService.findByIdWithPinFields(userId);
      if (!userPinFields || userPinFields.pinHash) return;
      const decoded: DecodedJwtMeta | null = this.jwtService.decode(accessToken);
      const key = appLockKey('setup-grace', { family: decoded?.family, jti: decoded?.jti });
      if (!key) return;
      const ttlSec = Math.floor(env.appLock.graceMs / 1000);
      await this.redis.set(key, '1', 'EX', ttlSec);
    } catch (err) {
      this.logger.warn(
        `writeSetupGraceIfNeeded failed for user ${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Compute ISO timestamp `unlockExpiresAt` from the resolved unlock TTL.
   * Used by the unlock-issuing endpoints to surface the unlock deadline to
   * the web client so it can mirror the idle countdown.
   */
  private unlockExpiresIso(ttlSec: number): string {
    return new Date(Date.now() + ttlSec * 1000).toISOString();
  }

  /**
   * Resolve the unlock TTL (in seconds) using the SAME precedence the web idle
   * clock uses (DashboardLayout): per-USER override -> per-WORKSPACE baseline
   * -> deployment env default. Falls back to the deployment default on any of:
   *   - no per-user / per-workspace override set
   *   - user / workspace not found or lookup failure
   *   - stored value out of the schema-enforced [60_000, 1_800_000] range
   *
   * Why per-user matters: before this honoured the user override, the FE idle
   * clock (which reads `user.appLockIdleMs` first) and this BE TTL (workspace-
   * only) disagreed for anyone who set a personal timeout, so the session could
   * 423-lock while the user still considered themselves active. Keep this in
   * sync with `DashboardLayout`/`useAppLock` idle resolution + the
   * `MeSecurityController` per-user override.
   *
   * The returned value is also written into the `unlocked:{fam|jti}:*` Redis
   * value (family-keyed `unlocked:fam:*`; `unlocked:jti:*` for legacy tokens)
   * so the `PinUnlockGuard` can re-EXPIRE the key to the same TTL on every
   * authenticated request (sliding unlock) -> the user fix propagates to the
   * guard slide + `getPinStatus` automatically.
   */
  private async resolveAppLockTtlSec(
    userId?: string | null,
    workspaceId?: string | null,
  ): Promise<number> {
    const fallback = Math.floor(env.appLock.idleMs / 1000);

    // 1. Per-user override wins (also the ONLY idle source for a workspace-less
    //    Connect account). Range-checked to the schema-enforced preset band.
    if (userId) {
      try {
        const userMs = await this.usersService.getAppLockIdleMs(userId);
        if (typeof userMs === 'number' && userMs >= 60_000 && userMs <= 1_800_000) {
          return Math.floor(userMs / 1000);
        }
      } catch (err) {
        this.logger.warn(
          `[resolveAppLockTtlSec] user ${userId} idle lookup failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    // 2. Per-workspace baseline (admin-set, applies to ERP members).
    if (!workspaceId) return fallback;
    if (!Types.ObjectId.isValid(workspaceId)) return fallback;
    try {
      const wsModel = this.moduleRef.get<Model<{ appLockIdleMs?: number | null }>>(
        getModelToken('Workspace'),
        { strict: false },
      );
      const ws = await wsModel
        .findById(workspaceId)
        .select('appLockIdleMs')
        .lean<{ appLockIdleMs?: number | null }>();
      const wsMs = ws?.appLockIdleMs;
      if (typeof wsMs === 'number' && wsMs >= 60_000 && wsMs <= 1_800_000) {
        return Math.floor(wsMs / 1000);
      }
    } catch (err) {
      this.logger.warn(
        `[resolveAppLockTtlSec] workspace ${workspaceId} lookup failed: ${(err as Error)?.message ?? err}`,
      );
    }
    return fallback;
  }

  /**
   * Initial PIN set. Only allowed when the user has no PIN yet. On success:
   * writes pinHash + pinSetAt, drops the setup-grace key (now superseded),
   * and writes the unlock key so the user is immediately unlocked.
   */
  async setPin(
    userId: string,
    jti: string,
    dto: SetPinDto,
    family?: string,
  ): Promise<{ ok: true; unlockExpiresAt: string }> {
    return this.withAuthSpan('auth.setPin', { userId, jti }, async () => {
      const user = await this.usersService.findByIdWithPinFields(userId);
      if (!user) throw new UnauthorizedException('User not found');
      if (user.pinHash) {
        throw new BadRequestException({
          code: 'PIN_ALREADY_SET',
          message: 'PIN already set; use /auth/pin-change',
        });
      }

      const salt = await bcrypt.genSalt(12);
      const pinHash = await bcrypt.hash(dto.pin, salt);
      await this.usersService.update(userId, {
        pinHash,
        pinSetAt: new Date(),
        pinAttempts: 0,
      } as Partial<User>);

      const ttlSec = await this.resolveAppLockTtlSec(userId, dto.workspaceId);
      try {
        const graceKey = appLockKey('setup-grace', { family, jti });
        const unlockKey = appLockKey('unlocked', { family, jti });
        if (graceKey) await this.redis.del(graceKey);
        // Store ttlSec as the value so PinUnlockGuard can re-EXPIRE on each
        // authenticated request (sliding unlock window).
        if (unlockKey) await this.redis.set(unlockKey, String(ttlSec), 'EX', ttlSec);
      } catch (err) {
        this.logger.warn(
          `[setPin] Redis write failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
      }

      this.auditAuthEvent({
        action: 'pin_set_success',
        userId,
        actorNameSnapshot: user.name,
        meta: { jti },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'auth.pin_set',
        properties: { jti },
      });

      return { ok: true, unlockExpiresAt: this.unlockExpiresIso(ttlSec) };
    });
  }

  /**
   * Change PIN — requires the current PIN.
   */
  async changePin(
    userId: string,
    jti: string,
    dto: ChangePinDto,
    family?: string,
  ): Promise<{ ok: true; unlockExpiresAt: string }> {
    return this.withAuthSpan('auth.changePin', { userId, jti }, async () => {
      const user = await this.usersService.findByIdWithPinFields(userId);
      if (!user || !user.pinHash) {
        throw new BadRequestException({
          code: 'PIN_NOT_SET',
          message: 'No PIN set; use /auth/pin-set',
        });
      }

      const ok = await bcrypt.compare(dto.currentPin, user.pinHash);
      if (!ok) {
        this.auditAuthEvent({
          action: 'pin_change_failure',
          userId,
          actorNameSnapshot: user.name,
          meta: { jti, reason: 'incorrect_current_pin' },
        });
        throw new BadRequestException({
          code: 'PIN_INCORRECT',
          message: 'Current PIN is incorrect',
        });
      }

      const salt = await bcrypt.genSalt(12);
      const newHash = await bcrypt.hash(dto.newPin, salt);
      await this.usersService.update(userId, {
        pinHash: newHash,
        pinSetAt: new Date(),
        pinAttempts: 0,
      } as Partial<User>);

      const ttlSec = await this.resolveAppLockTtlSec(userId, dto.workspaceId);
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        if (unlockKey) await this.redis.set(unlockKey, String(ttlSec), 'EX', ttlSec);
      } catch (err) {
        this.logger.warn(
          `[changePin] Redis write failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
      }

      this.auditAuthEvent({
        action: 'pin_change_success',
        userId,
        actorNameSnapshot: user.name,
        meta: { jti },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'auth.pin_changed',
        properties: { jti },
      });

      return { ok: true, unlockExpiresAt: this.unlockExpiresIso(ttlSec) };
    });
  }

  /**
   * Verify PIN to unlock. Wrong PIN increments `pinAttempts`. At
   * `env.appLock.maxFailedAttempts` consecutive failures the response is
   * `PIN_LOCKOUT_FORGOT_REQUIRED` and the client must run the forgot-PIN
   * flow. Successful unlock resets the counter and writes the
   * `unlocked:fam:${family}` Redis key (or `unlocked:jti:${jti}` for legacy
   * tokens without a family claim).
   */
  async verifyPin(
    userId: string,
    jti: string,
    dto: VerifyPinDto,
    family?: string,
  ): Promise<{ ok: true; unlockExpiresAt: string }> {
    return this.withAuthSpan('auth.verifyPin', { userId, jti }, async () => {
      const user = await this.usersService.findByIdWithPinFields(userId);
      if (!user || !user.pinHash) {
        throw new BadRequestException({
          code: 'PIN_NOT_SET',
          message: 'No PIN set',
        });
      }

      const max = env.appLock.maxFailedAttempts;
      const attempts = user.pinAttempts ?? 0;

      if (attempts >= max) {
        this.auditAuthEvent({
          action: 'pin_unlock_failure',
          userId,
          actorNameSnapshot: user.name,
          meta: { jti, reason: 'too_many_attempts' },
        });
        this.postHog.capture({
          distinctId: userId,
          event: 'auth.pin_unlock_failed',
          properties: { reason: 'too_many_attempts', attemptsRemaining: 0 },
        });
        throw new HttpException(
          {
            message: 'Too many failed attempts',
            code: 'PIN_LOCKOUT_FORGOT_REQUIRED',
            attemptsRemaining: 0,
          },
          HttpStatus.LOCKED,
        );
      }

      const ok = await bcrypt.compare(dto.pin, user.pinHash);
      if (!ok) {
        const newCount = attempts + 1;
        await this.usersService.update(userId, {
          pinAttempts: newCount,
        } as Partial<User>);

        this.auditAuthEvent({
          action: 'pin_unlock_failure',
          userId,
          actorNameSnapshot: user.name,
          meta: {
            jti,
            reason: 'incorrect_pin',
            attempts: newCount,
          },
        });
        this.postHog.capture({
          distinctId: userId,
          event: 'auth.pin_unlock_failed',
          properties: {
            reason: 'incorrect_pin',
            attemptsRemaining: Math.max(0, max - newCount),
          },
        });

        if (newCount >= max) {
          throw new HttpException(
            {
              message: 'Too many failed attempts',
              code: 'PIN_LOCKOUT_FORGOT_REQUIRED',
              attemptsRemaining: 0,
            },
            HttpStatus.LOCKED,
          );
        }

        throw new HttpException(
          {
            message: 'Incorrect PIN',
            code: 'PIN_INCORRECT',
            attemptsRemaining: max - newCount,
          },
          HttpStatus.LOCKED,
        );
      }

      await this.usersService.update(userId, {
        pinAttempts: 0,
      } as Partial<User>);

      const ttlSec = await this.resolveAppLockTtlSec(userId, dto.workspaceId);
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        if (unlockKey) await this.redis.set(unlockKey, String(ttlSec), 'EX', ttlSec);
      } catch (err) {
        this.logger.warn(
          `[verifyPin] Redis write failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
        throw new HttpException(
          {
            message: 'Unable to unlock at this time',
            code: 'APP_LOCKED',
            reason: 'redis_unavailable',
          },
          HttpStatus.LOCKED,
        );
      }

      this.auditAuthEvent({
        action: 'pin_unlock_success',
        userId,
        actorNameSnapshot: user.name,
        meta: { jti },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'auth.pin_unlock_succeeded',
        properties: { attemptsBefore: attempts },
      });

      return { ok: true, unlockExpiresAt: this.unlockExpiresIso(ttlSec) };
    });
  }

  /**
   * Returns whether the caller has set a PIN, whether the session is currently
   * locked, and (when unlocked) the absolute timestamp at which the unlock
   * Redis key expires. The web client polls this on rehydrate / tab return.
   */
  async getPinStatus(
    userId: string,
    jti: string,
    family?: string,
  ): Promise<{
    pinSet: boolean;
    locked: boolean;
    unlockExpiresAt: string | null;
  }> {
    return this.withAuthSpan('auth.pinStatus', { userId, jti }, async () => {
      const user = await this.usersService.findByIdWithPinFields(userId);
      if (!user) throw new UnauthorizedException('User not found');

      const pinSet = !!user.pinHash;
      if (!pinSet) {
        return { pinSet: false, locked: false, unlockExpiresAt: null };
      }

      let ttlMs = -2;
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        ttlMs = unlockKey ? await this.redis.pttl(unlockKey) : -2;
      } catch (err) {
        this.logger.warn(
          `[getPinStatus] Redis pttl failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
        // Fail-closed: treat as locked when Redis is unreachable.
        return { pinSet: true, locked: true, unlockExpiresAt: null };
      }

      if (ttlMs <= 0) {
        return { pinSet: true, locked: true, unlockExpiresAt: null };
      }

      return {
        pinSet: true,
        locked: false,
        unlockExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
    });
  }

  /**
   * App Lock activity heartbeat. The web idle timer pings `POST /auth/pin-touch`
   * on real user input (mouse / keyboard / scroll), throttled. The route
   * deliberately OMITS `@SkipPinUnlock`, so the GLOBAL `PinUnlockGuard` runs
   * first and has already slid the unlock key's TTL by the time this handler
   * executes. This method just reports the refreshed expiry back so the client
   * can keep its store in sync.
   *
   * Why it exists: the BE idle clock is a Redis TTL refreshed by REQUESTS, while
   * the FE idle clock is refreshed by USER INPUT. Without a heartbeat those two
   * signals diverge (a user reading / scrolling makes no API calls) and the
   * session 423-locks mid-use. This bridges them: FE activity -> guard slide.
   * Intentionally cheap (one Redis PTTL, no Mongo read). Links: PinUnlockGuard
   * (the slider), web `useIdle.onActivity` -> `pinApi.touch`.
   */
  async pinTouch(
    userId: string,
    jti: string,
    family?: string,
  ): Promise<{ unlockExpiresAt: string | null }> {
    return this.withAuthSpan('auth.pinTouch', { userId, jti }, async () => {
      let ttlMs = -2;
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        ttlMs = unlockKey ? await this.redis.pttl(unlockKey) : -2;
      } catch (err) {
        this.logger.warn(
          `[pinTouch] Redis pttl failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
        return { unlockExpiresAt: null };
      }
      return {
        unlockExpiresAt: ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null,
      };
    });
  }

  /**
   * Re-authenticate the caller for a sensitive self-action (account-deletion
   * Phase 2, plan §5/§A.11). Mirrors {@link forgotPinCredentialVerify}'s
   * password/Google branch but mints NO token — it only asserts the factor and
   * returns void (the caller proceeds on success, gets a thrown error on
   * failure). The third branch is the password-less fallback: an account with
   * neither a password nor a Google link needs no separate factor here, because
   * the step-up OTP proof (validated by the caller) IS the re-auth factor for an
   * OTP-only account. Audits success/failure for the grievance/security trail.
   *
   * @param userId the JWT subject performing the action (never a body id)
   * @param reauth the supplied factor (password / Google); may be omitted for an
   *               OTP-only account
   */
  async assertReauthenticated(
    userId: string,
    reauth?: { kind?: 'password' | 'google'; password?: string; googleIdToken?: string },
  ): Promise<void> {
    const user = await this.usersService.findByIdWithCredentials(userId);
    if (!user) throw new UnauthorizedException('User not found');

    // Password account — re-auth with the current password.
    if (user.passwordHash) {
      if (reauth?.kind !== 'password' || !reauth.password) {
        throw new BadRequestException({
          code: 'REAUTH_PASSWORD_REQUIRED',
          message: 'Enter your password to confirm this action.',
        });
      }
      const ok = await bcrypt.compare(reauth.password, user.passwordHash);
      if (!ok) {
        this.auditAuthEvent({
          action: 'reauth_failure',
          userId,
          actorNameSnapshot: user.name,
          meta: { kind: 'password', reason: 'invalid_password' },
        });
        throw new UnauthorizedException({ code: 'REAUTH_INVALID', message: 'Incorrect password.' });
      }
      this.auditAuthEvent({
        action: 'reauth_verified',
        userId,
        actorNameSnapshot: user.name,
        meta: { kind: 'password' },
      });
      return;
    }

    // Google-only account — re-auth with a fresh Google token bound to the
    // linked Google sub (accepts web access_token OR mobile id_token, per
    // resolveGoogleIdentity).
    if (user.googleId) {
      if (reauth?.kind !== 'google' || !reauth.googleIdToken) {
        throw new BadRequestException({
          code: 'REAUTH_GOOGLE_REQUIRED',
          message: 'Verify with Google to confirm this action.',
        });
      }
      try {
        const ident = await this.resolveGoogleIdentity(reauth.googleIdToken);
        if (!ident?.sub || ident.sub !== user.googleId) {
          throw new UnauthorizedException({
            code: 'REAUTH_INVALID',
            message: 'Google verification failed.',
          });
        }
      } catch (err) {
        this.auditAuthEvent({
          action: 'reauth_failure',
          userId,
          actorNameSnapshot: user.name,
          meta: { kind: 'google', reason: 'google_verify_failed' },
        });
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException({
          code: 'REAUTH_INVALID',
          message: 'Google verification failed.',
        });
      }
      this.auditAuthEvent({
        action: 'reauth_verified',
        userId,
        actorNameSnapshot: user.name,
        meta: { kind: 'google' },
      });
      return;
    }

    // OTP-only account (no password, no Google) — the step-up OTP proof the
    // caller consumes IS the re-auth factor; nothing to verify here (§A.11).
    this.auditAuthEvent({
      action: 'reauth_verified',
      userId,
      actorNameSnapshot: user.name,
      meta: { kind: 'otp_only' },
    });
  }

  /**
   * Step 1 of forgot-PIN: caller proves identity with their password (or
   * Google ID token for Google-only accounts). On success a 5-min
   * `pinResetToken` JWT is returned that the client passes to
   * /auth/forgot-pin-reset. The token's jti is bound to the *current*
   * session jti so it cannot be replayed against another session.
   */
  async forgotPinCredentialVerify(
    userId: string,
    jti: string,
    dto: ForgotPinCredentialDto,
  ): Promise<{ pinResetToken: string }> {
    return this.withAuthSpan(
      'auth.forgotPinCredentialVerify',
      { userId, jti, kind: dto.kind },
      async () => {
        const user = await this.usersService.findByIdWithCredentials(userId);
        if (!user) throw new UnauthorizedException('User not found');

        if (dto.kind === 'password') {
          if (!dto.password) {
            throw new BadRequestException('Password is required');
          }
          if (!user.passwordHash) {
            throw new BadRequestException({
              code: 'PASSWORD_NOT_SET',
              message: 'This account is linked to Google. Use Google verification instead.',
            });
          }
          const ok = await bcrypt.compare(dto.password, user.passwordHash);
          if (!ok) {
            this.auditAuthEvent({
              action: 'pin_reset_credential_failure',
              userId,
              actorNameSnapshot: user.name,
              meta: { jti, kind: 'password', reason: 'invalid_password' },
            });
            throw new UnauthorizedException('Invalid credentials');
          }
        } else {
          // Google
          if (!dto.googleIdToken) {
            throw new BadRequestException('googleIdToken is required');
          }
          if (!user.googleId) {
            throw new BadRequestException({
              code: 'GOOGLE_NOT_LINKED',
              message: 'This account is not linked to Google',
            });
          }
          try {
            // Accepts web access_token OR mobile id_token (see resolveGoogleIdentity).
            const ident = await this.resolveGoogleIdentity(dto.googleIdToken);
            if (!ident?.sub || ident.sub !== user.googleId) {
              throw new UnauthorizedException('Google verification failed');
            }
          } catch {
            this.auditAuthEvent({
              action: 'pin_reset_credential_failure',
              userId,
              actorNameSnapshot: user.name,
              meta: { jti, kind: 'google', reason: 'google_verify_failed' },
            });
            throw new UnauthorizedException('Google verification failed');
          }
        }

        const pinResetToken = await this.jwtService.signAsync(
          { sub: userId, jti, type: 'pin-reset' },
          {
            secret: this.configService.get<string>('jwt.accessSecret'),
            expiresIn: env.appLock.resetTokenExpiry,
          },
        );

        this.auditAuthEvent({
          action: 'pin_reset_credential_verified',
          userId,
          actorNameSnapshot: user.name,
          meta: { jti, kind: dto.kind },
        });

        return { pinResetToken };
      },
    );
  }

  /**
   * Step 2 of forgot-PIN: consume the short-lived `pinResetToken` and set a
   * new PIN. Token's `sub`/`jti` must match the caller's current session.
   * Mirrors the cross-flow guard in verifyEmail (`payload.type` check).
   */
  async forgotPinReset(
    userId: string,
    jti: string,
    dto: ForgotPinResetDto,
    family?: string,
  ): Promise<{ ok: true; unlockExpiresAt: string }> {
    return this.withAuthSpan('auth.forgotPinReset', { userId, jti }, async () => {
      let payload: { sub?: string; jti?: string; type?: string };
      try {
        payload = this.jwtService.verify(dto.pinResetToken, {
          secret: this.configService.get<string>('jwt.accessSecret'),
        });
      } catch {
        throw new BadRequestException({
          code: 'PIN_RESET_TOKEN_INVALID',
          message: 'Reset token invalid or expired',
        });
      }

      if (payload?.type !== 'pin-reset' || payload?.sub !== userId || payload?.jti !== jti) {
        throw new BadRequestException({
          code: 'PIN_RESET_TOKEN_INVALID',
          message: 'Reset token does not match this session',
        });
      }

      const user = await this.usersService.findByIdWithPinFields(userId);
      if (!user) throw new UnauthorizedException('User not found');

      const salt = await bcrypt.genSalt(12);
      const pinHash = await bcrypt.hash(dto.newPin, salt);
      await this.usersService.update(userId, {
        pinHash,
        pinSetAt: new Date(),
        pinAttempts: 0,
      } as Partial<User>);

      const ttlSec = await this.resolveAppLockTtlSec(userId, dto.workspaceId);
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        if (unlockKey) await this.redis.set(unlockKey, String(ttlSec), 'EX', ttlSec);
      } catch (err) {
        this.logger.warn(
          `[forgotPinReset] Redis write failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
      }

      this.auditAuthEvent({
        action: 'pin_reset_success',
        userId,
        actorNameSnapshot: user.name,
        meta: { jti },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'auth.pin_reset_completed',
        properties: { jti },
      });

      return { ok: true, unlockExpiresAt: this.unlockExpiresIso(ttlSec) };
    });
  }

  /**
   * Manual lock — drops the unlock Redis key so the next authenticated
   * request returns 423. Idempotent.
   */
  async lockSession(
    userId: string,
    jti: string,
    actorNameSnapshot?: string,
    family?: string,
  ): Promise<{ ok: true }> {
    return this.withAuthSpan('auth.lock', { userId, jti }, async () => {
      try {
        const unlockKey = appLockKey('unlocked', { family, jti });
        if (unlockKey) await this.redis.del(unlockKey);
      } catch (err) {
        this.logger.warn(
          `[lockSession] Redis del failed for jti ${jti}: ${(err as Error)?.message ?? err}`,
        );
      }

      this.auditAuthEvent({
        action: 'pin_manual_lock',
        userId,
        actorNameSnapshot,
        meta: { jti },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'auth.session_locked',
        properties: { jti },
      });

      return { ok: true };
    });
  }
}
