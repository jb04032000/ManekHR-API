import type { PermissionScope } from './permission-registry';

/** A permission grant held by a role / member (effective). */
export interface GrantedPermission {
  path: string;
  scope: PermissionScope;
}

/**
 * Fail-closed permission match. Returns true ONLY when `grants` contains the
 * required path with a satisfying scope. No grant → false (deny by default).
 *
 *  - required.scope undefined → any granted scope satisfies.
 *  - required.scope 'self'    → granted 'self' OR 'all' satisfies.
 *  - required.scope 'all'     → granted scope must be 'all'.
 *
 * A grant with a missing scope falls back to 'self' (least-privilege).
 */
export function pathGrantSatisfies(
  grants: GrantedPermission[],
  required: { path: string; scope?: PermissionScope },
): boolean {
  const grant = grants.find((g) => g.path === required.path);
  if (!grant) return false;
  if (!required.scope) return true;
  const granted: PermissionScope = grant.scope ?? 'self';
  if (required.scope === 'self') return granted === 'self' || granted === 'all';
  return granted === 'all';
}
