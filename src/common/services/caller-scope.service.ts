import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { isWorkspaceOwner } from '../utils/workspace-ownership.util';
import { applyPermissionOverrides, type PermissionOverride } from '../guards/roles.guard';
import { pathGrantSatisfies, type GrantedPermission } from '../../modules/rbac/permission-matcher';
import {
  applyPathOverrides,
  type PathOverride,
} from '../../modules/rbac/permission-path-overrides';
import type { PermissionScope } from '../../modules/rbac/permission-registry';

/**
 * Role Taxonomy P1 (2026-05-15) — caller-scope resolver.
 *
 * `RolesGuard` admits or denies a request; it does NOT tell the service
 * layer *which* scope the caller holds. A route decorated
 * `@RequirePermissions(ATTENDANCE, VIEW, 'self')` admits both `self`- and
 * `all`-scoped callers (`all` is a superset). The service still has to
 * know which one to decide whether to filter results to the caller's own
 * records.
 *
 * This service resolves the caller's *effective* permission scope for a
 * given (module, action), reusing the exact same dynamic-RBAC machinery
 * the guard uses — owner bypass, role lookup, and the guard's exported
 * `applyPermissionOverrides` merge. Nothing here is hardcoded: scope comes
 * straight from `Role.permissions[].actionScopes[]` + per-member overrides.
 *
 * Usage in a service:
 *   const ctx = await callerScope.resolve(workspaceId, userId);
 *   const scope = callerScope.effectiveScope(ctx, 'attendance', 'view');
 *   if (scope === 'self' && ctx.teamMemberId) {
 *     filter.teamMemberId = new Types.ObjectId(ctx.teamMemberId);
 *   }
 *
 * Models are resolved lazily via `ModuleRef` (same pattern as
 * `RolesGuard`) so this service carries no Mongoose import-graph weight
 * and can live in a `@Global()` module without per-feature wiring.
 */

interface RolePermissionRow {
  module: string;
  actions: string[];
  actionScopes?: ('self' | 'all')[];
}

interface WorkspaceForOwnerCheck {
  ownerId?: mongoose.Types.ObjectId | string;
}

interface MembershipRow {
  roleId?: mongoose.Types.ObjectId | string | { toString(): string } | null;
  status: string;
}

interface RoleRow {
  permissions: RolePermissionRow[];
  /** Hierarchy / SoD flag — `'block'` means a non-owner holding this role
   *  cannot edit their own profile/admin record. Absent on legacy roles
   *  authored before the field existed → treated as `'allow'`. */
  selfProfileEdit?: SelfProfileEdit;
  /** Phase 1a hierarchical grants — matched by `hasPath` for service-layer
   *  field-group gating, exactly as `RolesGuard` matches `@RequirePermission`. */
  permissionPaths?: GrantedPermission[];
}

interface TeamMemberRow {
  _id: mongoose.Types.ObjectId;
  permissionOverrides?: PermissionOverride[];
  permissionPathOverrides?: PathOverride[];
}

/**
 * Resolved caller context for a single workspace. Build once per request
 * (cheap — 3-4 indexed point lookups) and reuse for every scope check.
 */
export interface CallerScopeContext {
  /** Workspace owner — implicit `all` scope on everything. */
  isOwner: boolean;
  /** The caller's own `TeamMember._id` (string) — the anchor for
   *  `self`-scope filtering. Null when the caller has no directory row
   *  (collaborator-only invite, or owner who never seeded themselves). */
  teamMemberId: string | null;
  /** Effective permissions = assigned role + per-member overrides. */
  permissions: RolePermissionRow[];
  /** Effective hierarchical path grants = role `permissionPaths` with the
   *  per-member overrides projected on top (`applyPathOverrides`). The
   *  path-model analogue of `permissions`; consumed by `hasPath` and
   *  `effectivePathScope`. Owner and role-less callers resolve to `[]` —
   *  both `hasPath` and `effectivePathScope` short-circuit owners before
   *  consulting this array. */
  permissionPaths: GrantedPermission[];
}

export type EffectiveScope = 'self' | 'all' | null;
export type SelfProfileEdit = 'allow' | 'block';

@Injectable()
export class CallerScopeService {
  constructor(private readonly moduleRef: ModuleRef) {}

  private model<T>(name: string): Model<T> {
    return this.moduleRef.get<Model<T>>(getModelToken(name), { strict: false });
  }

  /**
   * Resolve the caller's scope context for a workspace. Mirrors the
   * `RolesGuard` lookup chain exactly — owner bypass → membership → role
   * → override merge — so service-layer scoping can never diverge from
   * what the guard admitted.
   */
  async resolve(workspaceId: string, userId: string): Promise<CallerScopeContext> {
    const wsOid = new mongoose.Types.ObjectId(workspaceId);
    const userOid = new mongoose.Types.ObjectId(userId);

    const workspaceModel = this.model<WorkspaceForOwnerCheck>('Workspace');
    // Exclude soft-deleted workspaces (user-side delete = hide + keep). A
    // deleted workspace resolves to `null` here, so the owner short-circuit
    // below is skipped and the caller falls through to the membership lookup —
    // fail-closed: no grants, every effective scope is `null`. Mirrors the
    // `RolesGuard` deny on a deleted workspace (defence in depth).
    const workspace = await workspaceModel
      .findOne({ _id: wsOid, isDeleted: { $ne: true } })
      .lean()
      .exec();

    // Resolve the caller's own TeamMember row up front — needed both for
    // `self`-scope filtering and for the override merge. The guard keys
    // TeamMember by `linkedUserId`; we match it for consistency.
    const teamMemberModel = this.model<TeamMemberRow>('TeamMember');
    const teamMember = await teamMemberModel
      .findOne({ workspaceId: wsOid, linkedUserId: userOid, isDeleted: false })
      .select('_id permissionOverrides permissionPathOverrides')
      .lean()
      .exec();
    const teamMemberId = teamMember?._id ? String(teamMember._id) : null;

    if (workspace && isWorkspaceOwner(workspace, userId)) {
      return {
        isOwner: true,
        teamMemberId,
        permissions: [],
        permissionPaths: [],
      };
    }

    // REMOVED-MEMBER SECURITY GUARANTEE (RBAC-hardening Pillar 1) — mirrors
    // RolesGuard.resolveCaller: membership is filtered to `status: 'active'`. A
    // removed member (status === 'removed') resolves to `null` here → empty
    // permissions + permissionPaths below → every effectiveScope/hasPath returns
    // null/false (deny / empty result). The per-member override merge
    // (applyPermissionOverrides / applyPathOverrides) runs ONLY on the success
    // path after an active membership + role are found, so leftover override rows
    // on a removed member can never grant residual scope. They are inert until
    // the retention cron clears them.
    const memberModel = this.model<MembershipRow>('WorkspaceMember');
    const membership = await memberModel
      .findOne({ workspaceId: wsOid, userId: userOid, status: 'active' })
      .lean()
      .exec();

    if (!membership?.roleId) {
      return {
        isOwner: false,
        teamMemberId,
        permissions: [],
        permissionPaths: [],
      };
    }

    const roleModel = this.model<RoleRow>('Role');
    const role = await roleModel
      .findById(new mongoose.Types.ObjectId(String(membership.roleId)))
      .lean()
      .exec();

    if (!role) {
      return {
        isOwner: false,
        teamMemberId,
        permissions: [],
        permissionPaths: [],
      };
    }

    const overrides = teamMember?.permissionOverrides ?? [];
    const permissions =
      overrides.length > 0
        ? applyPermissionOverrides(role.permissions, overrides)
        : role.permissions;

    return {
      isOwner: false,
      teamMemberId,
      permissions,
      permissionPaths: applyPathOverrides(
        role.permissionPaths ?? [],
        teamMember?.permissionPathOverrides ?? [],
      ),
    };
  }

  /**
   * The caller's effective scope on a (module, action):
   *   - owner               → `'all'`
   *   - granted with scope   → that scope (`actionScopes[idx]`, default `'self'`)
   *   - not granted          → `null`
   *
   * `null` means the caller has no grant at all. For a route the guard
   * already admitted this should not happen — treat `null` defensively
   * (deny / empty result) at the call site.
   */
  effectiveScope(ctx: CallerScopeContext, module: string, action: string): EffectiveScope {
    if (ctx.isOwner) return 'all';
    for (const p of ctx.permissions) {
      if (p.module !== module) continue;
      const idx = p.actions.indexOf(action);
      if (idx < 0) return null;
      return p.actionScopes?.[idx] ?? 'self';
    }
    return null;
  }

  /**
   * Convenience for read queries: returns the `teamMemberId` value to
   * AND into a Mongo filter when the caller is `self`-scoped, or `null`
   * when the caller is `all`-scoped (no narrowing needed).
   *
   * Throws nothing — a `self`-scoped caller with no `teamMemberId`
   * (no directory row) yields an impossible filter so they see nothing,
   * which is the correct fail-closed behaviour for self-scope.
   */
  selfFilterValue(
    ctx: CallerScopeContext,
    module: string,
    action: string,
  ): mongoose.Types.ObjectId | 'no-self-anchor' | null {
    const scope = this.effectiveScope(ctx, module, action);
    if (scope !== 'self') return null;
    if (!ctx.teamMemberId) return 'no-self-anchor';
    return new mongoose.Types.ObjectId(ctx.teamMemberId);
  }

  /**
   * Hierarchical-path permission check for the service layer — the path-grant
   * analogue of `effectiveScope`. Mirrors `RolesGuard`'s `@RequirePermission`
   * matching exactly (`pathGrantSatisfies` over the override-merged
   * `permissionPaths`) so service-layer field-group gating can never diverge
   * from what the guard admitted. Owner → always true.
   *
   *  - `scope` omitted → any granted scope on `path` satisfies.
   *  - `scope` `'self'` → granted `'self'` OR `'all'` satisfies.
   *  - `scope` `'all'`  → granted scope must be `'all'`.
   */
  hasPath(ctx: CallerScopeContext, path: string, scope?: PermissionScope): boolean {
    if (ctx.isOwner) return true;
    return pathGrantSatisfies(ctx.permissionPaths, { path, scope });
  }

  /**
   * The caller's effective scope on a registry path — the path-model twin of
   * `effectiveScope`. Owner → `'all'`; a held path → its granted scope;
   * unheld → `null` (deny / empty-result at the call site).
   *
   * `applyPathOverrides` (called in `resolve`) deduplicates entries by path
   * using a `Map`, so at most one grant per path ever exists in
   * `ctx.permissionPaths` and the `find` here is unambiguous.
   *
   * Callers needing a *satisfiability* check — where a `self` requirement is
   * satisfied by an `all` grant — should use `hasPath(ctx, path, 'self')`
   * rather than comparing `effectivePathScope(ctx, path) === 'self'` directly,
   * since the latter would incorrectly reject `all`-scoped callers.
   */
  effectivePathScope(ctx: CallerScopeContext, path: string): EffectiveScope {
    if (ctx.isOwner) return 'all';
    const grant = ctx.permissionPaths.find((g) => g.path === path);
    return grant ? grant.scope : null;
  }

  /**
   * Mongo self-narrowing value for a path-gated list query — the path-model
   * twin of `selfFilterValue`. Returns the caller's `teamMemberId` when the
   * path is `self`-scoped, `'no-self-anchor'` when self-scoped without a
   * directory row (→ impossible filter, fail-closed), or `null` when
   * `all`-scoped / owner (no narrowing).
   */
  selfPathFilterValue(
    ctx: CallerScopeContext,
    path: string,
  ): mongoose.Types.ObjectId | 'no-self-anchor' | null {
    const scope = this.effectivePathScope(ctx, path);
    if (scope !== 'self') return null;
    if (!ctx.teamMemberId) return 'no-self-anchor';
    return new mongoose.Types.ObjectId(ctx.teamMemberId);
  }
}
