import {
  IsArray,
  IsDate,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateKarigarLinkageDto {
  @IsMongoId()
  sourceVoucherId: string;

  @IsEnum(['job_work_in', 'job_work_out', 'job_work_invoice', 'manufacturing_voucher'])
  sourceVoucherType: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sourceLineIndex?: number;

  @Type(() => Date)
  @IsDate()
  voucherDate: Date;

  @IsArray()
  @IsMongoId({ each: true })
  karigarIds: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsMongoId()
  shiftId?: string;

  @IsOptional()
  @IsMongoId()
  jobWorkLotId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedHours?: number;
}
