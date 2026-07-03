import {
  IsOptional,
  IsInt,
  IsString,
  Min,
  Max,
  IsIn,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export type SortOrder = 'asc' | 'desc';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000) // Support fetching up to 1000 records for stats/grouping
  limit?: number = 10;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: SortOrder = 'desc';

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  month?: string;

  @IsOptional()
  @IsString()
  year?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['all', 'active', 'inactive', 'offboarding', 'archived'])
  status?: 'all' | 'active' | 'inactive' | 'offboarding' | 'archived';

  @IsOptional()
  @IsIn(['all', 'active', 'invited', 'none'])
  appAccess?: 'all' | 'active' | 'invited' | 'none';

  @IsOptional()
  @Type(() => {
    // Attempt to handle both object and JSON string
    return Object;
  })
  filters?: any;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}
