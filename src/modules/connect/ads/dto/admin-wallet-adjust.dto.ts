import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /admin/connect/ads/wallet/:userId/adjust`.
 *
 * A platform admin manually credits (+) or debits (−) an advertiser's spendable
 * wallet balance. `amount` is SIGNED whole rupees (1 credit = INR 1) — positive
 * adds credits, negative removes them. The service refuses to drive `balance`
 * below 0 and never touches the granted / reserved buckets. A `reason` is
 * mandatory so the append-only ledger + audit trail always carries why the
 * correction was made; `note` is optional free-text appended to the ledger row.
 *
 * Cross-module link: consumed by AdsAdminController -> AdsAdminService.adjustWallet
 * -> WalletService.adjust (writes an `adjustment` ledger row).
 */
export class AdminWalletAdjustDto {
  /** Signed whole-rupee delta. Positive = credit, negative = debit. Non-zero. */
  @IsInt()
  @IsNotEmpty()
  amount: number;

  /** Why the adjustment was made. Stored on the ledger row + audit meta. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;

  /** Optional extra free-text appended to the ledger note. */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}
