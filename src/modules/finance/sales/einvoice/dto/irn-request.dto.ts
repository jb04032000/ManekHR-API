import { IsBoolean, IsOptional } from 'class-validator';

export class IrnRequestDto {
  @IsOptional()
  @IsBoolean()
  forceRetry?: boolean; // bypass attempts cap on manual trigger
}
