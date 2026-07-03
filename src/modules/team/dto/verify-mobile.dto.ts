import { IsString, IsNotEmpty, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { transformMobile, FULL_INDIAN_RE } from '../../auth/utils/mobile-normalizer';

export class StartVerifyMobileDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile!: string;
}

export class ConfirmVerifyMobileDto {
  @IsString()
  @IsNotEmpty()
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  mobile!: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}

/**
 * Phase 1f (verify-later flow). Owner skipped OTP at add-member time and
 * is now verifying the saved member's mobile from the member profile page.
 * Body carries only the proof token; the BE looks up the member by URL
 * param + the workspace-scoped controller and validates the token against
 * the persisted mobile (member.mobile) before stamping mobileVerifiedAt.
 */
export class VerifyExistingMobileDto {
  @IsString()
  @IsNotEmpty()
  mobileVerifyToken!: string;
}
