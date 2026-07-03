import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LineItemDto {
  @IsMongoId()
  itemId: string;

  @IsString()
  itemName: string;

  @IsOptional()
  @IsString()
  hsnSacCode?: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  // R11 textile dual-unit breakdown (optional; display/print only, qty stays authoritative).
  @IsOptional() @IsNumber() @Min(0) secondaryQty?: number;
  @IsOptional() @IsString() secondaryUnit?: string;
  @IsOptional() @IsNumber() @Min(0) conversionFactor?: number;

  // R11 inventory metadata: chosen godown/lot so stock-out decrements the right lot at post.
  @IsOptional() @IsMongoId() godownId?: string;
  @IsOptional() @IsMongoId() lotId?: string;

  @IsNumber()
  @Min(0)
  ratePaise: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  rateCentiPaise?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountFlatPaise?: number;

  @IsIn([0, 5, 12, 18, 28])
  taxRate: 0 | 5 | 12 | 18 | 28;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cessRate?: number;

  @IsBoolean()
  isTaxInclusive: boolean;
}

export class AdditionalChargeDto {
  @IsString()
  label: string;

  @IsNumber()
  amountPaise: number;

  @IsBoolean()
  isTaxable: boolean;

  @IsOptional()
  @IsIn([0, 5, 12, 18, 28])
  taxRate?: 0 | 5 | 12 | 18 | 28;
}

export class LateFeeScheduleDto {
  @IsIn(['percentage_per_day', 'flat_per_period', 'compound_monthly'])
  type: string;

  @IsNumber()
  @Min(0)
  value: number;

  @IsNumber()
  @Min(0)
  gracePeriodDays: number;
}

export class CreateSaleInvoiceDto {
  @IsMongoId()
  partyId: string;

  @IsDateString()
  voucherDate: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems: LineItemDto[];

  @IsString()
  placeOfSupplyStateCode: string;

  // 2c: tax payable by the recipient under reverse charge.
  @IsOptional()
  @IsBoolean()
  isReverseCharge?: boolean;

  // 2d: issue this document as a Bill of Supply (no tax) rather than a tax invoice.
  @IsOptional()
  @IsBoolean()
  isBillOfSupply?: boolean;

  // 2f multi-GSTIN: the firm's GSTIN registration this invoice is issued under.
  @IsOptional()
  @IsString()
  sellerGstin?: string;

  @IsOptional()
  @IsObject()
  paymentTerms?: { termsDays: number };

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdditionalChargeDto)
  additionalCharges?: AdditionalChargeDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  internalNotes?: string;

  @IsOptional()
  @IsObject()
  shipping?: {
    mode?: string;
    vehicleNo?: string;
    transporter?: string;
    distance?: number;
    address?: string;
  };

  @IsOptional()
  @ValidateNested()
  @Type(() => LateFeeScheduleDto)
  lateFeeSchedule?: LateFeeScheduleDto;

  // D13 dalali/broker: the broker for this deal + their commission % (an invoice-level override of
  // the broker party's default rate). Feeds the Broker Commission Register report (R-25), which was
  // previously orphaned because nothing on the invoice set these.
  @IsOptional()
  @IsMongoId()
  brokerPartyId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  brokerCommissionPct?: number;
}
