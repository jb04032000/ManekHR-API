import { PartialType } from '@nestjs/mapped-types';
import { CreateFirmDto } from './create-firm.dto';

export class UpdateFirmDto extends PartialType(CreateFirmDto) {}
