import { IsArray, IsMongoId, ArrayMinSize } from 'class-validator';

export class ManualMatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsMongoId({ each: true })
  ledgerEntryIds: string[]; // 1+ entries; bulk supported
}

export class BulkMatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsMongoId({ each: true })
  bankStatementRowIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsMongoId({ each: true })
  ledgerEntryIds: string[];
}
