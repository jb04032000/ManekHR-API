import { IsString, IsNumber, IsOptional, IsEnum, Min } from 'class-validator';
import { AddOnBillingCycle } from '../schemas/add-on-definition.schema';

export class PurchaseAddOnDto {
  @IsString()
  addOnDefinitionId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsEnum(AddOnBillingCycle)
  billingCycle?: AddOnBillingCycle;
}

export class CancelAddOnDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
