import { IsMongoId, IsOptional, IsString } from 'class-validator';

export class TransferAssetDto {
  /** At least one of locationId or custodianMemberId must be provided. */
  @IsMongoId()
  @IsOptional()
  locationId?: string;

  @IsMongoId()
  @IsOptional()
  custodianMemberId?: string;

  @IsString()
  @IsOptional()
  narration?: string;
}
