import { SetMetadata } from '@nestjs/common';
import type { PermissionScope } from '../../modules/rbac/permission-registry';

/** Reflector metadata key for `@RequirePermission`. */
export const REQUIRE_PERMISSION_KEY = 'rbac:require-permission';
/** Reflector metadata key for `@AuthenticatedOnly`. */
export const AUTHENTICATED_ONLY_KEY = 'rbac:authenticated-only';

export interface RequiredPermissionMeta {
  path: string;
  scope?: PermissionScope;
}

/**
 * Gate a route on a registry permission path. Fail-closed — once RolesGuard
 * is global (Phase 1) it denies unless the caller's role grants `path`.
 */
export const RequirePermission = (path: string, scope?: PermissionScope) => {
  const meta: RequiredPermissionMeta = { path, scope };
  return SetMetadata(REQUIRE_PERMISSION_KEY, meta);
};

/**
 * Mark a route as reachable by any active workspace member — authenticated,
 * no specific permission required (e.g. /me/permissions, dashboard home,
 * notifications, pending-invites).
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);
