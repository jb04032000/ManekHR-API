import { IsDate, IsEnum, IsMongoId, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListJwOutwardDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsEnum(['draft', 'posted', 'cancelled'])
  status?: 'draft' | 'posted' | 'cancelled';

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dateFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dateTo?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pageSize?: number;
}
