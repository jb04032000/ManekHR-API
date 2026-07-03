import {
  IsString,
  IsNumber,
  IsDate,
  IsInt,
  IsMongoId,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsBoolean,
  ArrayMinSize,
  Min,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class JwInvoiceLineDto {
  @IsString()
  @IsNotEmpty()
  description: string;

  @IsOptional()
  @IsString()
  hsn?: string;

  @IsNumber()
  @Min(0.001)
  qty: number;

  @IsString()
  @IsNotEmpty()
  unit: string;

  /**
   * Rate per unit in paise. Must be > 0 before posting.
   * On auto-create from JWO, service sets this to 0 (user must fill before post).
   */
  @IsNumber()
  @Min(0)
  ratePaise: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  rateCentiPaise?: number;

  @IsOptional()
  // R5: keep in sync with JobWorkType / jw-invoice.schema enum. dyeing_printing is the
  // legacy value; printing/embroidery route income to 4022/4023.
  @IsIn(['general_textile', 'embroidery', 'dyeing_printing', 'printing', 'other'])
  jobWorkType?: string;

  @IsOptional()
  @IsMongoId()
  jobWorkLotId?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  karigarIds?: string[];
}

export class CreateJwInvoiceDto {
  @Type(() => Date)
  @IsDate()
  voucherDate: Date;

  @IsMongoId()
  partyId: string;

  /** Linked JWO challan — mandatory (D-04) */
  @IsMongoId()
  jwOutwardChallanId: string;

  /**
   * Determines IGST (interstate) vs CGST+SGST (intrastate).
   * Typically auto-set from party.state, but user can override for special cases.
   */
  @IsString()
  @IsNotEmpty()
  placeOfSupplyStateCode: string;

  @IsOptional()
  @IsBoolean()
  reverseCharge?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueDate?: Date;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JwInvoiceLineDto)
  lines: JwInvoiceLineDto[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  karigarIds?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsString()
  narration?: string;
}
