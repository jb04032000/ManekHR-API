import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RecurringScheduleDto {
  @IsIn(['monthly', 'quarterly', 'yearly', 'every_n_days'])
  mode: 'monthly' | 'quarterly' | 'yearly' | 'every_n_days';

  @IsOptional()
  @IsNumber()
  dayOfMonth?: number;

  @IsOptional()
  @IsNumber()
  everyNDays?: number;

  @IsString()
  startDate: string; // ISO date string

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class RecurringNotifyDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;
}

export class CreateRecurringTemplateDto {
  @IsString()
  templateName: string;

  @IsMongoId()
  partyId: string;

  @IsOptional()
  @IsArray()
  lineItems?: any[];

  @IsOptional()
  @IsArray()
  additionalCharges?: any[];

  @IsOptional()
  @IsString()
  placeOfSupplyStateCode?: string;

  @IsOptional()
  @IsObject()
  paymentTerms?: { termsDays?: number; label?: string };

  @IsOptional()
  @IsString()
  notes?: string;

  @ValidateNested()
  @Type(() => RecurringScheduleDto)
  schedule: RecurringScheduleDto;

  @IsOptional()
  @IsBoolean()
  amountAuto?: boolean;

  @IsOptional()
  @IsBoolean()
  autoPostOnGenerate?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurringNotifyDto)
  notifyOnGenerate?: RecurringNotifyDto;
}
