import {
  IsOptional,
  IsIn,
  IsDateString,
  IsMongoId,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListExpenseVouchersDto {
  @IsOptional()
  @IsIn(['draft', 'posted', 'cancelled'])
  state?: 'draft' | 'posted' | 'cancelled';

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([10, 25, 50, 100])
  limit?: number;
}
