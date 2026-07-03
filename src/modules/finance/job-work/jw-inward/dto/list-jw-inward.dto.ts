import { IsOptional, IsMongoId, IsEnum, IsNumber, IsDate, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListJwInwardDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsEnum(['draft', 'posted', 'closed'])
  status?: 'draft' | 'posted' | 'closed';

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
