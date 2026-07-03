import { IsIn, IsOptional } from 'class-validator';
import { WORK_ORDER_STATUSES, WorkOrderStatus } from '../schemas/work-order.schema';

/**
 * ListWorkOrdersQueryDto — query string for
 * `GET /workspaces/:wsId/machines/work-orders`.
 * `status` is optional; absent ⇒ all non-deleted orders.
 */
export class ListWorkOrdersQueryDto {
  @IsOptional()
  @IsIn(WORK_ORDER_STATUSES)
  status?: WorkOrderStatus;
}
