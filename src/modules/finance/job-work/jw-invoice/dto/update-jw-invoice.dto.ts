import { PartialType } from '@nestjs/mapped-types';
import { CreateJwInvoiceDto } from './create-jw-invoice.dto';

export class UpdateJwInvoiceDto extends PartialType(CreateJwInvoiceDto) {}
