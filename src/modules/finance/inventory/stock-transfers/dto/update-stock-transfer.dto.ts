import { PartialType } from '@nestjs/mapped-types';
import { CreateStockTransferDto } from './create-stock-transfer.dto';

export class UpdateStockTransferDto extends PartialType(CreateStockTransferDto) {}
