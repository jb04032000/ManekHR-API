import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MACHINE_STATUSES } from '../schemas/machine.schema';

export class MachineAttributesDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  needles?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  heads?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  hoopSizeMm?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxRpm?: number;

  @IsOptional()
  @IsString()
  spec?: string;
}

export class CreateMachineDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9_-]{1,32}$/, {
    message: 'machineCode must be 1-32 alphanumeric / _ / - characters',
  })
  machineCode?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  manufacturer?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsIn([...MACHINE_STATUSES])
  status?: (typeof MACHINE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  floorTag?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MachineAttributesDto)
  attributes?: MachineAttributesDto;

  @IsOptional()
  @IsDateString()
  installedOn?: string;

  @IsOptional()
  @IsDateString()
  lastMaintenanceDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maintenanceIntervalDays?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMachineDto {
  @IsOptional()
  @IsString()
  locationId?: string;

  // ── Phase 25 D-07 — per-machine uptime target % (optional override) ─────
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  uptimeTargetPct?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  manufacturer?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsIn([...MACHINE_STATUSES])
  status?: (typeof MACHINE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  floorTag?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MachineAttributesDto)
  attributes?: MachineAttributesDto;

  @IsOptional()
  @IsDateString()
  installedOn?: string;

  @IsOptional()
  @IsDateString()
  lastMaintenanceDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maintenanceIntervalDays?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
