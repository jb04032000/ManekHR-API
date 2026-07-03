import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

/**
 * BatchIrnDto
 *
 * Body for POST /batch-generate.
 * DTO allows up to 500 invoice IDs — service splits at 100 sync + enqueues remainder
 * to einvoice-retry BullMQ queue (T-12-W3-05: batch flooding mitigation).
 */
export class BatchIrnDto {
  /**
   * Array of invoice IDs to generate IRNs for.
   * Maximum 500 per request (DTO cap); service processes 100 synchronously,
   * enqueues remainder via BullMQ einvoice-retry queue with exponential backoff.
   */
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  invoiceIds: string[];
}
