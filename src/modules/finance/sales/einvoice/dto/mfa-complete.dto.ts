import { IsString, Length } from 'class-validator';

/**
 * DTO for completing NIC Direct IRP session via OTP.
 *
 * Used by Wave 3 EInvoiceController for POST /einvoice/complete-session.
 * sessionId is the opaque UUID returned by prepareSession (stored in Redis).
 * otp is the 6-digit code sent by NIC to the firm's registered mobile.
 */
export class MfaCompleteDto {
  @IsString()
  sessionId: string;

  @IsString()
  @Length(6, 6)
  otp: string;
}
