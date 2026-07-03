import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload for `POST /connect/marketplace/listings/:id/inquiries` (Phase M1.5).
 *
 * The buyer-user is always the JWT subject; the listing comes from the URL
 * param. The body carries only the optional message - everything else is
 * resolved server-side, so cross-buyer / cross-listing manipulation is
 * impossible.
 */
export class CreateInquiryDto {
  /**
   * Optional short note from the buyer. Bounded so a low-literacy SMB buyer
   * can fire a quick "interested, will call" without composing a paragraph.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
