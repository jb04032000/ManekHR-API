import {
  IsString,
  IsDate,
  IsNumber,
  IsArray,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BillAllocationDto {
  @IsString() billId: string;
  @IsString() billNumber: string;
  @IsNumber() @Min(0) billDuePaise: number;
  @IsNumber() @Min(1) allocatedPaise: number;
}

export class CreatePaymentOutDto {
  @IsString() financialYear: string;
  @Type(() => Date) @IsDate() paymentDate: Date;
  @IsString() partyId: string;
  @IsOptional() partySnapshot?: Record<string, any>;
  @IsString() paymentMode: string;
  @IsOptional() @IsString() bankAccountId?: string;
  @IsOptional() @IsString() referenceNo?: string;
  @IsOptional() @Type(() => Date) @IsDate() referenceDate?: Date;
  @IsNumber() @Min(1) totalAmountPaise: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BillAllocationDto)
  billAllocations: BillAllocationDto[];
  @IsOptional() @IsNumber() @Min(0) unappliedPaise?: number;
}
