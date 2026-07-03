import { PartialType } from '@nestjs/mapped-types';
import { CreateSaleOrderDto } from './create-sale-order.dto';

export class UpdateSaleOrderDto extends PartialType(CreateSaleOrderDto) {}
