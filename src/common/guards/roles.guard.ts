import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import mongoose, { Model } from 'mongoose';
import type { Request } from 'express';
import { AppModule, ModuleAction } from '../enums/modules.enum';
import { isWorkspaceOwner } from '../utils/workspace-ownership.util';
import { WorkspaceRevocationService } from '../workspace-revocation/workspace-revocation.service';
import { PermissionEventsService } from '../realtime/permission-events.service';
// Side-effect import: registers Express.Request.user / .workspace so this
// guard's `getRequest<Request>()` returns a typed object.
import '../types/express-request.augmentation';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  REQUIRE_PERMISSION_KEY,
  AUTHENTICATED_ONLY_KEY,
  type RequiredPermissionMeta,
} from '../decorators/require-permission.decorator';
import { LEGACY_UNCLASSIFIED_KEY } from '../decorators/legacy-unclassified.decorator';
import { pathGrantSatisfies, type GrantedPermission } from '../../modules/rbac/permission-matcher';
import {
  applyPathOverrides,
  type PathOverride,
} from '../../modules/rbac/permission-path-overrides';
interface WorkspaceForOwnerCheck {
  ownerId?: mongoose.Types.ObjectId | string;
  /** Soft-delete flag (user-side delete = hide + keep). A soft-deleted
   *  workspace must never resolve into an authorization context — it is
   *  treated as absent so every permission-gated route fails closed. */
  isDeleted?: boolean;
}

interface MembershipRow {
  roleId?: mongoose.Types.ObjectId | string | { toString(): string };
  status: string;
}

interface RoleRow {
  permissions: RolePermissionRow[];
  /** Phase 1a hierarchical grants — matched against `@RequirePermission`. */
  permissionPaths?: GrantedPermission[];
}

export const PERMISSIONS_KEY = 'permissions';

/**
 * Scope a permission requirement to the caller's own data (`'self'`) or to
 * any data in the workspace (`'all'`). When omitted, the requirement is
 * scope-agnostic — RolesGuard accepts any granted scope (legacy behaviour,
 * 100% backward-compatible with every existing decorator usage).
 */
export type RequiredScope = 'self' | 'all';

/**
 * Decorator: `@RequirePermissions(AppModule.TEAM, ModuleAction.EDIT)`
 *   — scope-agnostic; matches any granted scope on (module, action).
 *
 * Decorator: `@RequirePermissions(AppModule.ATTENDANCE, ModuleAction.MARK, 'self')`
 *   — scope-aware; granted scope must satisfy `'self'` (granted `'self'`
 *     OR granted `'all'` both pass — `'all'` is a strict superset).
 *
 * Attaches required permission metadata to a route handler. Existing
 * 2-arg decorator calls remain scope-agnostic (match any granted scope);
 * 3-arg calls are enforced by RolesGuard via `permissionsSatisfy`.
 */
export const RequirePermissions = (
  module: AppModule,
  action: ModuleAction,
  scope?: RequiredScope,
) => SetMetadata(PERMISSIONS_KEY, { module, action, scope });

interface RolePermissionRow {
  module: string;
  actions: string[];
  actionScopes?: ('self' | 'all')[];
}

interface RequiredPermission {
  module: string;
  action: string;
  scope?: RequiredScope;
}

/**
 * Per-member permission override row (App Access Management — P3).
 * Stored on TeamMember.permissionOverrides; merged on top of the assigned
 * role's permissions by `applyPermissionOverrides` below.
 */
export interface PermissionOverride {
  module: string;
  action: string;
  allowed: boolean;
  scope?: 'self' | 'all';
}

interface TeamMemberOverrideRow {
  permissionOverrides?: PermissionOverride[];
  permissionPathOverrides?: PathOverride[];
}

/**
 * Merge per-member overrides on top of the assigned role's permissions.
 *
 * Resolution rules:
 *   - `allowed: true`  → add the (module, action) to the role's row,
 *     creating the row if it does not exist. If the action already exists,
 *     update its scope when the override provides one.
 *   - `allowed: false` → remove the (module, action) from the role's row
 *     entirely; the action becomes denied for this member regardless of
 *     what the role grants.
 *
 * Exported for unit testing without mounting the full guard pipeline.
 *
 * NOTE: Returns a shallow-cloned permissions list — the caller's role
 * document is NOT mutated.
 */
export function applyPermissionOverrides(
  rolePerms: RolePermissionRow[],
  overrides: PermissionOverride[],
): RolePermissionRow[] {
  const merged: RolePermissionRow[] = rolePerms.map((p) => ({
    module: p.module,
    actions: [...p.actions],
    actionScopes: p.actionScopes ? [...p.actionScopes] : undefined,
  }));

  for (const ov of overrides) {
    let row = merged.find((p) => p.module === ov.module);
    if (!row) {
      if (!ov.allowed) continue;
      row = { module: ov.module, actions: [], actionScopes: [] };
      merged.push(row);
    }
    if (!row.actionScopes) row.actionScopes = row.actions.map(() => 'self');

    const idx = row.actions.indexOf(ov.action);
    if (ov.allowed) {
      if (idx < 0) {
        row.actions.push(ov.action);
        row.actionScopes.push(ov.scope ?? 'self');
      } else if (ov.scope) {
        row.actionScopes[idx] = ov.scope;
      }
    } else if (idx >= 0) {
      row.actions.splice(idx, 1);
      row.actionScopes.splice(idx, 1);
    }
  }
  return merged;
}

/**
 * Pure permission match — exported for unit testing without mounting the
 * full guard / DI / Mongoose surface.
 *
 * Match rules (Path C plumbing):
 *   - `required.scope === undefined` → matches any granted scope on
 *     (module, action). 100% backward-compat with legacy decorator usage.
 *   - `required.scope === 'self'`     → granted must be `'self'` or `'all'`.
 *   - `required.scope === 'all'`      → granted must be `'all'`.
 *
 * Granted scope is read from the parallel `actionScopes[idx]` array; when
 * absent it defaults to `'self'` — least-privilege / fail-closed. The
 * Access Control Initiative scope-backfill migration writes an explicit
 * scope on every stored grant, so this fallback only guards future grants
 * authored without one.
 */
export function permissionsSatisfy(
  rolePermissions: RolePermissionRow[],
  required: RequiredPermission,
): boolean {
  return rolePermissions.some((p) => {
    if (p.module !== required.module) return false;
    const idx = p.actions.indexOf(required.action);
    if (idx < 0) return false;
    if (!required.scope) return true;
    const grantedScope: RequiredScope = p.actionScopes?.[idx] ?? 'self';
    if (required.scope === 'self') {
      return grantedScope === 'self' || grantedScope === 'all';
    }
    return grantedScope === 'all';
  });
}

/** The caller's resolved authorization context within a workspace. */
type CallerContext =
  | { kind: 'owner' }
  | {
      kind: 'member';
      role: RoleRow;
      overrides: PermissionOverride[];
      pathOverrides: PathOverride[];
    };

/** Cached resolved caller context — see `RolesGuard.callerCache`. */
interface CallerCacheEntry {
  ctx: CallerContext;
  expiresAt: number;
}

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  /**
   * Short-lived caller-context cache (perf pass 2026-07-02). resolveCaller()
   * previously cost 4 sequential Mongo queries on EVERY permission-gated
   * request; this caches the successful result per (workspaceId, userId) —
   * multi-workspace safe by key construction, one entry per workspace.
   *
   * Safety invariants (do not weaken):
   *   - Redis revocation denylist is checked LIVE on every cache hit, so an
   *     offboarded/removed member is denied instantly regardless of the cache
   *     (offboarding always flips the denylist — see resolveCallerUncached).
   *   - Denials are thrown, never cached — a rejected caller re-resolves fresh.
   *   - Role/override edits invalidate the entry immediately via
   *     PermissionEventsService (same signal that drives the SSE UI refresh);
   *     the 30s TTL only bounds staleness for paths without an emit (e.g. a
   *     Role document edited directly in the roles module).
   *   - In-process Map — correct for the current single-instance deploy; under
   *     horizontal scaling invalidation must ride Redis pub/sub (same caveat
   *     already documented on PermissionEventsService).
   */
  private readonly callerCache = new Map<string, CallerCacheEntry>();
  private static readonly CALLER_CACHE_TTL_MS = 30_000;
  // Blunt overflow guard: full clear at cap. Entries are tiny and TTL-bound,
  // so the cap exists only to bound pathological growth, not as an LRU.
  private static readonly CALLER_CACHE_MAX = 10_000;

  constructor(
    private reflector: Reflector,
    private moduleRef: ModuleRef,
    private revocationService: WorkspaceRevocationService,
    permissionEvents: PermissionEventsService,
  ) {
    // Invalidate the exact (user, workspace) entry the moment a role change /
    // override edit is emitted, so cached grants never outlive an edit.
    permissionEvents.onEvent((e) => {
      this.callerCache.delete(`${e.workspaceId}:${e.userId}`);
    });
  }

  /**
   * Dual-mode authorization (RBAC re-architecture Phase 1a, design §12).
   *
   * Marker precedence — exactly one outcome:
   *   1. `@Public`                      → allow (no authentication at all).
   *   2. no `req.user`                  → reject (unauthenticated).
   *   3. `@RequirePermission(path)`     → hierarchical path check against the
   *      caller's effective `permissionPaths`.
   *   4. `@RequirePermissions(mod,act)` → legacy flat check against
   *      `permissions`. Handler-only lookup — exact pre-re-architecture
   *      behaviour.
   *   5. `@AuthenticatedOnly` /
   *      `@LegacyUnclassified`          → allow (an authenticated user is
   *      sufficient; no specific permission, no workspace context).
   *   6. no marker                      → deny (fail-closed).
   *
   * `RolesGuard` is a global `APP_GUARD`, registered after JwtAuthGuard →
   * PinUnlockGuard → PlatformAccessGuard so `req.user` is populated. Every
   * route must carry exactly one marker; the codemod
   * (`scripts/tag-legacy-unclassified.ts`) guarantees that for every existing
   * route, so step 6 is a safety net — a new route shipped without a marker
   * fails closed and is logged.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    // 1. @Public — no authentication required (login, OTP, webhooks).
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    // 2. Unauthenticated — reject. JwtAuthGuard normally rejects first; this
    //    is defence-in-depth for any route reaching RolesGuard without a user.
    if (!user) {
      return false;
    }

    // A real permission marker is resolved + enforced before the catch-all
    // markers below, so it always wins if markers somehow coexist on a route.
    // Legacy `@RequirePermissions` stays a handler-only lookup — exact
    // pre-re-architecture behaviour, no new class-level resolution.
    const requirePath = this.reflector.getAllAndOverride<RequiredPermissionMeta | undefined>(
      REQUIRE_PERMISSION_KEY,
      targets,
    );
    const requireLegacy = this.reflector.get<RequiredPermission | undefined>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );

    if (requirePath || requireLegacy) {
      const workspaceId = this.resolveWorkspaceId(request);
      if (!workspaceId) {
        throw new ForbiddenException('Workspace context required for this operation');
      }

      const caller = await this.resolveCaller(workspaceId, user.sub);
      request.workspace = { id: workspaceId };

      // Owner — implicit full access (verified-correct, audit §4).
      if (caller.kind === 'owner') {
        return true;
      }

      // 3. @RequirePermission — hierarchical path check.
      if (requirePath) {
        const grantedPaths = applyPathOverrides(
          caller.role.permissionPaths ?? [],
          caller.pathOverrides,
        );
        if (!pathGrantSatisfies(grantedPaths, requirePath)) {
          this.deny(request, `path ${requirePath.path}`);
        }
        return true;
      }

      // 4. @RequirePermissions — legacy flat check.
      if (requireLegacy) {
        const effectivePermissions = applyPermissionOverrides(
          caller.role.permissions,
          caller.overrides,
        );
        if (!permissionsSatisfy(effectivePermissions, requireLegacy)) {
          this.deny(request, `${requireLegacy.module}:${requireLegacy.action}`);
        }
        return true;
      }
    }

    // 5. @AuthenticatedOnly / @LegacyUnclassified — an authenticated user is
    //    sufficient; no specific permission, no workspace context required.
    if (
      this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(LEGACY_UNCLASSIFIED_KEY, targets)
    ) {
      return true;
    }

    // 6. No RBAC marker — deny-by-default. The codemod (task 8) classified
    //    every existing route; reaching here means a new route shipped
    //    without a marker — fail closed + log loudly so it is caught.
    this.deny(request, 'an RBAC marker (unclassified route)');
  }

  /** Resolve the workspace id from route params / body / query / header. */
  private resolveWorkspaceId(request: Request): string | undefined {
    // Support :workspaceId / :wsId / :id (workspaces controller convention)
    // route param patterns. Falls back through body / query / x-workspace-id
    // header for non-RESTful clients.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const raw =
      request.params.workspaceId ||
      request.params.wsId ||
      request.params.id ||
      (typeof body.workspaceId === 'string' ? body.workspaceId : undefined) ||
      (typeof query.workspaceId === 'string' ? query.workspaceId : undefined) ||
      request.headers['x-workspace-id'];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /**
   * Resolve the caller's authorization context in a workspace — the lookup
   * chain shared by the path-based and legacy permission checks: owner bypass
   * → revocation denylist → active membership → assigned role → per-member
   * overrides. Throws `ForbiddenException` for a non-member / revoked /
   * role-less caller. Models are resolved lazily to avoid module-level DI
   * ordering issues.
   */
  private async resolveCaller(workspaceId: string, userId: string): Promise<CallerContext> {
    const cacheKey = `${workspaceId}:${userId}`;
    const hit = this.callerCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      // Revocation stays LIVE on every hit (cheap Redis GET) — the cache can
      // never extend access for a removed/offboarded member.
      if (await this.revocationService.isRevoked(workspaceId, userId)) {
        this.callerCache.delete(cacheKey);
        throw new ForbiddenException('Your access to this workspace was revoked');
      }
      return hit.ctx;
    }

    const ctx = await this.resolveCallerUncached(workspaceId, userId);
    // Only successful resolutions reach here (denials throw above/inside).
    if (this.callerCache.size >= RolesGuard.CALLER_CACHE_MAX) {
      this.callerCache.clear();
    }
    this.callerCache.set(cacheKey, {
      ctx,
      expiresAt: Date.now() + RolesGuard.CALLER_CACHE_TTL_MS,
    });
    return ctx;
  }

  private async resolveCallerUncached(workspaceId: string, userId: string): Promise<CallerContext> {
    const workspaceModel = this.moduleRef.get<Model<WorkspaceForOwnerCheck>>(
      getModelToken('Workspace'),
      { strict: false },
    );
    const memberModel = this.moduleRef.get<Model<MembershipRow>>(getModelToken('WorkspaceMember'), {
      strict: false,
    });
    const roleModel = this.moduleRef.get<Model<RoleRow>>(getModelToken('Role'), {
      strict: false,
    });

    const workspace = await workspaceModel.findById(workspaceId).exec();
    if (!workspace) {
      throw new ForbiddenException('Workspace not found');
    }

    // Soft-deleted workspace (user-side delete) — treat as absent so a stale
    // workspace id can never resolve into an owner / member authorization
    // context. Throws BEFORE the owner short-circuit, so even the owner is
    // denied on a hidden workspace. Same message as the not-found case to
    // avoid leaking the workspace's prior existence. Admin / recovery tooling
    // reads the model directly and is unaffected.
    if (workspace.isDeleted === true) {
      throw new ForbiddenException('Workspace not found');
    }

    // Owner — workspace.ownerId === userId — implicit full access.
    if (isWorkspaceOwner(workspace, userId)) {
      return { kind: 'owner' };
    }

    // Wave 2 — revocation denylist (defence-in-depth alongside the
    // status='active' membership filter below). Cheap Redis GET.
    if (await this.revocationService.isRevoked(workspaceId, userId)) {
      throw new ForbiddenException('Your access to this workspace was revoked');
    }

    // REMOVED-MEMBER SECURITY GUARANTEE (RBAC-hardening Pillar 1):
    // membership is filtered to `status: 'active'`. An offboarded/removed member
    // (WorkspaceMember.status === 'removed') is NOT found here and fails closed
    // BELOW. The per-member override merge (applyPermissionOverrides /
    // applyPathOverrides further down) is reached ONLY after this active-member
    // lookup succeeds, so leftover `permissionOverrides` /
    // `permissionPathOverrides` rows on a removed member can NEVER resurrect
    // access — they are inert the instant the member leaves. The retention cron
    // clears those now-orphaned arrays after the keep window; even before it
    // runs, they grant zero effective access. (Defence in depth: the offboard
    // flow also flips the Redis revocation denylist (checked above) and nulls
    // TeamMember.linkedUserId + sets isDeleted, so the override lookup — keyed
    // on linkedUserId + isDeleted:false — would miss too.)
    const member = await memberModel
      .findOne({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        userId: new mongoose.Types.ObjectId(userId),
        status: 'active',
      })
      .exec();
    if (!member) {
      this.logger.warn(`Denied — not a member of workspace ${workspaceId} (user ${userId})`);
      throw new ForbiddenException('You are not a member of this workspace');
    }
    if (!member.roleId) {
      this.logger.warn(`Denied — no role assigned in workspace ${workspaceId} (user ${userId})`);
      throw new ForbiddenException('You do not have permission for this action');
    }

    // Role fetch and per-member override fetch are independent of each other
    // (both only need ids already in hand), so run them in parallel — one DB
    // round-trip of latency instead of two (perf pass 2026-07-02).
    //
    // Per-member overrides (App Access Management — P3) force-allow / -deny
    // individual grants on top of the role bundle. A missing TeamMember row
    // (collaborator invites without a directory record, soft-deleted entries)
    // falls through to pure role grants; so does a model-not-registered /
    // transient DB error — the role check stays authoritative.
    const overridesPromise: Promise<TeamMemberOverrideRow | null> = (async () => {
      try {
        const teamMemberModel = this.moduleRef.get<Model<TeamMemberOverrideRow>>(
          getModelToken('TeamMember'),
          { strict: false },
        );
        return await teamMemberModel
          .findOne({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            linkedUserId: new mongoose.Types.ObjectId(userId),
            isDeleted: false,
          })
          .select('permissionOverrides permissionPathOverrides')
          .lean()
          .exec();
      } catch {
        return null;
      }
    })();

    const [role, teamMember] = await Promise.all([
      roleModel.findOne({ _id: new mongoose.Types.ObjectId(member.roleId.toString()) }).exec(),
      overridesPromise,
    ]);
    if (!role) {
      this.logger.warn(`Denied — assigned role missing in workspace ${workspaceId}`);
      throw new ForbiddenException('Your assigned role no longer exists');
    }
    const overrides: PermissionOverride[] = teamMember?.permissionOverrides ?? [];
    const pathOverrides: PathOverride[] = teamMember?.permissionPathOverrides ?? [];

    return { kind: 'member', role, overrides, pathOverrides };
  }

  /** Log + throw a uniform 403 for a failed permission check. */
  private deny(request: Request, missing: string): never {
    this.logger.warn(`Denied ${request.method} ${request.url} — missing ${missing}`);
    throw new ForbiddenException('You do not have permission for this action');
  }
}
