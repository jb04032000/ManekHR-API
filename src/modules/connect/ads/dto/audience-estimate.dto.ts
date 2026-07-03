import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { TargetingDto } from './targeting.dto';

/**
 * Body for `POST /me/connect/ads/audience-estimate`.
 * Returns a projected audience size for the supplied targeting spec before the
 * advertiser commits budget. Absent targeting = broadest reach estimate.
 */
export class AudienceEstimateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting?: TargetingDto;
}
