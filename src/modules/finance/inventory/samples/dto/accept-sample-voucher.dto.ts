import { IsArray, IsNumber, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AcceptSampleLineDto {
  /** Zero-based index into voucher.lines array */
  @IsNumber()
  @Min(0)
  lineIdx: number;

  @IsNumber()
  @Min(0)
  acceptedQty: number;
}

export class AcceptSampleVoucherDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AcceptSampleLineDto)
  lines: AcceptSampleLineDto[];
}
