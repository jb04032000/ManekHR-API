import { IsInt, IsString, Length, Max, Min } from 'class-validator';

/**
 * CancelIrnDto
 *
 * Body for POST /:invoiceId/cancel.
 * NIC IRP cancel reason codes 1-4:
 *   1 = Duplicate
 *   2 = Data Entry Mistake
 *   3 = Order Cancelled
 *   4 = Others
 */
export class CancelIrnDto {
  /**
   * NIC IRP cancel reason code (integer 1-4).
   * Validated server-side before provider call.
   */
  @IsInt()
  @Min(1)
  @Max(4)
  cancelReason: number;

  /**
   * Free-text remarks for cancellation (1-100 chars).
   * Stored on invoice.eInvoice for audit trail (T-12-W3-07).
   */
  @IsString()
  @Length(1, 100)
  cancelRemarks: string;
}
