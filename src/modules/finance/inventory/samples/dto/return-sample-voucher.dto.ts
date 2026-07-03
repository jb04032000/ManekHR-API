import { IsArray, IsNumber, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ReturnSampleLineDto {
  /** Zero-based index into voucher.lines array */
  @IsNumber()
  @Min(0)
  lineIdx: number;

  @IsNumber()
  @Min(0)
  returnedQty: number;
}

export class ReturnSampleVoucherDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnSampleLineDto)
  lines: ReturnSampleLineDto[];
}
