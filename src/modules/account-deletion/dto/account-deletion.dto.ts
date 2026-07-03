import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * DTOs for the verified self-serve account-deletion flow (Scope 3, plan §6).
 * The global ValidationPipe runs whitelist + forbidNonWhitelisted, so any extra
 * body field is rejected — these list EXACTLY the accepted fields.
 */

/** Body for `POST /me/deletion/stepup/verify` — exchange the step-up OTP for a
 *  single-use proof token. */
export class VerifyStepupOtpDto {
  // Exactly one of `otp` (DLT channel) or `accessToken` (widget channel,
  // MSG91's verified-token string) must be present — enforced at runtime in
  // SmsOtpService.matchOtp. Mirrors VerifyMobileDto/TerminateAndOtpLoginDto.
  @ValidateIf((o: VerifyStepupOtpDto) => !o.accessToken)
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'Enter the numeric verification code you received.' })
  otp?: string;

  @ValidateIf((o: VerifyStepupOtpDto) => !o.otp)
  @IsString()
  @IsOptional()
  accessToken?: string;
}

/** Re-auth factor supplied with a sensitive action. Optional overall (an
 *  OTP-only account needs none — the step-up proof is its factor, §A.11), but
 *  when present `kind` must be one of the two supported credential types. */
export class DeletionReauthDto {
  @IsIn(['password', 'google'])
  kind: 'password' | 'google';

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  googleIdToken?: string;
}

/** Body for `POST /me/deletion/account` — schedule whole-account deletion. The
 *  user id is ALWAYS the JWT subject; there is intentionally no userId field. */
export class ScheduleAccountDeletionDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DeletionReauthDto)
  reauth?: DeletionReauthDto;

  /** The single-use step-up proof minted by `POST /me/deletion/stepup/verify`. */
  @IsString()
  @IsNotEmpty()
  otpProof: string;

  /** Type-to-confirm phrase. The exact required value is enforced server-side
   *  (AccountDeletionService.DELETION_CONFIRM_PHRASE); here it is only required
   *  to be a non-empty string. */
  @IsString()
  @IsNotEmpty()
  confirm: string;
}
