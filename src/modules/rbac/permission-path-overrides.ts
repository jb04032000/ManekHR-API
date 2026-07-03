import type { GrantedPermission } from './permission-matcher';
import type { PermissionScope } from './permission-registry';

/**
 * A per-member path override — force-allow or force-deny a single registry
 * permission path on top of the member's assigned role. Stored on
 * `TeamMember.permissionPathOverrides`. The path-model twin of the legacy
 * flat `PermissionOverride` (`{ module, action, allowed, scope }`).
 */
export interface PathOverride {
  path: string;
  allowed: boolean;
  scope?: PermissionScope;
}

/**
 * Merge per-member PATH overrides onto a role's path grants. Twin of
 * `applyPermissionOverrides` (flat model).
 *
 * Resolution — overrides apply in array order, last write wins per path:
 *   - `allowed: true`  → add / replace the path at `scope ?? 'self'`
 *     (least-privilege default).
 *   - `allowed: false` → remove the path entirely — a force-deny beats a
 *     role-allow, regardless of scope.
 *
 * Divergence from the flat sibling: `applyPermissionOverrides` leaves an
 * existing action's scope untouched when an allow-override omits `scope`;
 * `applyPathOverrides` always writes the scope, so a scope-less allow-
 * override resolves an existing path to `'self'`. Intentional — the
 * path-override matrix always sends an explicit scope, and `?? 'self'` is
 * only a least-privilege fallback for a malformed override.
 *
 * Pure — inputs are not mutated; a new array is returned.
 */
export function applyPathOverrides(
  rolePaths: GrantedPermission[],
  overrides: PathOverride[],
): GrantedPermission[] {
  const out = new Map<string, PermissionScope>();
  for (const grant of rolePaths) out.set(grant.path, grant.scope);
  for (const ov of overrides) {
    if (ov.allowed) out.set(ov.path, ov.scope ?? 'self');
    else out.delete(ov.path);
  }
  return [...out.entries()].map(([path, scope]) => ({ path, scope }));
}
