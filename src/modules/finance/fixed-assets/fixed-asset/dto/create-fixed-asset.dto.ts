import { IsArray, IsDateString, IsEnum, IsMongoId, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateFixedAssetDto {
  @IsString() @MaxLength(160) name: string;
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() assetCode?: string;       // auto-generated if absent
  @IsMongoId() categoryId: string;
  @IsString() financialYear: string;
  @IsDateString() purchaseDate: string;
  @IsDateString() @IsOptional() installationDate?: string;
  @IsMongoId() @IsOptional() purchaseBillId?: string;
  @IsString() @IsOptional() purchaseBillNumber?: string;
  @IsMongoId() @IsOptional() partyId?: string;
  @IsString() @IsOptional() partyName?: string;
  @IsNumber() @Min(1) costPaise: number;
  @IsNumber() @Min(0) @IsOptional() salvageValuePaise?: number;
  @IsNumber() @Min(1) @IsOptional() usefulLifeYears?: number;
  @IsEnum(['slm', 'wdv']) @IsOptional() depreciationMethod?: 'slm' | 'wdv';
  @IsNumber() @Min(0) @IsOptional() slmRateOverride?: number;
  @IsNumber() @Min(0) @IsOptional() wdvRateOverride?: number;
  @IsEnum(['monthly', 'quarterly']) @IsOptional() depreciationFrequency?: 'monthly' | 'quarterly';
  @IsEnum(['single', 'double', 'triple']) @IsOptional() shiftType?: 'single' | 'double' | 'triple';
  @IsMongoId() @IsOptional() locationId?: string;
  @IsMongoId() @IsOptional() custodianMemberId?: string;
  @IsString() @IsOptional() serialNumber?: string;
  @IsMongoId() @IsOptional() itcScheduleId?: string;
  @IsNumber() @Min(0) @IsOptional() itcClaimedPaise?: number;
  @IsMongoId() @IsOptional() machineId?: string;
  @IsArray() @IsString({ each: true }) @IsOptional() tags?: string[];
  @IsString() @IsOptional() notes?: string;
}
