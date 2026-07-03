import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DOCUMENT_TYPES } from '../schemas/team-member-document.schema';

export class CreateTeamMemberDocumentDto {
  @IsIn(DOCUMENT_TYPES as unknown as string[])
  type: string;

  /** Required when type === 'other'. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsNumber()
  fileSize?: number;

  @IsOptional()
  @IsString()
  mimeType?: string;
}
