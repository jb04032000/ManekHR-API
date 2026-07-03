import { IsBoolean, IsMongoId, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class ListBomDto {
  @IsOptional()
  @IsMongoId()
  itemId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isDefault?: boolean;
}
