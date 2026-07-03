import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/nestjs';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type Redis from 'ioredis';
import { Types } from 'mongoose';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { env } from '../../../config/env';
import { SmsService } from '../../sms/sms.service';
import { Msg91WidgetOtpService } from '../../sms/services/msg91-widget-otp.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/schemas/user.schema';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { AuthService } from '../auth.service';
import { AuthResult } from '../types/auth.types';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { MobileOtpJwtPayload } from '../types/auth.types';
import {
  ResendOtpDto,
  SendMobileVerifyOtpDto,
  SendOtpDto,
  TerminateAndOtpLoginDto,
  VerifyMobileDto,
  VerifyOtpDto,
} from '../dto/sms-otp.dto';
import { maskIndianMobile, normaliseIndianMobile } from '../utils/mobile-normalizer';
import { buildSuspendedAccountError } from '../utils/account-status';
import {
  checkAndSetCooldown,
  checkSlidingWindow,
  isCircuitTripped,
  recordProviderFailure,
} from '../utils/otp-rate-limiter';

const MOCK_OTP = '123456';
const OTP_TYPE: MobileOtpJwtPayload['type'] = 'mobile-otp';
// Step-up proof token lifetime (account-deletion Phase 1, §A.3/§5). Short: the
// user proves the OTP then immediately confirms the delete in the same flow.
const STEPUP_PROOF_TTL_SEC = 300;

interface SendOtpResponse {
  ok: true;
  sent: true;
  expiresAt: string;
  resendCooldownSec: number;
  mockMode: boolean;
  idempotent?: true;
}

@Injectable()
export class SmsOtpService {
  private readonly logger = new Logger(SmsOtpService.name);
  private readonly tracer = trace.getTracer('auth');

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly authService: AuthService,
    private readonly subscriptions: SubscriptionsService,
    private readonly sms: SmsService,
    private readonly workspacesService: WorkspacesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly postHog: PostHogService,
    private readonly widgetOtp: Msg91WidgetOtpService,
  ) {}

  /** See AuthService.withAuthSpan for the rationale. Duplicated here so the
   * SMS-OTP service can wrap its own handler bodies without an awkward
   * `authService.withAuthSpan` plumbing. */
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

  // ───────────────────── PUBLIC API ─────────────────────

  /**
   * Mint + dispatch a mobile OTP for the requested flow. Anti-enumeration:
   * unknown / mismatched user state → return generic success, audit, no SMS.
   */
  async sendOtp(dto: SendOtpDto, ipAddress?: string): Promise<SendOtpResponse> {
    const norm = normaliseIndianMobile(dto.mobile);
    if (!norm) {
      throw new BadRequestException({
        code: 'OTP_INVALID_MOBILE',
        message: 'Enter a valid Indian mobile number',
      });
    }

    // Circuit breaker — if MSG91 has failed >threshold inside windowSec, fail
    // fast so users see "service degraded" instead of waiting on a stuck send.
    if (
      await isCircuitTripped(
        this.redis,
        'otp:provider:failures',
        env.authOtp.circuitBreakerThreshold,
      )
    ) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_DEGRADED',
        message:
          'SMS service temporarily unavailable. Please use password to sign in or try again shortly.',
      });
    }

    // Rate limits BEFORE we mint anything (guard against abuse + accidental
    // burst from FE re-renders). Order: per-phone hourly/daily, per-IP daily.
    await this.enforceRateLimits(norm.full, ipAddress);

    // Idempotency window — same phone + flow within cooldownSec returns the
    // previous response without resending. Resend route bypasses this.
    const idemKey = `otp:idem:${norm.full}:${dto.flowType}`;
    const cached = await this.redis.get(idemKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SendOtpResponse;
        return { ...parsed, idempotent: true };
      } catch {
        // Corrupt entry → drop and continue.
        await this.redis.del(idemKey).catch(() => undefined);
      }
    }

    const user = await this.users.findByMobileWithMobileOtpFields(norm.full);

    // Anti-enumeration: silent success on user-state mismatch. Audit logs
    // differentiate so ops can spot probing.
    if (dto.flowType === 'login' && !user) {
      this.authService.auditAnonOtpEvent({
        action: 'otp_send_blocked_unknown_user',
        mobileMasked: norm.last4 ? maskIndianMobile(norm.full) : '***',
        meta: { flowType: dto.flowType },
      });
      return this.buildGenericResponse();
    }
    if (dto.flowType === 'register' && user) {
      this.authService.auditAnonOtpEvent({
        action: 'otp_send_blocked_existing_user',
        mobileMasked: maskIndianMobile(norm.full),
        meta: { flowType: dto.flowType },
      });
      return this.buildGenericResponse();
    }
    if (dto.flowType === 'forgot' && !user) {
      // Explicit-feedback policy on forgot path — same call as the email
      // forgotPassword flow. Login + register paths still anti-enumerate
      // (those are the hot probe targets); forgot is opt-in for explicit.
      this.authService.auditAnonOtpEvent({
        action: 'password_reset_unknown_identifier',
        mobileMasked: maskIndianMobile(norm.full),
        meta: { flowType: dto.flowType, channel: 'sms' },
      });
      throw new BadRequestException({
        code: 'IDENTIFIER_NOT_REGISTERED',
        message: 'No account found with that mobile number.',
      });
    }

    // For login/forgot the user is locked out — surface 423 immediately
    // without burning an SMS credit.
    if (user && this.isLockedOut(user)) {
      throw new HttpException(
        {
          code: 'OTP_LOCKED',
          message: 'Too many wrong codes. Try password instead, or wait.',
          lockedUntil: user.mobileOtpLockedUntil,
        },
        HttpStatus.LOCKED,
      );
    }

    return this.mintAndDispatch({
      mobileFull: norm.full,
      flowType: dto.flowType,
      user,
    });
  }

  /**
   * Resend bypasses the 30s idempotency window AND mints a fresh OTP. Caller
   * deliberately asked for a new code — we must invalidate the previous one
   * by overwriting the JWT slot.
   */
  async resendOtp(dto: ResendOtpDto, ipAddress?: string): Promise<SendOtpResponse> {
    const norm = normaliseIndianMobile(dto.mobile);
    if (!norm) {
      throw new BadRequestException({
        code: 'OTP_INVALID_MOBILE',
        message: 'Enter a valid Indian mobile number',
      });
    }

    // Per-phone resend cooldown — UI countdown mirrors. Distinct from the
    // 30s idempotency window because resend explicitly invalidates the prior.
    const cd = await checkAndSetCooldown(
      this.redis,
      `otp:cooldown:${norm.full}`,
      env.authOtp.resendCooldownSec,
    );
    if (!cd.allowed) {
      throw new HttpException(
        {
          code: 'OTP_COOLDOWN',
          message: `Please wait ${cd.retryAfterSec}s before requesting another code.`,
          retryAfterSec: cd.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Same hourly/daily caps + circuit breaker as send.
    if (
      await isCircuitTripped(
        this.redis,
        'otp:provider:failures',
        env.authOtp.circuitBreakerThreshold,
      )
    ) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_DEGRADED',
        message: 'SMS service temporarily unavailable.',
      });
    }
    await this.enforceRateLimits(norm.full, ipAddress);

    const user = await this.users.findByMobileWithMobileOtpFields(norm.full);
    if (dto.flowType === 'login' && !user) return this.buildGenericResponse();
    if (dto.flowType === 'register' && user) return this.buildGenericResponse();
    if (dto.flowType === 'forgot' && !user) {
      // Mirror sendOtp's explicit-feedback policy on resend.
      throw new BadRequestException({
        code: 'IDENTIFIER_NOT_REGISTERED',
        message: 'No account found with that mobile number.',
      });
    }

    if (user && this.isLockedOut(user)) {
      throw new HttpException(
        {
          code: 'OTP_LOCKED',
          message: 'Too many wrong codes. Wait or use password.',
          lockedUntil: user.mobileOtpLockedUntil,
        },
        HttpStatus.LOCKED,
      );
    }

    // Drop the idempotency window entry so the new mint is the source of truth.
    await this.redis.del(`otp:idem:${norm.full}:${dto.flowType}`).catch(() => undefined);

    const result = await this.mintAndDispatch({
      mobileFull: norm.full,
      flowType: dto.flowType,
      user,
    });

    if (user) {
      this.authService.auditAuthEvent({
        action: 'otp_resend',
        userId: this.userIdStr(user),
        actorNameSnapshot: user.name,
        meta: { flowType: dto.flowType, mock: env.authOtp.mockEnabled },
      });
    } else {
      this.authService.auditAnonOtpEvent({
        action: 'otp_resend',
        mobileMasked: maskIndianMobile(norm.full),
        meta: { flowType: dto.flowType, mock: env.authOtp.mockEnabled },
      });
    }
    return result;
  }

  /**
   * Verify the OTP. Branch by flowType to issue tokens (login/forgot) or
   * create the new user + issue tokens (register). Forgot flow logs the user
   * in AND sets `mustResetPassword: true` so FE routes to change-password.
   */
  async verifyOtp(dto: VerifyOtpDto): Promise<AuthResult> {
    return this.withAuthSpan(
      'auth.verifyOtp',
      { flowType: dto.flowType, variant: dto.workspace ? 'web-combined' : 'otp' },
      async () => {
        const norm = normaliseIndianMobile(dto.mobile);
        if (!norm) {
          throw new BadRequestException({
            code: 'OTP_INVALID_MOBILE',
            message: 'Enter a valid Indian mobile number',
          });
        }

        const user = await this.users.findByMobileWithMobileOtpFields(norm.full);

        // Lockout check first — applies whether the OTP is correct or not.
        if (user && this.isLockedOut(user)) {
          throw new HttpException(
            {
              code: 'OTP_LOCKED',
              message: 'Too many wrong codes. Try password or wait.',
              lockedUntil: user.mobileOtpLockedUntil,
            },
            HttpStatus.LOCKED,
          );
        }
        if (!user && dto.flowType !== 'register') {
          // Anti-enumeration on verify: same response shape as wrong-OTP.
          throw new BadRequestException({
            code: 'OTP_INVALID',
            message: 'Incorrect or expired code. Please try again.',
          });
        }

        // Resolve the stored JWT — User doc for login/forgot, Redis pending blob
        // for register (no user yet at send time).
        let storedToken: string | null = null;
        if (dto.flowType === 'register') {
          storedToken = await this.redis.get(this.pendingOtpKey(norm.full, 'register'));
        } else if (user) {
          storedToken = user.mobileVerificationToken ?? null;
        }
        if (!storedToken) {
          throw new BadRequestException({
            code: 'OTP_NOT_REQUESTED',
            message: 'Please request a code first.',
          });
        }

        // Verify the JWT — decoding errors map to OTP_EXPIRED / OTP_INVALID.
        let payload: MobileOtpJwtPayload;
        try {
          payload = await this.jwt.verifyAsync<MobileOtpJwtPayload>(storedToken, {
            secret: this.config.get<string>('jwt.accessSecret'),
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

        // Cross-flow + cross-mobile guards (mirror auth.service.ts:842).
        if (payload.type !== OTP_TYPE) {
          throw new BadRequestException({
            code: 'OTP_INVALID',
            message: 'Invalid verification token.',
          });
        }
        if (payload.flowType !== dto.flowType) {
          throw new BadRequestException({
            code: 'OTP_FLOW_MISMATCH',
            message: 'Code was issued for a different flow. Please request a new one.',
          });
        }
        if (payload.mobile !== norm.full) {
          throw new BadRequestException({
            code: 'OTP_MOBILE_MISMATCH',
            message: 'Code does not match this mobile number.',
          });
        }

        try {
          await this.matchOtp(payload, { otp: dto.otp, accessToken: dto.accessToken });
        } catch (err) {
          await this.bumpVerifyAttempt(user, norm.full);
          // Surface attempts-remaining so FE can warn before the lockout fires.
          const remaining = await this.attemptsRemaining(user, norm.full);
          if (remaining <= 0) {
            throw new HttpException(
              {
                code: 'OTP_LOCKED',
                message: 'Too many wrong codes. Try password instead, or wait.',
                attemptsRemaining: 0,
              },
              HttpStatus.LOCKED,
            );
          }
          throw new BadRequestException({
            code: 'OTP_INCORRECT',
            message: 'Incorrect code. Please try again.',
            attemptsRemaining: remaining,
          });
        }

        // OTP state is cleared AFTER finalize succeeds — if finalize throws (e.g.
        // SESSION_LIMIT_REACHED) the OTP must remain valid so the FE can replay
        // it via /auth/terminate-and-otp-login. The constant-time compare above
        // already validated the code; clearing now would require the user to
        // request a fresh OTP just to terminate a stale session.

        if (dto.flowType === 'login') {
          if (!user) {
            throw new UnauthorizedException('User not found');
          }
          this.assertActive(user);
          const result = await this.authService.finalizeAuthSuccess({
            user,
            platform: dto.platform,
            deviceName: dto.deviceName,
            ipAddress: dto.ipAddress,
            userAgent: dto.userAgent,
            isNewUser: false,
            auditAction: 'login_success',
            auditMeta: { platform: dto.platform, variant: 'otp' },
          });
          await this.clearOtpState(user, norm.full, dto.flowType);
          return result;
        }

        if (dto.flowType === 'forgot') {
          if (!user) {
            throw new UnauthorizedException('User not found');
          }
          this.assertActive(user);
          const result = await this.authService.finalizeAuthSuccess({
            user,
            platform: dto.platform,
            deviceName: dto.deviceName,
            ipAddress: dto.ipAddress,
            userAgent: dto.userAgent,
            isNewUser: false,
            mustResetPassword: true,
            auditAction: 'login_success',
            auditMeta: { platform: dto.platform, variant: 'otp_forgot' },
          });
          await this.clearOtpState(user, norm.full, dto.flowType);
          return result;
        }

        // Register — two variants share this branch:
        //   - "web-combined" (when dto.workspace is present): the new web flow
        //     submits name + password + workspace fields together with the OTP.
        //     name + password are required; User + Workspace are created
        //     atomically (with a compensating User-delete on Workspace failure
        //     so a retry isn't blocked by MOBILE_ALREADY_REGISTERED). True
        //     Mongo transactions across User+Workspace would require a replica
        //     set + threading a session through WorkspacesService.create
        //     (workspace + member + firm + addons); compensating delete is the
        //     simpler portable approach used here.
        //   - "otp-only" (legacy mobile-app variant, no `workspace` field): User
        //     is created with optional name (placeholder when omitted) and
        //     optional password; Workspace is created later via /workspaces.
        const isWebCombined = !!dto.workspace;
        const isInviteAccept = !!dto.inviteToken;

        // Wave 4.8 (2026-05-10) — atomic signup-and-accept-invite. Mutually
        // exclusive with the workspace-create branch; both set is a 400.
        if (isWebCombined && isInviteAccept) {
          throw new BadRequestException({
            code: 'INVALID_SIGNUP_VARIANT',
            message: 'Cannot create a new workspace and accept an invite in the same request.',
          });
        }

        if (isWebCombined || isInviteAccept) {
          const trimmedName = (dto.name ?? '').trim();
          if (trimmedName.length < 2) {
            throw new BadRequestException({
              code: 'MISSING_SIGNUP_FIELDS',
              message: 'Full name is required (min 2 characters).',
            });
          }
          if (!dto.password) {
            throw new BadRequestException({
              code: 'MISSING_SIGNUP_FIELDS',
              message: 'Password is required.',
            });
          }
        }

        // Wave 4.8 — pre-flight invite token validation. Look up the bridge
        // row BEFORE creating a User so an invalid/expired/mismatched token
        // fails fast (no compensating delete needed). The same hash + expiry
        // checks that `joinWithToken` performs are mirrored here so we can
        // surface a precise error code to the FE.
        if (isInviteAccept) {
          const tokenHash = crypto.createHash('sha256').update(dto.inviteToken).digest('hex');
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
          // Identifier match — token + identifier must align so a leaked
          // token can't be redeemed onto an unrelated phone number.
          const expectedIdentifier = inviteRow.inviteeIdentifier ?? undefined;
          if (
            inviteRow.inviteeType === 'mobile' &&
            expectedIdentifier &&
            normaliseIndianMobile(expectedIdentifier).full !== norm.full
          ) {
            throw new BadRequestException({
              code: 'INVITE_IDENTIFIER_MISMATCH',
              message:
                'This invite was sent to a different phone number. Sign up with that number to accept.',
            });
          }
          if (inviteRow.inviteeType === 'email') {
            // Mobile-OTP path can't accept an email-only invite — surface
            // the constraint so the FE can route to the email-OTP path.
            throw new BadRequestException({
              code: 'INVITE_IDENTIFIER_MISMATCH',
              message: 'This invite was sent to an email. Use the email signup option to accept.',
            });
          }
        }

        const placeholderName = `User ${norm.full.slice(-4)}`;
        const resolvedName = (dto.name ?? '').trim() || placeholderName;
        let createdUser: User;
        try {
          const createPayload: Partial<User> = {
            name: resolvedName,
            mobile: norm.full,
            isMobileVerified: true,
          };
          if (dto.password) {
            const bcrypt = await import('bcryptjs');
            const salt = await bcrypt.genSalt(12);
            createPayload.passwordHash = await bcrypt.hash(dto.password, salt);
          }
          // Wave 5 (2026-05-21) — atomic product-policy consent at signup.
          // Mirrors `AuthService.register`; see the comment there for the
          // race-elimination rationale.
          if (dto.acceptedPolicy === 'connect') {
            createPayload.connectPolicyAcceptedAt = new Date();
          } else if (dto.acceptedPolicy === 'erp') {
            createPayload.erpPolicyAcceptedAt = new Date();
          }
          createdUser = await this.users.create(createPayload);
        } catch (err) {
          // Mongo dup-key on `mobile` unique index → another tab won the race.
          if ((err as { code?: number })?.code === 11000) {
            throw new BadRequestException({
              code: 'MOBILE_ALREADY_REGISTERED',
              message: 'This mobile number is already registered. Please sign in instead.',
            });
          }
          throw err;
        }

        // Wave 4.8 (2026-05-10) — invite-accept variant: create the User
        // (above) then join the existing workspace via the bridge invite
        // row. Compensating User-delete on failure mirrors the web-combined
        // pattern — user can retry without hitting MOBILE_ALREADY_REGISTERED.
        if (isInviteAccept && dto.inviteToken) {
          try {
            await this.workspacesService.joinWithToken(
              dto.inviteToken,
              this.userIdStr(createdUser),
            );
            const refreshed = await this.users.findByIdWithCredentials(this.userIdStr(createdUser));
            if (refreshed) createdUser = refreshed;
          } catch (err) {
            try {
              await this.users.remove(this.userIdStr(createdUser));
            } catch (cleanupErr) {
              this.logger.error(
                `[verifyOtp.register.invite-accept] User cleanup failed for ${this.userIdStr(createdUser)}: ${(cleanupErr as Error)?.message ?? cleanupErr}`,
              );
              Sentry.captureException(cleanupErr, {
                tags: {
                  module: 'auth',
                  op: 'verifyOtp.compensate-user-delete-invite',
                },
                extra: { userId: this.userIdStr(createdUser) },
              });
            }
            Sentry.captureException(err, {
              tags: { module: 'auth', op: 'verifyOtp.invite-accept-join' },
              extra: { userId: this.userIdStr(createdUser) },
            });
            if (err instanceof HttpException) throw err;
            throw new HttpException(
              {
                code: 'INVITE_ACCEPT_FAILED',
                message: 'Could not accept the invite. Please try again.',
              },
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
          }
        }

        // Web-combined variant: create the Workspace right after the User. On
        // failure, compensate by hard-deleting the User row so the user can
        // retry signup without hitting MOBILE_ALREADY_REGISTERED.
        let createdWorkspaceId: string | undefined;
        if (isWebCombined && dto.workspace) {
          try {
            const workspace = await this.workspacesService.create(this.userIdStr(createdUser), {
              name: dto.workspace.name,
              location: dto.workspace.location,
              businessType: dto.workspace.businessType,
              gstin: dto.workspace.gstin,
              pan: dto.workspace.pan,
              fyStartMonth: dto.workspace.fyStartMonth,
            });
            createdWorkspaceId = workspace._id.toString();
            // WorkspacesService.create flips User.hasWorkspace=true on the DB
            // row; the local createdUser doc is stale. Refetch so the
            // AuthResult returned to the FE reflects the real state — without
            // this, DashboardLayout sees hasWorkspace=false and bounces the
            // user away from /dashboard/* routes after signup.
            //
            // Use findByIdWithCredentials (not findById) so the refetched doc
            // still carries +passwordHash +pinHash for sanitizeUser to compute
            // hasPassword / hasPin correctly. Without this, a fresh signup with
            // a password would incorrectly surface as `hasPassword: false` on
            // the FE.
            const refreshed = await this.users.findByIdWithCredentials(this.userIdStr(createdUser));
            if (refreshed) createdUser = refreshed;
          } catch (err) {
            // Compensate — best-effort User cleanup. Cleanup failures are
            // logged + Sentry'd but never re-thrown so the original cause
            // surfaces to the caller.
            try {
              await this.users.remove(this.userIdStr(createdUser));
            } catch (cleanupErr) {
              this.logger.error(
                `[verifyOtp.register.web-combined] User cleanup failed for ${this.userIdStr(createdUser)}: ${(cleanupErr as Error)?.message ?? cleanupErr}`,
              );
              Sentry.captureException(cleanupErr, {
                tags: { module: 'auth', op: 'verifyOtp.compensate-user-delete' },
                extra: { userId: this.userIdStr(createdUser) },
              });
            }
            Sentry.captureException(err, {
              tags: { module: 'auth', op: 'verifyOtp.workspace-create' },
              extra: { userId: this.userIdStr(createdUser) },
            });
            // Bubble up the original message when it's a structured exception
            // (e.g. WORKSPACE_LIMIT_REACHED) so the FE can surface it; otherwise
            // wrap in a generic 500.
            if (err instanceof HttpException) {
              throw err;
            }
            throw new HttpException(
              {
                code: 'SIGNUP_FAILED',
                message: 'Could not complete signup. Please try again.',
              },
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
          }
        }

        // Auto-assign free subscription (mirror AuthService.register).
        await this.subscriptions
          .createFreeSubscription(this.userIdStr(createdUser), 'self')
          .catch((e) => {
            this.logger.warn(
              `[verifyOtp.register] createFreeSubscription failed for ${this.userIdStr(createdUser)}: ${(e as Error)?.message ?? e}`,
            );
            Sentry.captureException(e, {
              tags: { module: 'auth', op: 'verifyOtp.createFreeSubscription' },
              extra: { userId: this.userIdStr(createdUser) },
            });
          });

        // Auto-generate the public-profile slug (`User.handle`) from the user's
        // display name. Best-effort + fire-and-forget — a handle-generation
        // failure must NOT block signup; the user can claim one manually later
        // from `/account/profile`. Idempotent: if the row already has a handle
        // (race, retry), the service short-circuits.
        await this.users.generateHandleForUser(this.userIdStr(createdUser)).catch((e) => {
          this.logger.warn(
            `[verifyOtp.register] generateHandleForUser failed for ${this.userIdStr(createdUser)}: ${(e as Error)?.message ?? e}`,
          );
          Sentry.captureException(e, {
            tags: { module: 'auth', op: 'verifyOtp.generateHandleForUser' },
            extra: { userId: this.userIdStr(createdUser) },
          });
        });

        // P1.4 (2026-05-14) — auto-bind pending invites by mobile/email.
        // Previously only AuthService.register ran this sweep; mobile-OTP
        // signups orphaned any matching pending WorkspaceMember invites.
        // Fire-and-forget — invite-link failure must not block the signup.
        await this.authService.linkPendingInvitations(
          this.userIdStr(createdUser),
          createdUser.email,
          createdUser.mobile,
        );

        const result = await this.authService.finalizeAuthSuccess({
          user: createdUser,
          platform: dto.platform,
          deviceName: dto.deviceName,
          ipAddress: dto.ipAddress,
          userAgent: dto.userAgent,
          isNewUser: true,
          auditAction: 'register_success',
          auditMeta: {
            platform: dto.platform,
            viaEmail: false,
            viaMobile: true,
            variant: isWebCombined ? 'web-combined' : 'otp',
            workspaceCreated: !!createdWorkspaceId,
            ...(createdWorkspaceId ? { workspaceId: createdWorkspaceId } : {}),
          },
        });
        await this.clearOtpState(null, norm.full, 'register');

        if (createdWorkspaceId) {
          const distinctId = this.userIdStr(createdUser);
          this.postHog.identify({
            distinctId,
            properties: {
              mobile: norm.full,
              name: createdUser.name,
              workspaceId: createdWorkspaceId,
            },
          });
          this.postHog.capture({
            distinctId,
            event: 'auth.signup_completed',
            properties: {
              mode: 'mobile',
              variant: isWebCombined ? 'web-combined' : 'otp',
              workspaceId: createdWorkspaceId,
              tier: 'trial',
            },
          });
        }

        return result;
      },
    );
  }

  /**
   * Authenticated mobile-verification flow. Two cases:
   *   - body.mobile present → user is attaching a new mobile to their profile
   *   - body.mobile absent → user re-verifies the existing User.mobile
   * Mirrors `sendVerificationEmail` (auth.service.ts:753-808) for ergonomics.
   */
  async sendMobileVerifyOtp(
    userId: string,
    dto: SendMobileVerifyOtpDto,
    ipAddress?: string,
  ): Promise<SendOtpResponse> {
    const user = await this.users.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');

    let target: string | undefined = dto.mobile;
    if (!target) {
      if (!user.mobile) {
        throw new BadRequestException({
          code: 'MOBILE_NOT_SET',
          message: 'No mobile number on file. Provide one to verify.',
        });
      }
      target = user.mobile;
    }
    const norm = normaliseIndianMobile(target);
    if (!norm) {
      throw new BadRequestException({
        code: 'OTP_INVALID_MOBILE',
        message: 'Enter a valid Indian mobile number',
      });
    }

    // Conflict — another account already owns this mobile.
    const owner = await this.users.findByMobile(norm.full);
    if (owner && this.userIdStr(owner) !== userId) {
      throw new BadRequestException({
        code: 'MOBILE_ALREADY_REGISTERED',
        message: 'This mobile number is already linked to another account.',
      });
    }
    if (user.isMobileVerified && user.mobile === norm.full) {
      throw new BadRequestException({
        code: 'MOBILE_ALREADY_VERIFIED',
        message: 'Your mobile number is already verified.',
      });
    }
    // Verified mobile is immutable — once a user has proven ownership, the
    // number can no longer be swapped for a different one.
    if (user.isMobileVerified && user.mobile && user.mobile !== norm.full) {
      throw new BadRequestException({
        code: 'MOBILE_LOCKED',
        message: 'Your mobile number is verified and cannot be changed.',
      });
    }

    // INTENTIONAL: do NOT write `mobile` to the User record at this stage.
    // The candidate identifier lives in the signed OTP-JWT (see
    // mintAndDispatch's `verify` branch which stages the JWT in Redis).
    // Final write happens atomically inside verifyMobile via
    // claimMobileVerified — this is what stops User A's unverified candidate
    // from blocking User B's signup uniqueness check.

    if (
      await isCircuitTripped(
        this.redis,
        'otp:provider:failures',
        env.authOtp.circuitBreakerThreshold,
      )
    ) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_DEGRADED',
        message: 'SMS service temporarily unavailable.',
      });
    }
    await this.enforceRateLimits(norm.full, ipAddress);

    return this.mintAndDispatch({
      mobileFull: norm.full,
      flowType: 'verify',
      user,
    });
  }

  async verifyMobile(userId: string, dto: VerifyMobileDto): Promise<{ ok: true }> {
    const user = await this.users.findByIdWithMobileOtpFields(userId);
    if (!user) throw new BadRequestException('Account not found.');
    if (user.isMobileVerified) {
      return { ok: true };
    }
    if (this.isLockedOut(user)) {
      throw new HttpException(
        {
          code: 'OTP_LOCKED',
          message: 'Too many wrong codes. Please wait.',
          lockedUntil: user.mobileOtpLockedUntil,
        },
        HttpStatus.LOCKED,
      );
    }

    // Read the signed OTP-JWT from the Redis pending-verify slot — this is
    // where sendMobileVerifyOtp stages the candidate now (NOT on the User
    // record, so abandoned attempts can't squat on the unique-index slot).
    const pendingKey = this.pendingVerifyMobileKey(userId);
    const token = await this.redis.get(pendingKey);
    if (!token) {
      throw new BadRequestException({
        code: 'OTP_NOT_REQUESTED',
        message: 'Please request a code first.',
      });
    }

    let payload: MobileOtpJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<MobileOtpJwtPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
    } catch (e) {
      if ((e as Error)?.name === 'TokenExpiredError') {
        await this.redis.del(pendingKey).catch(() => undefined);
        throw new BadRequestException({
          code: 'OTP_EXPIRED',
          message: 'Code expired. Tap Resend to get a new one.',
        });
      }
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'Invalid code.',
      });
    }
    if (payload.type !== OTP_TYPE || payload.flowType !== 'verify') {
      throw new BadRequestException({
        code: 'OTP_FLOW_MISMATCH',
        message: 'Code was issued for a different flow.',
      });
    }
    try {
      await this.matchOtp(payload, { accessToken: dto.accessToken, otp: dto.otp });
    } catch (err) {
      await this.bumpVerifyAttempt(user, payload.mobile);
      const remaining = await this.attemptsRemaining(user, payload.mobile);
      if (remaining <= 0) {
        throw new HttpException(
          { code: 'OTP_LOCKED', message: 'Too many wrong codes.', attemptsRemaining: 0 },
          HttpStatus.LOCKED,
        );
      }
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code. Please try again.',
        attemptsRemaining: remaining,
      });
    }

    // Atomic claim — relies on the unique index on User.mobile to surface a
    // race during the OTP window (E11000 → MOBILE_TAKEN_DURING_VERIFY).
    await this.users.claimMobileVerified(userId, payload.mobile);
    await this.redis.del(pendingKey).catch(() => undefined);

    this.authService.auditAuthEvent({
      action: 'mobile_verify_success',
      userId,
      actorNameSnapshot: user.name,
      meta: { mobileMasked: maskIndianMobile(payload.mobile) },
    });

    return { ok: true };
  }

  /**
   * Mirror of `terminateAndLoginUnauth` for the OTP path. Caller proves phone
   * ownership with a fresh OTP code (re-verified here against the stored JWT)
   * instead of a password.
   */
  async terminateAndOtpLogin(dto: TerminateAndOtpLoginDto): Promise<AuthResult> {
    // Reuse the verify pipeline with no name/password — only login flowType.
    const verifyDto: VerifyOtpDto = Object.assign(new VerifyOtpDto(), {
      mobile: dto.mobile,
      otp: dto.otp,
      flowType: 'login' as const,
      platform: dto.platform,
      deviceName: dto.deviceName,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    // Resolve user + run all the verify-side guards (lockout, JWT verify,
    // constant-time compare). We can't call verifyOtp directly because we
    // need to swap createSession → terminateAndCreate at the finalize step.
    const norm = normaliseIndianMobile(dto.mobile);
    if (!norm) {
      throw new BadRequestException({
        code: 'OTP_INVALID_MOBILE',
        message: 'Enter a valid Indian mobile number',
      });
    }
    const user = await this.users.findByMobileWithMobileOtpFields(norm.full);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (this.isLockedOut(user)) {
      throw new HttpException(
        { code: 'OTP_LOCKED', message: 'Too many wrong codes.' },
        HttpStatus.LOCKED,
      );
    }
    this.assertActive(user);

    const stored = user.mobileVerificationToken;
    if (!stored) {
      throw new BadRequestException({
        code: 'OTP_NOT_REQUESTED',
        message: 'Please request a code first.',
      });
    }
    let payload: MobileOtpJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<MobileOtpJwtPayload>(stored, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
    } catch (e) {
      if ((e as Error)?.name === 'TokenExpiredError') {
        throw new BadRequestException({ code: 'OTP_EXPIRED', message: 'Code expired.' });
      }
      throw new BadRequestException({ code: 'OTP_INVALID', message: 'Invalid code.' });
    }
    if (payload.type !== OTP_TYPE || payload.flowType !== 'login' || payload.mobile !== norm.full) {
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'Invalid code.',
      });
    }
    try {
      await this.matchOtp(payload, { accessToken: dto.accessToken, otp: dto.otp });
    } catch (err) {
      await this.bumpVerifyAttempt(user, norm.full);
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code.',
      });
    }

    const result = await this.authService.finalizeAuthSuccess({
      user,
      platform: dto.platform,
      deviceName: dto.deviceName,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
      isNewUser: false,
      auditAction: 'login_success',
      auditMeta: {
        platform: dto.platform,
        variant: 'otp_terminate_and_login',
        terminatedSessionId: dto.sessionId,
      },
      terminateSessionId: dto.sessionId,
    });
    await this.clearOtpState(user, norm.full, 'login');
    // Suppress lint: verifyDto kept for symmetry with VerifyOtpDto shape.
    void verifyDto;
    return result;
  }

  // ─────────────────── STEP-UP (account-deletion Phase 1, §A.3) ───────────────
  // An AUTHENTICATED confirm-this-action factor used ONLY to gate the delete
  // action. Unlike login/register/forgot/verify it mints NO session and never
  // calls finalizeAuthSuccess — it returns a SINGLE-USE, short-lived proof token
  // (server nonce) that the delete call consumes (replay defence, §5).

  /**
   * Issue a step-up OTP to the authenticated user's existing verified mobile.
   * Bound to `userId`; staged in a per-user Redis slot, never on the User row.
   */
  async sendStepupOtp(userId: string, ipAddress?: string): Promise<SendOtpResponse> {
    const user = await this.users.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');
    if (!user.mobile) {
      throw new BadRequestException({
        code: 'MOBILE_NOT_SET',
        message: 'No mobile number on file to send a verification code.',
      });
    }
    const norm = normaliseIndianMobile(user.mobile);
    if (!norm) {
      throw new BadRequestException({
        code: 'OTP_INVALID_MOBILE',
        message: 'The mobile number on file is not valid.',
      });
    }

    if (
      await isCircuitTripped(
        this.redis,
        'otp:provider:failures',
        env.authOtp.circuitBreakerThreshold,
      )
    ) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_DEGRADED',
        message: 'SMS service temporarily unavailable.',
      });
    }
    await this.enforceRateLimits(norm.full, ipAddress);

    return this.mintAndDispatch({ mobileFull: norm.full, flowType: 'stepup', user });
  }

  /**
   * Verify a step-up OTP. On success, mint a single-use proof token (consumed
   * later by the delete call) and return it. Creates NO session.
   */
  async verifyStepupOtp(
    userId: string,
    otp?: string,
    accessToken?: string,
  ): Promise<{ ok: true; proofToken: string; expiresAt: string }> {
    const user = await this.users.findByIdWithMobileOtpFields(userId);
    if (!user) throw new BadRequestException('Account not found.');
    if (this.isLockedOut(user)) {
      throw new HttpException(
        {
          code: 'OTP_LOCKED',
          message: 'Too many wrong codes. Please wait.',
          lockedUntil: user.mobileOtpLockedUntil,
        },
        HttpStatus.LOCKED,
      );
    }

    const stored = await this.redis.get(this.pendingStepupKey(userId));
    if (!stored) {
      throw new BadRequestException({
        code: 'OTP_NOT_REQUESTED',
        message: 'Please request a code first.',
      });
    }

    let payload: MobileOtpJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<MobileOtpJwtPayload>(stored, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
    } catch (e) {
      if ((e as Error)?.name === 'TokenExpiredError') {
        await this.redis.del(this.pendingStepupKey(userId)).catch(() => undefined);
        throw new BadRequestException({
          code: 'OTP_EXPIRED',
          message: 'Code expired. Tap Resend to get a new one.',
        });
      }
      throw new BadRequestException({ code: 'OTP_INVALID', message: 'Invalid code.' });
    }
    // Cross-flow guard — a login/forgot/verify OTP can never satisfy step-up.
    if (payload.type !== OTP_TYPE || payload.flowType !== 'stepup') {
      throw new BadRequestException({
        code: 'OTP_FLOW_MISMATCH',
        message: 'Code was issued for a different action.',
      });
    }

    try {
      await this.matchOtp(payload, { otp, accessToken });
    } catch (err) {
      await this.bumpVerifyAttempt(user, payload.mobile);
      const remaining = await this.attemptsRemaining(user, payload.mobile);
      if (remaining <= 0) {
        throw new HttpException(
          {
            code: 'OTP_LOCKED',
            message: 'Too many wrong codes. Please wait.',
            attemptsRemaining: 0,
          },
          HttpStatus.LOCKED,
        );
      }
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code. Please try again.',
        attemptsRemaining: remaining,
      });
    }

    // Success — burn the OTP, reset lockout counters, mint the single-use proof.
    await this.redis.del(this.pendingStepupKey(userId)).catch(() => undefined);
    await this.users.update(userId, {
      mobileOtpAttempts: 0,
      mobileOtpLockedUntil: null,
    } as Partial<User>);

    const proofToken = crypto.randomBytes(32).toString('hex');
    await this.redis.set(this.stepupProofKey(userId), proofToken, 'EX', STEPUP_PROOF_TTL_SEC);

    this.authService.auditAuthEvent({
      action: 'stepup_verified',
      userId,
      actorNameSnapshot: user.name,
      meta: { purpose: 'account_deletion' },
    });

    return {
      ok: true,
      proofToken,
      expiresAt: new Date(Date.now() + STEPUP_PROOF_TTL_SEC * 1000).toISOString(),
    };
  }

  /**
   * Validate + BURN a step-up proof token (single-use). Returns true once for a
   * matching, unexpired nonce, then false (the nonce is deleted on match). The
   * delete call calls this so a proof can authorise exactly one action.
   */
  async consumeStepupProof(userId: string, proofToken: string): Promise<boolean> {
    if (!proofToken) return false;
    const stored = await this.redis.get(this.stepupProofKey(userId));
    if (!stored) return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(proofToken);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (match) {
      // Burn on success so the proof authorises exactly one delete (replay defence).
      await this.redis.del(this.stepupProofKey(userId)).catch(() => undefined);
    }
    return match;
  }

  // ───────────────────── PRIVATE HELPERS ─────────────────────

  private buildGenericResponse(): SendOtpResponse {
    return {
      ok: true,
      sent: true,
      expiresAt: new Date(Date.now() + env.authOtp.expiryMs).toISOString(),
      resendCooldownSec: env.authOtp.resendCooldownSec,
      mockMode: env.authOtp.mockEnabled,
    };
  }

  private async mintAndDispatch(args: {
    mobileFull: string;
    flowType: 'login' | 'register' | 'forgot' | 'verify' | 'stepup';
    user: User | null;
  }): Promise<SendOtpResponse> {
    // Mock-mode short-circuits OTP value; everything else stays the same so
    // dev paths exercise the same code as production.
    const otp = env.authOtp.mockEnabled ? MOCK_OTP : crypto.randomInt(100000, 1000000).toString();

    const expiresInSec = Math.floor(env.authOtp.expiryMs / 1000);
    const token = await this.jwt.signAsync(
      {
        // Widget channel never uses this value for comparison (verified via
        // Msg91WidgetOtpService instead) — keep a random placeholder so a
        // leaked/decoded JWT can't be replayed as a DLT-style code.
        otp: env.authOtp.channel === 'widget' ? crypto.randomBytes(4).toString('hex') : otp,
        channel: env.authOtp.channel,
        mobile: args.mobileFull,
        flowType: args.flowType,
        type: OTP_TYPE,
      } satisfies Omit<MobileOtpJwtPayload, 'iat' | 'exp'>,
      {
        secret: this.config.get<string>('jwt.accessSecret'),
        expiresIn: `${expiresInSec}s`,
      },
    );
    const expiresAt = new Date(Date.now() + env.authOtp.expiryMs);

    if (args.flowType === 'register') {
      // No User row yet — store JWT in Redis with TTL = OTP expiry.
      await this.redis.set(
        this.pendingOtpKey(args.mobileFull, 'register'),
        token,
        'EX',
        expiresInSec,
      );
    } else if (args.flowType === 'verify' && args.user) {
      // Authenticated mobile-verify flow — stage the JWT (which carries the
      // candidate mobile in its payload) in Redis instead of writing to
      // User.mobileVerificationToken. The User row never sees the candidate
      // identifier until claimMobileVerified runs at verify time, so an
      // abandoned send does not block other-user signup uniqueness.
      await this.redis.set(
        this.pendingVerifyMobileKey(this.userIdStr(args.user)),
        token,
        'EX',
        expiresInSec,
      );
      // Keep last-sent + flow on User for resend-cooldown UI semantics; these
      // are NOT the identity-channel value so they don't block uniqueness.
      await this.users.update(this.userIdStr(args.user), {
        mobileOtpLastSentAt: new Date(),
        mobileVerificationFlow: args.flowType,
      } as Partial<User>);
    } else if (args.flowType === 'stepup' && args.user) {
      // Authenticated step-up (account-deletion Phase 1, §A.3). Stage the
      // OTP-JWT in a dedicated per-user Redis slot — NOT on User.mobileVerification
      // Token — so it can never be replayed through the login/forgot verify path
      // (whose token lives on the User row). Keyed by userId; the user is already
      // authenticated, so the channel is their existing verified mobile.
      await this.redis.set(
        this.pendingStepupKey(this.userIdStr(args.user)),
        token,
        'EX',
        expiresInSec,
      );
    } else if (args.user) {
      // Login / forgot — target is the user's already-attached verified
      // mobile, so persisting the OTP-JWT to the User row is fine.
      await this.users.update(this.userIdStr(args.user), {
        mobileVerificationToken: token,
        mobileVerificationExpiresAt: expiresAt,
        mobileOtpLastSentAt: new Date(),
        mobileVerificationFlow: args.flowType,
      } as Partial<User>);
    }

    // Dispatch via MSG91 (or skip in mock-mode). Failures bump the circuit
    // breaker but do NOT block the response — the user has already been
    // told an OTP is on its way; the resend button is the recovery path.
    if (env.authOtp.mockEnabled) {
      this.logger.log(
        `[OTP MOCK] ${maskIndianMobile(args.mobileFull)} flow=${args.flowType} otp=${MOCK_OTP}`,
      );
    } else if (env.authOtp.channel === 'widget') {
      // The browser dispatches the actual SMS via MSG91's Widget JS SDK
      // immediately after this call returns `ok` (see web
      // OtpSendMode.tsx) — this backend call only ran the eligibility /
      // rate-limit gate above and staged the JWT for later verification.
      this.logger.log(
        `[OTP WIDGET] ${maskIndianMobile(args.mobileFull)} flow=${args.flowType} staged, client dispatches`,
      );
    } else {
      const templateId = env.msg91.authOtpTemplateId;
      const workspaceId = env.msg91.authOtpWorkspaceId;
      if (!templateId || !workspaceId) {
        // Fail loud — production must be configured. We still wrote the JWT
        // so a one-off retry after fix succeeds.
        throw new ServiceUnavailableException({
          code: 'SERVICE_DEGRADED',
          message: 'SMS service is not configured. Please use password.',
        });
      }
      const result = await this.sms.sendDltSms({
        workspaceId,
        mobile: args.mobileFull,
        templateId,
        vars: { VAR1: otp },
        creditSource: 'system',
        entityRef: { id: new Types.ObjectId(), type: 'AuthOtp' },
      });
      if (result.status !== 'sent') {
        await recordProviderFailure(
          this.redis,
          'otp:provider:failures',
          env.authOtp.circuitBreakerWindowSec,
          env.authOtp.circuitBreakerThreshold,
        );
        this.logger.warn(
          `[OTP DISPATCH] ${maskIndianMobile(args.mobileFull)} status=${result.status} error=${result.errorMessage ?? '(none)'}`,
        );
      }
    }

    const response: SendOtpResponse = {
      ok: true,
      sent: true,
      expiresAt: expiresAt.toISOString(),
      resendCooldownSec: env.authOtp.resendCooldownSec,
      mockMode: env.authOtp.mockEnabled,
    };

    // Idempotency window — 30s dedup of accidental double-clicks.
    await this.redis.set(
      `otp:idem:${args.mobileFull}:${args.flowType}`,
      JSON.stringify(response),
      'EX',
      env.authOtp.resendCooldownSec,
    );
    // Per-phone cooldown for the Send button (Resend reuses a separate key).
    await this.redis.set(
      `otp:cooldown:${args.mobileFull}`,
      '1',
      'EX',
      env.authOtp.resendCooldownSec,
    );

    if (args.user) {
      this.authService.auditAuthEvent({
        action: 'otp_sent',
        userId: this.userIdStr(args.user),
        actorNameSnapshot: args.user.name,
        meta: {
          flowType: args.flowType,
          channel: 'sms',
          mock: env.authOtp.mockEnabled,
          mobileMasked: maskIndianMobile(args.mobileFull),
        },
      });
    } else {
      this.authService.auditAnonOtpEvent({
        action: 'otp_sent',
        mobileMasked: maskIndianMobile(args.mobileFull),
        meta: {
          flowType: args.flowType,
          channel: 'sms',
          mock: env.authOtp.mockEnabled,
        },
      });
    }
    return response;
  }

  private async enforceRateLimits(mobileFull: string, ipAddress?: string): Promise<void> {
    const hourly = await checkSlidingWindow(this.redis, `otp:hourly:${mobileFull}`, {
      windowSec: 3600,
      limit: env.authOtp.rateLimitHourly,
    });
    if (!hourly.allowed) {
      throw new HttpException(
        {
          code: 'OTP_RATE_LIMITED',
          message: `Too many OTP requests for this number. Try again in ${hourly.retryAfterSec}s.`,
          retryAfterSec: hourly.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const daily = await checkSlidingWindow(this.redis, `otp:daily:${mobileFull}`, {
      windowSec: 86400,
      limit: env.authOtp.rateLimitDaily,
    });
    if (!daily.allowed) {
      throw new HttpException(
        {
          code: 'OTP_RATE_LIMITED',
          message: `Daily OTP limit reached for this number. Please use password.`,
          retryAfterSec: daily.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (ipAddress) {
      const ipDaily = await checkSlidingWindow(this.redis, `otp:ip:daily:${ipAddress}`, {
        windowSec: 86400,
        limit: env.authOtp.perIpDaily,
      });
      if (!ipDaily.allowed) {
        throw new HttpException(
          {
            code: 'OTP_RATE_LIMITED',
            message: 'Too many OTP requests from this network. Try again later.',
            retryAfterSec: ipDaily.retryAfterSec,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private isLockedOut(user: User | null): boolean {
    if (!user?.mobileOtpLockedUntil) return false;
    return new Date(user.mobileOtpLockedUntil).getTime() > Date.now();
  }

  /**
   * Single verification gate for all OTP-verify call sites (verifyOtp,
   * verifyMobile, verifyStepupOtp, terminateAndOtpLogin). `payload.channel`
   * (stamped at send time) decides the mechanism:
   *   - 'widget': `dto.accessToken` is checked against MSG91's
   *     verifyAccessToken API; the mobile it returns must match
   *     `payload.mobile`.
   *   - 'dlt' (or missing, for JWTs minted before this field existed):
   *     constant-time compare of `dto.otp` against `payload.otp`, exactly
   *     as before.
   * Throws BadRequestException({ code: 'OTP_INCORRECT' }) on failure —
   * callers keep their existing lockout/attempts-remaining bump around this
   * call unchanged.
   */
  private async matchOtp(
    payload: MobileOtpJwtPayload,
    dto: { otp?: string; accessToken?: string },
  ): Promise<void> {
    if (payload.channel === 'widget') {
      if (!dto.accessToken) {
        throw new BadRequestException({
          code: 'OTP_INCORRECT',
          message: 'Incorrect code. Please try again.',
        });
      }
      const verified = await this.widgetOtp.verifyAccessToken(dto.accessToken);
      if (!verified || verified.mobile !== payload.mobile) {
        throw new BadRequestException({
          code: 'OTP_INCORRECT',
          message: 'Incorrect code. Please try again.',
        });
      }
      return;
    }
    if (!dto.otp) {
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code. Please try again.',
      });
    }
    const submitted = Buffer.from(dto.otp.padStart(6, '0'));
    const expected = Buffer.from(payload.otp.padStart(6, '0'));
    if (submitted.length !== expected.length || !crypto.timingSafeEqual(submitted, expected)) {
      throw new BadRequestException({
        code: 'OTP_INCORRECT',
        message: 'Incorrect code. Please try again.',
      });
    }
  }

  private async bumpVerifyAttempt(user: User | null, mobileFull: string): Promise<void> {
    if (user) {
      const newCount = (user.mobileOtpAttempts ?? 0) + 1;
      const update: Partial<User> = { mobileOtpAttempts: newCount };
      if (newCount >= env.authOtp.maxVerifyAttempts) {
        update.mobileOtpLockedUntil = new Date(Date.now() + env.authOtp.lockoutMinutes * 60_000);
        this.authService.auditAuthEvent({
          action: 'otp_rate_limited',
          userId: this.userIdStr(user),
          actorNameSnapshot: user.name,
          meta: {
            mobileMasked: maskIndianMobile(mobileFull),
            attempts: newCount,
            lockoutMinutes: env.authOtp.lockoutMinutes,
          },
        });
      }
      await this.users.update(this.userIdStr(user), update);
      this.authService.auditAuthEvent({
        action: 'otp_verify_failure',
        userId: this.userIdStr(user),
        actorNameSnapshot: user.name,
        meta: { attempts: newCount, mobileMasked: maskIndianMobile(mobileFull) },
      });
    } else {
      // Register flow — no user yet. Track in Redis with the lockout TTL so
      // the next send-otp also sees the lock.
      const key = `otp:wrong:${mobileFull}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, env.authOtp.lockoutMinutes * 60);
      }
      this.authService.auditAnonOtpEvent({
        action: 'otp_verify_failure',
        mobileMasked: maskIndianMobile(mobileFull),
        meta: { attempts: count },
      });
    }
  }

  private async attemptsRemaining(user: User | null, mobileFull: string): Promise<number> {
    const max = env.authOtp.maxVerifyAttempts;
    if (user) {
      const used = user.mobileOtpAttempts ?? 0;
      // Refresh — bump persisted before this read in bumpVerifyAttempt.
      const fresh = await this.users.findByIdWithMobileOtpFields(this.userIdStr(user));
      const usedNow = fresh?.mobileOtpAttempts ?? used;
      return Math.max(0, max - usedNow);
    }
    const raw = await this.redis.get(`otp:wrong:${mobileFull}`);
    const used = raw ? parseInt(raw, 10) : 0;
    return Math.max(0, max - used);
  }

  private async clearOtpState(
    user: User | null,
    mobileFull: string,
    flowType: 'login' | 'register' | 'forgot' | 'verify',
  ): Promise<void> {
    if (user) {
      await this.users.update(this.userIdStr(user), {
        mobileVerificationToken: null,
        mobileVerificationExpiresAt: null,
        mobileOtpAttempts: 0,
        mobileOtpLockedUntil: null,
        mobileVerificationFlow: null,
      } as Partial<User>);
    }
    if (flowType === 'register') {
      await this.redis.del(this.pendingOtpKey(mobileFull, 'register')).catch(() => undefined);
    }
    await this.redis.del(`otp:idem:${mobileFull}:${flowType}`).catch(() => undefined);
    await this.redis.del(`otp:wrong:${mobileFull}`).catch(() => undefined);
  }

  private assertActive(user: User): void {
    if (!user.isActive) {
      // Specific "scheduled for deletion — contact us to recover" message for a
      // DPDP self-serve deletion; generic deactivated message otherwise (§A.2).
      throw buildSuspendedAccountError(user, env.accountDeletion.contactUrl);
    }
  }

  private pendingOtpKey(mobileFull: string, flowType: 'register'): string {
    return `pending-otp:${mobileFull}:${flowType}`;
  }

  /**
   * Redis key for the authenticated mobile-verify flow. Stores the signed
   * OTP-JWT whose payload carries the candidate mobile. Keyed by userId so
   * multiple users can race for the same number — the unique index on
   * `User.mobile` (enforced inside `UsersService.claimMobileVerified`)
   * decides who wins at the moment of verify.
   */
  private pendingVerifyMobileKey(userId: string): string {
    return `pending-verify:mobile:${userId}`;
  }

  /** Redis slot for the authenticated step-up OTP-JWT (account-deletion §A.3),
   *  keyed by userId — distinct from the login/forgot token on the User row. */
  private pendingStepupKey(userId: string): string {
    return `stepup-otp:${userId}`;
  }

  /** Redis slot for the single-use step-up proof nonce minted on a successful
   *  step-up verify and burned by `consumeStepupProof`. */
  private stepupProofKey(userId: string): string {
    return `stepup-proof:${userId}`;
  }

  private userIdStr(user: User): string {
    return user._id.toString();
  }
}
