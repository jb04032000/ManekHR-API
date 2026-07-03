import {
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateContraVoucherDto {
  @IsDateString()
  voucherDate!: string;

  @IsString()
  fromAccountCode!: string;   // e.g., '1001' (Cash) or '1002-01' (HDFC sub-account)

  @IsString()
  toAccountCode!: string;

  @IsInt()
  @Min(1)
  amountPaise!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  narration!: string;

  @IsOptional()
  @IsMongoId()
  fromCashRegisterId?: string;   // when fromAccountCode is cash, decrement this register

  @IsOptional()
  @IsMongoId()
  toCashRegisterId?: string;    // when toAccountCode is cash, increment this register
}
