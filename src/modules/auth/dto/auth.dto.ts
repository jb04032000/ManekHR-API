import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  IsEnum,
  Matches,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Platform } from '../../../common/enums/platform-access.enum';
import { RegisterWorkspaceFieldsDto } from './sms-otp.dto';

const PIN_REGEX = /^\d{6}$/;
const PIN_MESSAGE = 'PIN must be exactly 6 digits';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsString()
  @MinLength(6)
  password: string;

  /**
   * 6-digit OTP from the registration-OTP email (POST /auth/email-otp/send-register).
   * Required by AuthService.register when `email` + `workspace` are present
   * (web combined-signup): the BE verifies the OTP against the Redis pending
   * key before creating the User. Absent for legacy mobile-app User-only
   * register or for the OTP-mobile path (which uses /auth/verify-otp instead).
   */
  @IsString()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'OTP must be exactly 6 digits' })
  emailOtp?: string;

  /**
   * Web combined-signup workspace fields. Presence of this object signals the
   * "web-combined" register variant (used by the new email-path SignupMode):
   * AuthService.register creates User + Workspace atomically with a
   * compensating User-delete on workspace failure. Mirrors the OTP-path web
   * combined-signup variant on VerifyOtpDto. Mobile-app and legacy callers
   * omit this field and continue with User-only register.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => RegisterWorkspaceFieldsDto)
  workspace?: RegisterWorkspaceFieldsDto;

  /**
   * Wave 4.8 (2026-05-10) — atomic signup-and-accept-invite path. Presence
   * signals the new-user invite flow: instead of creating a new workspace,
   * AuthService.register creates a User and immediately joins the invited
   * workspace via the bridge `WorkspaceMember`. Mutually exclusive with
   * `workspace` at runtime. The token is hashed and matched against
   * `WorkspaceMember.inviteTokenHash`. An identifier match against the
   * invitee's email is enforced for security (prevents token-replay across
   * users).
   */
  @IsString()
  @IsOptional()
  inviteToken?: string;

  /**
   * Product-policy consent given by the user via the SignupMode T&C checkbox
   * (`signup.policy*` keys). When present, `AuthService.register` writes the
   * matching `connectPolicyAcceptedAt` / `erpPolicyAcceptedAt` field on the
   * SAME document save as user creation — no race-prone post-signup
   * round-trip. The downstream Connect / ERP layout's policy gate then reads
   * the field as already-stamped on the very first navigation after signup.
   * Backward-compatible: legacy callers omit it and the policy stays
   * `null` (gate fires once on first product entry as before).
   */
  @IsString()
  @IsOptional()
  @IsEnum(['connect', 'erp'], { message: 'acceptedPolicy must be "connect" or "erp"' })
  acceptedPolicy?: 'connect' | 'erp';

  /**
   * Connect Referral Program — optional referral code captured from the `?ref=`
   * link on the signup form. Best-effort: AuthService.register passes it to
   * ReferralService.attachReferralAtSignup AFTER the user + session are created,
   * wrapped so a bad/unknown code NEVER fails registration. Absent for organic
   * signups. Max 16 chars (codes are 6-10; the slack tolerates legacy/padded input).
   */
  @IsString()
  @IsOptional()
  @MaxLength(16)
  referralCode?: string;

  @IsEnum(Platform)
  @IsOptional()
  platform?: Platform;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsEnum(Platform)
  @IsOptional()
  platform?: Platform;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @IsEnum(Platform)
  @IsOptional()
  platform?: Platform;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;
}

/**
 * Email-OTP send for the register flow. Mirrors SendOtpDto (mobile) but
 * channel-specific: only `flowType=register` is accepted because login + forgot
 * for email use existing flows (password login + email reset link).
 */
export class SendEmailRegistrationOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}

/**
 * Used by the SMS-OTP forgot-password flow after the user has authenticated
 * via OTP and reached the /dashboard/settings#password card. The controller
 * gates this endpoint behind `req.user.forgotPasswordReset === true`, so a
 * valid claim-bearing JWT is required — no `currentPassword` field is
 * accepted (the user, by definition, doesn't know it).
 *
 * The `refreshToken` is required because we denylist the OLD pair before
 * issuing a fresh pair without the claim — without the refresh token we
 * couldn't denylist the refresh-side jti.
 */
export class ChangePasswordAfterForgotDto {
  @IsString()
  @MinLength(8)
  newPassword: string;

  // OQ-1 (auth-hardening): optional in the body — web reads the prior refresh
  // token from the httpOnly cookie (resolved in the controller), mobile still
  // sends it in the body. Used only to denylist the OLD pair before issuing a
  // fresh one; the controller re-sets the cookie with the new token.
  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsEnum(Platform)
  @IsOptional()
  platform?: Platform;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class RefreshTokenDto {
  // OQ-1 (auth-hardening): now OPTIONAL in the body. The web client sends the
  // refresh token via the httpOnly `z360_refresh_token` cookie (XSS-safe), so
  // its body field is absent; the controller resolves cookie-first then body.
  // The mobile client still passes it in the body (no cookie jar). The
  // controller/service enforce "a token must be present somewhere" and 401 if
  // neither cookie nor body supplies one — so this stays as secure as before.
  @IsString()
  @IsOptional()
  refreshToken?: string;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}

export class CheckUserDto {
  @IsString()
  @IsNotEmpty()
  identifier: string; // email OR mobile
}

export class SendVerificationEmailDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class VerifyEmailDto {
  // The email field is informational — the verifyEmail service looks the
  // user up by the authenticated userId, so the OTP-token alone is enough
  // to verify. Kept optional here for clients that still send it.
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsNotEmpty()
  token: string;
}

export class SetupAdminDto {
  @IsString()
  @IsNotEmpty()
  identifier: string; // email OR mobile

  @IsString()
  @IsNotEmpty()
  secret: string;
}

export class SetPinDto {
  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  pin: string;

  // Optional active workspace at unlock time. Used by the server to size the
  // sliding unlock TTL against the workspace's `appLockIdleMs` override.
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class ChangePinDto {
  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  currentPin: string;

  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  newPin: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class VerifyPinDto {
  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  pin: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class ForgotPinCredentialDto {
  @IsString()
  @IsIn(['password', 'google'])
  kind: 'password' | 'google';

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  googleIdToken?: string;
}

export class ForgotPinResetDto {
  @IsString()
  @IsNotEmpty()
  pinResetToken: string;

  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  newPin: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

/**
 * Used by the unauthenticated session-limit modal flow: client re-submits the
 * login credentials together with the sessionId they want to terminate, and
 * the server atomically validates + terminates + issues a fresh token pair.
 */
export class TerminateAndLoginUnauthDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsEnum(Platform)
  @IsOptional()
  platform?: Platform;

  @IsString()
  @IsOptional()
  deviceName?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}
