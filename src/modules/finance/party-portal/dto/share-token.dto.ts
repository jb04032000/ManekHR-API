import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

/**
 * ShareTokenDto — body for POST /finance/parties/:id/portal-tokens/:jti/share.
 *
 * The `url` is supplied by the caller (the portal URL captured at issuance
 * time) — the controller never reconstructs the JWT from the stored row, since
 * only the jti is persisted (T-16-04-06).
 *
 * channel:
 *   - 'copy'     → controller returns { ok, url } so the client can clipboard
 *   - 'whatsapp' → reminder dispatcher sends via WhatsApp adapter
 *   - 'email'    → reminder dispatcher sends via email adapter
 */
export class ShareTokenDto {
  @IsString()
  @IsUrl({ require_tld: false })
  url!: string;

  @IsString()
  @IsIn(['copy', 'whatsapp', 'email'])
  channel!: 'copy' | 'whatsapp' | 'email';

  @IsOptional()
  @IsString()
  recipient?: string;
}
