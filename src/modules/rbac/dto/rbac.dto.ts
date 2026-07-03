import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';

export class PermissionDto {
  @IsEnum(AppModule)
  module: AppModule;

  @IsArray()
  @IsEnum(ModuleAction, { each: true })
  actions: ModuleAction[];

  /**
   * Per-action scope, parallel to `actions`. `'self'` = the role holder acts
   * only on their own records; `'all'` = workspace-wide. Optional — a missing
   * entry is treated as `'self'` (least-privilege) by RolesGuard.
   */
  @IsOptional()
  @IsArray()
  @IsIn(['self', 'all'], { each: true })
  actionScopes?: ('self' | 'all')[];
}

export class GrantedPermissionPathDto {
  @IsString()
  @IsNotEmpty()
  path: string;

  @IsIn(['self', 'all'])
  scope: 'self' | 'all';
}

export class CreateRoleDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionDto)
  permissions: PermissionDto[];

  /**
   * Phase 1c — hierarchical path grants for path-classified modules (Team).
   * Persisted to `Role.permissionPaths`; runs alongside flat `permissions`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrantedPermissionPathDto)
  permissionPaths?: GrantedPermissionPathDto[];
}

export class UpdatePermissionsDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionDto)
  @IsOptional()
  permissions?: PermissionDto[];

  /**
   * Phase 1c — hierarchical path grants for path-classified modules (Team).
   * Persisted to `Role.permissionPaths`; runs alongside flat `permissions`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrantedPermissionPathDto)
  permissionPaths?: GrantedPermissionPathDto[];
}
