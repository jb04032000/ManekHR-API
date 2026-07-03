import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { allPermissionPaths } from '../../rbac/permission-registry';

/** Every grantable registry leaf path — frozen for DTO `@IsIn` validation. */
const ALL_PERMISSION_PATHS: string[] = [...allPermissionPaths()];

/**
 * POST /workspaces/:wsId/team/:memberId/revoke-access
 *
 * Body is optional — the default is a hard revoke (clears all access fields,
 * adds the linked user to the Redis denylist, and deactivates Sessions for
 * (userId, workspaceId)). `reason` is captured for the audit log only.
 */
export class RevokeAccessDto {
  @IsString() @IsOptional() reason?: string;
  @IsBoolean() @IsOptional() hardRevoke?: boolean;
}

/**
 * POST /workspaces/:wsId/team/:memberId/resend-invite
 *
 * Reuses the same raw token if the existing invite is still within the
 * 7-day expiry window; pass `forceRegenerate: true` to rotate the token.
 * The `sendMethod` mirrors GrantAccessDto so the BE can fan out to email +
 * SMS using the same notification helper. `email` overrides the member's
 * stored email for this send only (no mutation of TeamMember.email).
 */
export class ResendInviteDto {
  @IsIn(['auto', 'link', 'both']) sendMethod: 'auto' | 'link' | 'both';
  @IsEmail() @IsOptional() email?: string;
  @IsBoolean() @IsOptional() forceRegenerate?: boolean;
  /**
   * P1.8-revert.13 (2026-05-14) — per-channel control for resend. When
   * present, overrides the channel mix derived from sendMethod and fires
   * exactly the listed channels. Empty array = rotate token only, no
   * dispatch (the share panel still surfaces the new link).
   *
   *   - 'email'  → email if address available
   *   - 'sms'    → SMS if mobile available
   *   - 'in_app' → in-app notification when the invitee's mobile/email maps
   *                to a User account (warm); silent otherwise
   */
  @IsArray()
  @IsOptional()
  @IsIn(['email', 'sms', 'in_app'], { each: true })
  channels?: ('email' | 'sms' | 'in_app')[];
}

/**
 * PATCH /workspaces/:wsId/team/:memberId/access-role
 *
 * Focused role-change endpoint. Updates BOTH TeamMember.rbacRoleId AND the
 * linked WorkspaceMember.roleId so RolesGuard's role lookup picks up the
 * new role on the next request. Use the generic team update endpoint for
 * directory edits (name / mobile / etc.) — this endpoint is specifically
 * for app-access role rotation.
 */
export class ChangeAccessRoleDto {
  @IsMongoId() rbacRoleId: string;
}

/**
 * Single override row in a SetPermissionOverridesDto payload. `module` must
 * be a known AppModule enum value and `action` must be a known ModuleAction
 * enum value — unknown values are rejected with 400.
 */
class PermissionOverrideItemDto {
  @IsEnum(AppModule, { message: 'Unknown module' })
  module: AppModule;

  @IsEnum(ModuleAction, { message: 'Unknown action' })
  action: ModuleAction;

  @IsBoolean()
  allowed: boolean;

  @IsIn(['self', 'all'])
  @IsOptional()
  scope?: 'self' | 'all';
}

/**
 * Single path-override row in a SetPermissionOverridesDto payload. `path`
 * must be a grantable registry leaf path — unknown paths are rejected 400.
 */
class PathOverrideItemDto {
  @IsIn(ALL_PERMISSION_PATHS, { message: 'Unknown permission path' })
  path: string;

  @IsBoolean()
  allowed: boolean;

  // Optional: a missing scope falls back to 'self' (least-privilege) inside
  // applyPathOverrides — the override matrix always sends an explicit scope, so
  // the fallback is only a safety net for a malformed payload.
  @IsIn(['self', 'all'])
  @IsOptional()
  scope?: 'self' | 'all';
}

/**
 * PUT /workspaces/:wsId/team/:memberId/permission-overrides
 *
 * Replaces the member's full permissionOverrides array. Send an empty array
 * to clear all overrides and fall back to pure role permissions.
 */
export class SetPermissionOverridesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionOverrideItemDto)
  overrides: PermissionOverrideItemDto[];

  /**
   * Phase 1c — path-based overrides for path-classified modules (Team).
   * Optional for backward compatibility: a client sending only `overrides`
   * leaves `permissionPathOverrides` unchanged-to-empty via the service.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PathOverrideItemDto)
  @IsOptional()
  pathOverrides?: PathOverrideItemDto[];
}
