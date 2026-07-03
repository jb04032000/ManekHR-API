import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import type { Request } from 'express';
import { isWorkspaceOwner } from '../utils/workspace-ownership.util';
// Side-effect import: registers Express.Request.user + resourceScope so this
// guard's `getRequest<Request>()` returns a typed object instead of `any`.
import '../types/express-request.augmentation';

interface WorkspaceForOwnerCheck {
  ownerId?: mongoose.Types.ObjectId | string;
  /** Soft-delete flag — a deleted workspace is treated like an absent one
   *  (defer to RolesGuard, which 403s it) so its owner is never decorated
   *  with an active resource scope from a stale id. */
  isDeleted?: boolean;
}

/**
 * ResourceScopeGuard — decorates req with the caller's effective row scope.
 *
 * Runs AFTER RolesGuard (which already verified the (module, action)
 * permission) and BEFORE the controller. Owners always bypass.
 *
 * Side effects on `request`:
 *   request.resourceScope = {
 *     hasScope: boolean,     // did the user have an active scope row?
 *     scopedMachineIds: ObjectId[],
 *     scopedLocationIds: ObjectId[],
 *   }
 *
 * Controllers / services read `request.resourceScope` to narrow reads and
 * reject writes outside scope. The guard itself never 403s on scope —
 * authorisation is handled by RolesGuard; scope only filters rows.
 */
@Injectable()
export class ResourceScopeGuard implements CanActivate {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const workspaceIdRaw =
      request.params?.workspaceId ||
      request.params?.wsId ||
      (typeof body.workspaceId === 'string' ? body.workspaceId : undefined) ||
      (typeof query.workspaceId === 'string' ? query.workspaceId : undefined) ||
      request.headers?.['x-workspace-id'];
    const workspaceId = Array.isArray(workspaceIdRaw) ? workspaceIdRaw[0] : workspaceIdRaw;

    // No auth / no workspace — let RolesGuard / JwtAuthGuard handle it.
    if (!user || !workspaceId) return true;

    // Owner bypass — avoid DB calls when possible.
    const workspaceModel = this.moduleRef.get<Model<WorkspaceForOwnerCheck>>(
      getModelToken('Workspace'),
      { strict: false },
    );
    const workspace = await workspaceModel.findById(workspaceId).exec();
    // Absent OR soft-deleted — defer to RolesGuard (which 403s a deleted
    // workspace before this guard would matter for a permission-gated route).
    // Never decorate an owner scope for a hidden workspace.
    if (!workspace || workspace.isDeleted === true) return true;
    if (isWorkspaceOwner(workspace, user.sub)) {
      request.resourceScope = {
        hasScope: false,
        isOwner: true,
        scopedMachineIds: [],
        scopedLocationIds: [],
      };
      return true;
    }

    // Machines/Locations modules removed (2026-07-04) — no scope service can
    // exist; every non-owner caller is unscoped (matches the isActive:false
    // opt-out branch this replaces).
    request.resourceScope = {
      hasScope: false,
      isOwner: false,
      scopedMachineIds: [],
      scopedLocationIds: [],
    };
    return true;
  }
}

/**
 * Helper: resolve the effective machineId filter for a request.
 * Returns undefined when no scope applies (caller must not filter),
 * or an array of ObjectIds when scope is active.
 *
 * Accepts the req decorated by ResourceScopeGuard.
 */
export function getScopedMachineIds(
  request: Pick<Request, 'resourceScope'>,
): mongoose.Types.ObjectId[] | undefined {
  const scope = request?.resourceScope;
  if (!scope || !scope.hasScope) return undefined;
  return scope.scopedMachineIds;
}

export function getScopedLocationIds(
  request: Pick<Request, 'resourceScope'>,
): mongoose.Types.ObjectId[] | undefined {
  const scope = request?.resourceScope;
  if (!scope || !scope.hasScope) return undefined;
  return scope.scopedLocationIds;
}

export function assertMachineInScope(
  request: Pick<Request, 'resourceScope'>,
  machineId: string | mongoose.Types.ObjectId,
): void {
  const ids = getScopedMachineIds(request);
  if (!ids) return; // unscoped
  const target = machineId.toString();
  if (!ids.some((id) => id.toString() === target)) {
    throw new ForbiddenException('Target machine is outside your assigned resource scope.');
  }
}

export function assertLocationInScope(
  request: Pick<Request, 'resourceScope'>,
  locationId: string | mongoose.Types.ObjectId,
): void {
  const ids = getScopedLocationIds(request);
  if (!ids || ids.length === 0) return; // unscoped or scope has no location constraint
  const target = locationId.toString();
  if (!ids.some((id) => id.toString() === target)) {
    throw new ForbiddenException('Target location is outside your assigned resource scope.');
  }
}
