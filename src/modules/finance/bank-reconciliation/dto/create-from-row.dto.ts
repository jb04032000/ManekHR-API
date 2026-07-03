import { IsString, IsMongoId, IsIn, IsOptional, IsInt, Min } from 'class-validator';

export class CreateFromRowDto {
  @IsIn(['expense', 'journal'])
  entryType: 'expense' | 'journal';

  @IsMongoId()
  coaAccountId: string; // CoA account selected by user

  @IsString()
  coaAccountCode: string; // denormalised

  @IsOptional()
  @IsString()
  narration?: string; // override row narration

  @IsOptional()
  @IsInt()
  @Min(0)
  gstRatePercent?: number; // 0/5/12/18/28; optional
}
