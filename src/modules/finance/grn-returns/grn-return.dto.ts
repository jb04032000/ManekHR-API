import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class GrnReturnLineDto {
  @IsOptional() @IsMongoId() itemId?: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsNumber() @Min(0) qtyReturned?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsInt() @Min(0) ratePaise?: number;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() batchNumber?: string;
  @IsOptional() @IsString() notes?: string;
}

export class GrnReturnTransportDto {
  @IsOptional() @IsString() carrier?: string;
  @IsOptional() @IsString() lrNumber?: string;
  @IsOptional() @IsDateString() dispatchDate?: string;
}

export class CreateGrnReturnDto {
  @IsDateString() voucherDate: string;
  @IsOptional() @IsMongoId() sourceGrnId?: string;
  @IsOptional() @IsMongoId() sourceBillId?: string;
  @IsOptional() @IsMongoId() partyId?: string;
  @IsOptional() @IsString() vendorRmaNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GrnReturnTransportDto)
  transport?: GrnReturnTransportDto;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GrnReturnLineDto)
  lineItems: GrnReturnLineDto[];

  @IsOptional() @IsString() notes?: string;
}

export class UpdateGrnReturnDto {
  @IsOptional() @IsDateString() voucherDate?: string;
  @IsOptional() @IsString() vendorRmaNumber?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => GrnReturnTransportDto)
  transport?: GrnReturnTransportDto;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GrnReturnLineDto)
  lineItems?: GrnReturnLineDto[];
  @IsOptional() @IsString() notes?: string;
}

export class CancelGrnReturnDto {
  @IsString() reason: string;
}

export class ListGrnReturnsQueryDto {
  @IsOptional()
  @IsIn(['draft', 'dispatched', 'confirmed', 'cancelled'])
  state?: string;
  @IsOptional() @IsMongoId() partyId?: string;
  @IsOptional() @IsDateString() fromDate?: string;
  @IsOptional() @IsDateString() toDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsInt() @Min(0) skip?: number;
}
