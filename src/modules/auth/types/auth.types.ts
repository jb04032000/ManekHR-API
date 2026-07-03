import { User } from '../../users/schemas/user.schema';
import { Platform, PlatformAccess } from '../../../common/enums/platform-access.enum';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: User;
  isNewUser?: boolean;
  platformAccess?: PlatformAccess;
  /**
   * Set when the user reached this AuthResult via the SMS-OTP forgot-password
   * flow. FE honours by routing post-login to the change-password page so the
   * user picks a new credential before resuming work.
   */
  mustResetPassword?: boolean;
}

export interface RefreshResult extends AuthTokens {
  platformAccess?: PlatformAccess;
}

/**
 * Shape of the JWT payload signed by `issueTokens` for both access + refresh
 * tokens. `jti` is added in the token-issuer; `platform` is provenance for
 * downstream Platform.WEB / Platform.MOBILE checks.
 *
 * `forgotPasswordReset: true` is added when `finalizeAuthSuccess` is called
 * with `mustResetPassword: true` (today: only the SMS-OTP forgot-password
 * flow). The claim authorises a single subsequent `PATCH /users/change-password`
 * call to bypass the "current password" check (since the user just proved
 * phone ownership via OTP and, by definition, doesn't know the old password).
 * The claim is single-session: the change-password handler revokes the
 * current jti and reissues a fresh token pair WITHOUT the claim, so it
 * cannot be replayed.
 */
export interface AuthJwtPayload {
  sub: string;
  platform?: Platform;
  jti?: string;
  /**
   * Per-login session-family id. Minted once at login by `issueTokens`,
   * copied UNCHANGED across every `/auth/refresh`. App-Lock unlock state is
   * keyed to it so an unlock survives token rotation. See
   * docs/connect/specs/2026-05-19-connect-first-architecture-design.md §13.
   */
  family?: string;
  forgotPasswordReset?: true;
  iat?: number;
  exp?: number;
}

/**
 * Subset extracted via `jwtService.decode()` — used by `revokeTokens` to
 * denylist by jti without re-verifying the signature (see comment in
 * AuthService.revokeTokens for the reasoning).
 */
export interface DecodedJwtMeta {
  jti?: string;
  family?: string;
  exp?: number;
}

/**
 * Email-verification OTP token payload — distinct from the auth-token shape
 * because it carries the OTP + flow type.
 */
export interface OtpVerifyJwtPayload {
  otp: string;
  email: string;
  type: string;
  iat?: number;
  exp?: number;
}

/**
 * Email registration-OTP payload — minted by AuthService.sendEmailRegistrationOtp,
 * stored in Redis keyed by email, consumed by AuthService.register when the
 * caller passes `emailOtp` alongside the new web combined-signup payload.
 * Mirrors MobileOtpJwtPayload's discriminated shape.
 */
export interface EmailOtpJwtPayload {
  otp: string;
  email: string;
  flowType: 'register';
  type: 'email-otp';
  iat?: number;
  exp?: number;
}

/**
 * Mobile-OTP token payload — mirrors the email pattern but carries the
 * normalised mobile + the auth flow this OTP was minted for. The `flowType`
 * stops a register-OTP from being used to log in (or vice versa); guarded
 * server-side in SmsOtpService.verifyOtp.
 */
export interface MobileOtpJwtPayload {
  otp: string;
  /** Which product sent/verifies this OTP. Stamped at mint time from
   *  env.authOtp.channel. 'dlt' compares `otp` directly; 'widget' ignores
   *  `otp` (placeholder) and verifies via Msg91WidgetOtpService instead. */
  channel: 'dlt' | 'widget';
  mobile: string;
  // `stepup` (account-deletion Phase 1, §A.3) is an AUTHENTICATED confirm-this-
  // action factor — it mints a single-use proof token, NOT a session, so it can
  // never be replayed as a login (the flowType guard rejects cross-flow use).
  flowType: 'login' | 'register' | 'forgot' | 'verify' | 'stepup';
  /** Discriminator — always `'mobile-otp'`. Cross-flow guard. */
  type: 'mobile-otp';
  iat?: number;
  exp?: number;
}
