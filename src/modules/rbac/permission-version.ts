import { createHash } from 'crypto';
import type { GrantedPermission } from './permission-matcher';
import type { PermissionScope } from './permission-registry';

interface FlatPermission {
  module: string;
  actions: string[];
  actionScopes?: PermissionScope[];
}

interface PathOverride {
  path: string;
  allowed: boolean;
  scope?: PermissionScope;
}

interface PermissionOverride {
  module: string;
  action: string;
  allowed: boolean;
  scope?: PermissionScope;
}

/**
 * Compute a stable, hash-based version string for a member's effective
 * permission set. Identical inputs → identical hash. Any change to role,
 * path overrides, or flat overrides → new hash.
 *
 * Used as `X-Permission-Version` response header (and as the
 * `permissionVersion` field on /me/permissions) so the FE knows when to
 * invalidate its perm cache without polling.
 *
 * Pure. No DB calls. Caller passes the resolved values.
 *
 * The 16-hex-char slice is collision-safe for this cache-invalidation use
 * case (2^64 space >> concurrent workspace member count).
 */
export function computePermissionVersion(args: {
  roleId?: string | null;
  rolePermissions?: FlatPermission[] | null;
  rolePermissionPaths?: GrantedPermission[] | null;
  memberPermissionOverrides?: PermissionOverride[] | null;
  memberPermissionPathOverrides?: PathOverride[] | null;
}): string {
  const canonical = JSON.stringify({
    roleId: args.roleId ?? null,
    rolePerms: stableSortFlat(args.rolePermissions ?? []),
    rolePaths: stableSortPath(args.rolePermissionPaths ?? []),
    overrides: stableSortOverrides(args.memberPermissionOverrides ?? []),
    pathOverrides: stableSortPathOverrides(args.memberPermissionPathOverrides ?? []),
  });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

// 2026-05-22: every sort comparator coerces its key to a string before
// `localeCompare`. The persisted role / override documents occasionally
// carry rows with undefined `module`, `path`, or `action` fields (legacy
// migrations, partial writes). Calling `.localeCompare` on undefined
// throws a TypeError and crashes `/me/permissions` for the affected
// member - presents as the FE "Couldn't load permissions" screen. Empty
// string is a stable sort key that keeps the hash deterministic across
// runs.
const key = (v: unknown): string => (typeof v === 'string' ? v : '');

// 2026-05-22 (loop fix): every sort function PROJECTS only the canonical
// fields it cares about - never spreads or returns the raw row. This is
// load-bearing for the X-Permission-Version contract: `getMyPermissions`
// (the /me/permissions body) hydrates the role with `.exec()` while the
// `PermissionVersionInterceptor` (the response header) loads it with
// `.lean()`. Spreading a hydrated Mongoose subdoc emits internal props
// (`$__`, `_doc`, getters); spreading a lean POJO emits clean fields.
// JSON.stringify of those two shapes differs, so the body hash and the
// header hash never matched -> the FE saw permanent permission-version
// drift -> invalidate -> refetch -> infinite re-render loop for any
// non-owner member. Projecting fixed keys makes the hash identical
// regardless of how the document was loaded.

function stableSortFlat(rows: FlatPermission[]): Array<{
  module: string;
  actions: string[];
  actionScopes?: Array<PermissionScope | undefined>;
}> {
  return [...rows]
    .map((r) => {
      // Sort actions and scopes together as pairs so the parallel-array
      // correspondence is preserved after sorting (C4 fix - was sorting
      // actions independently, breaking index alignment with actionScopes).
      const pairs = (r.actions ?? []).map((a, i) => ({ a, s: r.actionScopes?.[i] }));
      pairs.sort((x, y) => key(x.a).localeCompare(key(y.a)));
      return {
        module: key(r.module),
        actions: pairs.map((p) => p.a),
        actionScopes: r.actionScopes ? pairs.map((p) => p.s) : undefined,
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module));
}

function stableSortPath(
  rows: GrantedPermission[],
): Array<{ path: string; scope?: PermissionScope }> {
  return [...rows]
    .map((r) => ({ path: key(r.path), scope: (r as { scope?: PermissionScope }).scope }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function stableSortOverrides(
  rows: PermissionOverride[],
): Array<{ module: string; action: string; allowed: boolean; scope?: PermissionScope }> {
  return [...rows]
    .map((r) => ({
      module: key(r.module),
      action: key(r.action),
      allowed: r.allowed,
      scope: r.scope,
    }))
    .sort((a, b) => (a.module + a.action).localeCompare(b.module + b.action));
}

function stableSortPathOverrides(
  rows: PathOverride[],
): Array<{ path: string; allowed: boolean; scope?: PermissionScope }> {
  return [...rows]
    .map((r) => ({ path: key(r.path), allowed: r.allowed, scope: r.scope }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
