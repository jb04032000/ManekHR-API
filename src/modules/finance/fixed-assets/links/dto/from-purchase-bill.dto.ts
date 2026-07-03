import { IsInt, IsMongoId, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FromPurchaseBillDto {
  @IsMongoId() purchaseBillId: string;
  @Type(() => Number) @IsInt() @Min(0) lineNo: number;
}
