import { IsOptional, IsString } from 'class-validator';

export class PostPurchaseBillDto {
  /** Optional idempotency key — prevents duplicate posts on retries */
  @IsOptional() @IsString() idempotencyKey?: string;
}
