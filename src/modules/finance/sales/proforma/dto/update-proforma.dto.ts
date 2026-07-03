import { PartialType } from '@nestjs/mapped-types';
import { CreateProformaDto } from './create-proforma.dto';

export class UpdateProformaDto extends PartialType(CreateProformaDto) {}
