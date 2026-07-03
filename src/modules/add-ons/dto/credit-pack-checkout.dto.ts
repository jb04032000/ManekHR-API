import { IsInt, IsMongoId, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateCreditPackOrderDto {
  @IsMongoId()
  addOnDefinitionId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class ConfirmCreditPackPaymentDto {
  @IsMongoId()
  creditPackPaymentId: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  razorpayOrderId: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  razorpayPaymentId: string;

  @IsString()
  @MinLength(8)
  razorpaySignature: string;
}
