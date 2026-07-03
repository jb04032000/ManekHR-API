import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateLotDto } from './create-lot.dto';

// lotNo is immutable once created — omit from update DTO
export class UpdateLotDto extends PartialType(
  OmitType(CreateLotDto, ['lotNo'] as const),
) {}
