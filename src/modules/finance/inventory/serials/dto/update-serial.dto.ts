import { IsEnum, IsMongoId, IsOptional } from 'class-validator';

export class UpdateSerialDto {
  @IsOptional()
  @IsEnum(['in_stock', 'sold', 'sample_out', 'returned', 'scrapped'])
  status?: string;

  @IsOptional()
  @IsMongoId()
  currentGodownId?: string;
}
