import {
  IsDateString,
  IsOptional,
  IsMongoId,
  IsIn,
  IsBoolean,
  IsString,
  IsInt,
  IsNumber,
  Min,
  MinLength,
  MaxLength,
  Matches,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExpenseVoucherLineDto {
  @IsMongoId()
  expenseAccountId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Amount in paise — must be a positive integer */
  @IsInt()
  @Min(1)
  amountPaise: number;

  @IsOptional()
  @IsNumber()
  @IsIn([0, 5, 12, 18, 28])
  gstRate?: number;

  @IsIn(['full', 'blocked', 'nil_rated'])
  itcEligibility: 'full' | 'blocked' | 'nil_rated';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCentre?: string;
}

export class CreateExpenseVoucherDto {
  @IsDateString()
  voucherDate: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsIn(['cash', 'bank', 'cheque', 'upi'])
  paymentMode: 'cash' | 'bank' | 'cheque' | 'upi';

  @IsOptional()
  @IsMongoId()
  cashRegisterId?: string;

  @IsOptional()
  @IsMongoId()
  bankAccountId?: string;

  @IsOptional()
  @IsMongoId()
  chequeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utrReference?: string;

  @IsBoolean()
  isIntraState: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/)
  placeOfSupplyStateCode?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  narration: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExpenseVoucherLineDto)
  lineItems: ExpenseVoucherLineDto[];
}
