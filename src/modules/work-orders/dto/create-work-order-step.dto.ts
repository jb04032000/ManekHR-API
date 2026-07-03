import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { WORK_ORDER_STAGES, WorkOrderStage } from '../schemas/work-order.schema';

/**
 * CreateWorkOrderStepDto — body for
 * `POST /workspaces/:wsId/machines/work-orders/:orderId/steps`.
 * Entries are NEVER created here — they go through the dedicated
 * /entries endpoint. `deps` holds _id strings of sibling steps; existence
 * is service-validated (a brand-new step cannot create a cycle).
 */
export class CreateWorkOrderStepDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsIn(WORK_ORDER_STAGES)
  stage!: WorkOrderStage;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  // Explicit null clears the assignee; absent keeps it unset.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  assigneeId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deps?: string[];

  // PERT three-point estimates — service coerces opt <= likely <= pess.
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  optimisticHrs!: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  likelyHrs!: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  pessimisticHrs!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  wageRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  progress?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  posX?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  posY?: number;
}
