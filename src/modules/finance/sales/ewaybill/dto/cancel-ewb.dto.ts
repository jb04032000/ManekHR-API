import { IsInt, IsString, Max, Min } from 'class-validator';

/**
 * CancelEwbDto
 *
 * Body for POST /:invoiceId/cancel.
 * EWB cancellation must happen within 24 hours of generation (NIC rule).
 *
 * Cancel reason codes per NIC:
 *   1 = Duplicate
 *   2 = Order Cancelled
 *   3 = Data Entry Mistake
 *   4 = Others
 */
export class CancelEwbDto {
  /**
   * NIC EWB cancel reason code (integer 1-4).
   * Validated server-side (T-12-W3-02: cross-workspace cancel gate).
   */
  @IsInt()
  @Min(1)
  @Max(4)
  cancelReason: number;

  /**
   * Free-text cancellation remarks.
   * Stored on invoice.ewayBill for audit trail (T-12-W3-07).
   */
  @IsString()
  cancelRemarks: string;
}
