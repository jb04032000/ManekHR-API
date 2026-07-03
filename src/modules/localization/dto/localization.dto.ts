import { IsString, IsBoolean, IsOptional, IsNotEmpty, IsArray, IsIn } from 'class-validator';

export class CreateLanguageDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  nativeName: string;

  @IsOptional()
  @IsString()
  example?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(['ltr', 'rtl'])
  direction?: 'ltr' | 'rtl';
}

export class UpdateLanguageDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  nativeName?: string;

  @IsOptional()
  @IsString()
  example?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(['ltr', 'rtl'])
  direction?: 'ltr' | 'rtl';
}

export class UpsertTranslationDto {
  @IsString()
  @IsNotEmpty()
  value: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  screen?: string;

  @IsOptional()
  @IsString()
  feature?: string;

  @IsOptional()
  @IsString()
  componentRef?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class BulkImportDto {
  // JSON object where keys are "namespace.key" or nested object
  translations: Record<string, any>;

  @IsOptional()
  @IsString()
  platform?: string;
}

export class TranslationsIndexQueryDto {
  @IsOptional()
  @IsString()
  langCode?: string;

  @IsOptional()
  @IsString()
  module?: string;

  @IsOptional()
  @IsString()
  screen?: string;

  @IsOptional()
  @IsString()
  feature?: string;
}
