import { PartialType } from '@nestjs/mapped-types';
import { CreateJwOutwardDto } from './create-jw-outward.dto';

export class UpdateJwOutwardDto extends PartialType(CreateJwOutwardDto) {}
