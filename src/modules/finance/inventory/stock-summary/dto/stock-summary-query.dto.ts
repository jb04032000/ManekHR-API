import { Transform } from 'class-transformer';
import { IsBoolean, IsMongoId, IsOptional, IsString } from 'class-validator';

export class StockSummaryQueryDto {
  @IsOptional()
  @IsMongoId()
  godownId?: string; // filter to one godown; omit = all godowns

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  lowStockOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  trackBatchOnly?: boolean;

  @IsOptional()
  @IsString()
  q?: string; // item-name / item-code search
}
