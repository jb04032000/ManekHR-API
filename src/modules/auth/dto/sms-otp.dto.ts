import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Platform } from '../../../common/enums/platform-access.enum';
import { FULL_INDIAN_RE, transformMobile } from '../utils/mobile-normalizer';

export type OtpFlowType = 'login' | 'register' | 'forgot' | 'verify';

const OTP_REGEX = /^\d{6}$/;
const OTP_MESSAGE = 'OTP must be exactly 6 digits';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

/**
 * Workspace fields collected upfront on the web combined-signup form
 * (SignupMode.tsx) and submitted alongside the OTP. When this nested DTO is
 * present on a `flowType=register` verify-otp call, the service treats the
 * call as the "web-combined" signup variant and enforces:
 *   - dto.name required (min 2)
 *   - dto.password required (min 8)
 *   - User + Workspace created atomically (compensating delete on failure)
 *
 * When omitted, the call falls back to the legacy "OTP-only" register variant
 * (mobile-app today): User row created with placeholder name + optional
 * password, Workspace created later via a separate call.
 */
export class RegisterWorkspaceFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  location?: string;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  businessType?: string;

  @IsString()
  @IsOptional()
  @Matches(GSTIN_REGEX, {
    message: 'GSTIN must be a valid 15-character GSTIN',
  })
  gstin?: string;

  @IsString()
  @IsOptional()
  @Matches(PAN_REGEX, { message: 'PAN must be a valid 10-character PAN' })
  pan?: string;

  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  fyStartMonth?: number;
}

export class SendOtpDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile: string;

  @IsString()
  @IsIn(['login', 'register', 'forgot'])
  flowType: 'login' | 'register' | 'forgot';

  // Reserved for v1.1 reCAPTCHA hardening — accepted but unused today.
  @IsString()
  @IsOptional()
  recaptchaToken?: string;
}

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile: string;

  // Exactly one of `otp` (DLT channel, 6 digits) or `accessToken` (widget
  // channel, MSG91's verified-token string) must be present — enforced at
  // runtime in SmsOtpService (DTO-level XOR isn't expressible cleanly with
  // class-validator here since both are legitimately optional strings).
  @ValidateIf((o: VerifyOtpDto) => !o.accessToken)
  @IsString()
  @Matches(OTP_REGEX, { message: OTP_MESSAGE })
  otp?: string;

  @ValidateIf((o: VerifyOtpDto) => !o.otp)
  @IsString()
  @IsOptional()
  accessToken?: string;

  @IsString()
  @IsIn(['login', 'register', 'forgot'])
  flowType: 'login' | 'register' | 'forgot';

  // Optional at the DTO level for backwards compatibility with the legacy
  // OTP-only register variant (mobile-app: User created with placeholder
  // name, password set later via Profile). When the new web combined-signup
  // variant is in use (`workspace` field present), the service enforces
  // `name` + `password` as required at runtime — see SmsOtpService.verifyOtp.
  // Empty string is treated as "not provided" via the ValidateIf gate so
  // callers can pass `''` as well as omit the field.
  @ValidateIf((o: VerifyOtpDto) => typeof o.name === 'string' && o.name.length > 0)
  @IsString()
  @MinLength(2)
  name?: string;

  @IsString()
  @IsOptional()
  @MinLength(8)
  password?: string;

  // Web combined-signup fields. Presence of this object signals the
  // "web-combined" register variant: name + password become mandatory and
  // the service creates User + Workspace atomically (compensating delete on
  // failure). Mobile-app callers omit this field and continue to use the
  // legacy User-only register path.
  @IsOptional()
  @ValidateNested()
  @Type(() => RegisterWorkspaceFieldsDto)
  workspace?: RegisterWorkspaceFieldsDto;

  // Wave 4.8 (2026-05-10) — atomic signup-and-accept-invite path. Presence
  // signals the new-user invite flow: instead of creating a new workspace
  // (legacy `workspace` field), the service creates a User and immediately
  // joins the existing workspace via the bridge `WorkspaceMember`. Mutually
  // exclusive with `workspace` at runtime — both set is a 400. The token
  // value is the raw invite-token (the same value embedded in the email/SMS
  // invite URL); the service hashes + matches against
  // `WorkspaceMember.inviteTokenHash`. An identifier match against the
  // invitee's normalized mobile is enforced for security (prevents
  // token-replay across users).
  @IsString()
  @IsOptional()
  inviteToken?: string;

  /**
   * Product-policy consent given by the user via the SignupMode T&C checkbox
   * during the OTP register flow. When present, `SmsOtpService.verifyOtp`'s
   * register branch writes the matching `connectPolicyAcceptedAt` /
   * `erpPolicyAcceptedAt` field on the SAME user-creation save — no
   * race-prone post-signup round-trip. Mirrors `RegisterDto.acceptedPolicy`.
   */
  @IsString()
  @IsOptional()
  @IsEnum(['connect', 'erp'], { message: 'acceptedPolicy must be "connect" or "erp"' })
  acceptedPolicy?: 'connect' | 'erp';

  /**
   * Connect Referral Program — optional referral code captured from the `?ref=`
   * link on the signup form (mirrors RegisterDto.referralCode). On the
   * register branch, SmsOtpService.verifyOtp passes it to
   * ReferralService.attachReferralAtSignup AFTER the user + session exist,
   * wrapped so a bad/unknown code NEVER fails the OTP signup. Max 16 chars.
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

export class ResendOtpDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile: string;

  @IsString()
  @IsIn(['login', 'register', 'forgot'])
  flowType: 'login' | 'register' | 'forgot';
}

/**
 * Authenticated route — verifies the caller wants to attach OR re-verify the
 * mobile on their existing account. Body.mobile is optional: when omitted the
 * service uses the user's existing User.mobile (re-verify); when provided the
 * service writes the new mobile (unverified) AND sends OTP.
 */
export class SendMobileVerifyOtpDto {
  @IsString()
  @IsOptional()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile?: string;
}

export class VerifyMobileDto {
  @ValidateIf((o: VerifyMobileDto) => !o.accessToken)
  @IsString()
  @Matches(OTP_REGEX, { message: OTP_MESSAGE })
  otp?: string;

  @ValidateIf((o: VerifyMobileDto) => !o.otp)
  @IsString()
  @IsOptional()
  accessToken?: string;
}

/**
 * Mirror of TerminateAndLoginUnauthDto for the OTP path. Caller proves phone
 * ownership with `otp` (just verified server-side) instead of `password`.
 */
export class TerminateAndOtpLoginDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile: string;

  @ValidateIf((o: TerminateAndOtpLoginDto) => !o.accessToken)
  @IsString()
  @Matches(OTP_REGEX, { message: OTP_MESSAGE })
  otp?: string;

  @ValidateIf((o: TerminateAndOtpLoginDto) => !o.otp)
  @IsString()
  @IsOptional()
  accessToken?: string;

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
