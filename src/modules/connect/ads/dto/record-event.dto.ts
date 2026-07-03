import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for `POST /me/connect/ads/events` - record an impression or click
 * against a served ad.
 * The `impressionToken` is a short-lived signed JWT issued by the decide
 * endpoint; it encodes the campaign, ad-set, and creative ids so the events
 * service can attribute the event without a separate lookup under normal
 * conditions.
 */
export class RecordEventDto {
  /**
   * Signed impression token returned by the decide endpoint.
   * Validates authenticity and prevents replay / fabrication.
   */
  @IsString()
  @IsNotEmpty()
  impressionToken: string;
}
