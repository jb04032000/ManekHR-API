import { PartialType } from '@nestjs/mapped-types';
import { CreateJwInwardDto } from './create-jw-inward.dto';

export class UpdateJwInwardDto extends PartialType(CreateJwInwardDto) {}
