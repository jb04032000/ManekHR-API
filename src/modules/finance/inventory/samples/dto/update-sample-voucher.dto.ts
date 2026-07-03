import { PartialType } from '@nestjs/mapped-types';
import { CreateSampleVoucherDto } from './create-sample-voucher.dto';

export class UpdateSampleVoucherDto extends PartialType(CreateSampleVoucherDto) {}
