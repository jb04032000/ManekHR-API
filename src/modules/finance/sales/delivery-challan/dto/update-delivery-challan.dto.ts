import { PartialType } from '@nestjs/mapped-types';
import { CreateDeliveryChallanDto } from './create-delivery-challan.dto';

export class UpdateDeliveryChallanDto extends PartialType(CreateDeliveryChallanDto) {}
