import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpsertResourceScopeDto {
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  userId: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  locationIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateResourceScopeDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  locationIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
