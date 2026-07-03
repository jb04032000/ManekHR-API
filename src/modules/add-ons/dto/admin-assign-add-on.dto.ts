import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  Min,
} from 'class-validator';
import { AddOnBillingCycle } from '../schemas/add-on-definition.schema';

export class AdminAssignAddOnDto {
  @IsString()
  userId: string;

  @IsString()
  addOnDefinitionId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsEnum(AddOnBillingCycle)
  billingCycle?: AddOnBillingCycle;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
