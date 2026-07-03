import {
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class ReplenishPettyCashDto {
  /** CoA code of the source account: '1001' (main cash) or '1002-XX' (bank account) */
  @IsString()
  sourceAccountCode!: string;

  /** If the source is a cash register, decrement its balance atomically */
  @IsOptional()
  @IsMongoId()
  sourceCashRegisterId?: string;

  @IsInt()
  @Min(1)
  amountPaise!: number;

  @IsString()
  @MinLength(5)
  narration!: string;
}
