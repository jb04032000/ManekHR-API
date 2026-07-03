import { IsOptional, IsString } from 'class-validator';

export class PostPaymentReceiptDto {
  @IsOptional() @IsString() idempotencyKey?: string;
}
