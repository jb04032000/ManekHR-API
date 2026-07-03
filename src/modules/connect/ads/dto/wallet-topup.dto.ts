import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * Body for `POST /me/connect/ads/wallet/topup`.
 * Credits the caller's ad wallet by `amount` INR. The `ref` field carries the
 * payment-gateway reference id (Razorpay order id, UPI ref, etc.) for
 * reconciliation; omitted for manual/admin credits.
 *
 * NOTE: this DTO backed the old direct-credit endpoint which has been removed.
 * It is retained because `WalletService.topup` (system/admin credit) and tests
 * may still reference the shape. The gateway flow uses the two DTOs below.
 */
export class WalletTopupDto {
  /** Amount to credit in INR (whole rupees). Minimum 1 INR. */
  @IsNumber()
  @Min(1)
  amount: number;

  /** Payment-gateway reference id for reconciliation. Optional for manual credits. */
  @IsOptional()
  @IsString()
  ref?: string;
}

/**
 * Body for `POST /connect/ads/wallet/topup/order` -- step 1 of the gateway
 * top-up. `amount` is in whole RUPEES; the service converts to paise at the
 * Razorpay boundary. Minimum 99 INR mirrors the AdWalletTopup schema floor.
 */
export class CreateWalletTopupOrderDto {
  /** Amount to top up in INR (whole rupees). Minimum 99 INR. */
  @IsInt()
  @Min(99)
  amount: number;
}

/**
 * Body for `POST /connect/ads/wallet/topup/confirm` -- step 2 of the gateway
 * top-up. Carries the signed Razorpay checkout payload plus the local intent
 * id so the server can verify the signature and credit exactly once.
 */
export class ConfirmWalletTopupDto {
  /** The local AdWalletTopup intent id created in step 1. */
  @IsString()
  @IsNotEmpty()
  walletTopupId: string;

  /** Razorpay order id echoed back from the checkout sheet. */
  @IsString()
  @IsNotEmpty()
  razorpayOrderId: string;

  /** Razorpay payment id from the signed checkout payload. */
  @IsString()
  @IsNotEmpty()
  razorpayPaymentId: string;

  /** HMAC-SHA256 signature Razorpay returns alongside the payment. */
  @IsString()
  @IsNotEmpty()
  razorpaySignature: string;
}
