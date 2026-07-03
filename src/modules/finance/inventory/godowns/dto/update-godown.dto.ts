import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateGodownDto } from './create-godown.dto';

export class UpdateGodownDto extends PartialType(CreateGodownDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
