import { IsArray, IsIn, IsInt } from 'class-validator';

/**
 * IssueTokenDto — owner-side body for POST /finance/parties/:id/portal-tokens.
 *
 * scope: subset of ['statement','invoices','receipts'] (D-20).
 * View-only portal (owner decision 2026-06-06, feedback_no_payments_in_billing):
 * the 'pay' scope was removed - this module does no payment collection.
 * expiresInDays: one of the canonical TTLs per D-20.
 */
export class IssueTokenDto {
  @IsArray()
  @IsIn(['statement', 'invoices', 'receipts'], { each: true })
  scope!: string[];

  @IsInt()
  @IsIn([1, 7, 30, 90, 180, 365])
  expiresInDays!: number;
}
