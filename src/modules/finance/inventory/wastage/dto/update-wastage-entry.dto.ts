import { PartialType } from '@nestjs/mapped-types';
import { CreateWastageEntryDto } from './create-wastage-entry.dto';

export class UpdateWastageEntryDto extends PartialType(CreateWastageEntryDto) {}
