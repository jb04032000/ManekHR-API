import { IsOptional, IsString } from 'class-validator';

export class PostPaymentOutDto {
  /** Optional idempotency key — prevents duplicate posts on retries */
  @IsOptional() @IsString() idempotencyKey?: string;
}
