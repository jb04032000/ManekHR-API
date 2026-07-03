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
 * UpdateWorkOrderStepDto — body for
 * `PATCH /workspaces/:wsId/machines/work-orders/:orderId/steps/:stepId`.
 * All fields optional. Changing `deps` re-runs full-graph cycle detection
 * (400 WORK_ORDER_STEP_CYCLE on a back edge). posX/posY land here on every
 * Shop Floor canvas drag-end.
 */
export class UpdateWorkOrderStepDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsIn(WORK_ORDER_STAGES)
  stage?: WorkOrderStage;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  // Explicit null clears the assignee.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  assigneeId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deps?: string[];

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  optimisticHrs?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  likelyHrs?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  pessimisticHrs?: number;

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
