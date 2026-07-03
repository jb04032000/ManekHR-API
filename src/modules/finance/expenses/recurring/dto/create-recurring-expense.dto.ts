import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RecurringExpenseLineDto {
  @IsMongoId()
  expenseAccountId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Min(1)
  amountPaise: number;

  @IsOptional()
  @IsNumber()
  @IsIn([0, 5, 12, 18, 28])
  gstRate?: number;

  @IsOptional()
  @IsIn(['full', 'blocked', 'nil_rated'])
  itcEligibility?: 'full' | 'blocked' | 'nil_rated';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCentre?: string;
}

export class RecurringExpenseScheduleDto {
  @IsIn(['monthly', 'quarterly', 'yearly', 'every_n_days'])
  mode: 'monthly' | 'quarterly' | 'yearly' | 'every_n_days';

  @IsOptional()
  @IsInt()
  @Min(1)
  dayOfMonth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  everyNDays?: number;

  @IsDateString()
  startDate: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class CreateRecurringExpenseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  templateName: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsIn(['cash', 'bank', 'cheque', 'upi'])
  paymentMode: 'cash' | 'bank' | 'cheque' | 'upi';

  @IsOptional()
  @IsMongoId()
  bankAccountId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecurringExpenseLineDto)
  lineItems: RecurringExpenseLineDto[];

  @IsOptional()
  @IsBoolean()
  isIntraState?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}$/)
  placeOfSupplyStateCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  narration?: string;

  @ValidateNested()
  @Type(() => RecurringExpenseScheduleDto)
  schedule: RecurringExpenseScheduleDto;

  @IsOptional()
  @IsBoolean()
  autoPostOnGenerate?: boolean;
}
