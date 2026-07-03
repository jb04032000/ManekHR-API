import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { WORK_ORDER_STATUSES, WorkOrderStatus } from '../schemas/work-order.schema';

/**
 * UpdateWorkOrderDto — body for
 * `PATCH /workspaces/:wsId/machines/work-orders/:orderId`.
 * All fields optional; `status` drives the active/completed/archived chips
 * on the web Shop Floor page.
 */
export class UpdateWorkOrderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  partyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  productType?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  qty?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  ratePerUnit?: number;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  colorHex?: string;

  @IsOptional()
  @IsIn(WORK_ORDER_STATUSES)
  status?: WorkOrderStatus;
}
