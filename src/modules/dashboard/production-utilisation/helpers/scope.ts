import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { getScopedMachineIds } from '../../../../common/guards/resource-scope.guard';

/**
 * Phase 25 Plan 04 — ResourceScope extraction + defence-in-depth assertions.
 *
 * `extractScope(req)` normalises the two paths (admin / scoped) into one
 * shape AND emits a `scopeFingerprint` for the cache key (Pitfall 7 — the
 * cache MUST distinguish admin vs scoped vs different scoped sets, or
 * results leak across users).
 *
 * `assertWorkspaceMachines()` is defence-in-depth (D-16): even though
 * ResourceScopeGuard already runs before the controller, the service layer
 * re-asserts that any client-supplied machineIds (a) belong to the active
 * workspace and (b) are inside the user's scope when one is active. This
 * blocks tenant-leak attempts via crafted query strings.
 */

export interface ExtractedScope {
  /** undefined = admin / unscoped — caller must NOT add a scope $in clause. */
  scopedMachineIds?: Types.ObjectId[];
  /** 'admin' for unscoped, comma-joined sorted hex for scoped. Goes into cache key. */
  scopeFingerprint: string;
  isOwner: boolean;
}

export function extractScope(req: any): ExtractedScope {
  const scopedRaw = getScopedMachineIds(req);
  const isOwner = !!req?.resourceScope?.isOwner;
  if (!scopedRaw || scopedRaw.length === 0) {
    return {
      scopedMachineIds: undefined,
      scopeFingerprint: 'admin',
      isOwner,
    };
  }
  const ids = scopedRaw.map(
    (id) => new Types.ObjectId(String(id)),
  );
  const sortedHex = ids.map((i) => i.toHexString()).sort();
  return {
    scopedMachineIds: ids,
    scopeFingerprint: sortedHex.join(','),
    isOwner: false,
  };
}

/**
 * Defence-in-depth: verify every requested machineId belongs to the active
 * workspace AND (when scope is active) lies inside the caller's scoped set.
 *
 * Throws:
 *   - 400 INVALID_MACHINE_ID    if any id is not in the workspace
 *   - 403 MACHINE_OUT_OF_SCOPE  if any id is outside the caller's scope
 *
 * No-op when `requestedIds` is empty / undefined (filter not provided).
 */
export async function assertWorkspaceMachines(
  machineModel: Model<any>,
  requestedIds: string[] | undefined,
  workspaceId: string,
  scopedMachineIds?: Types.ObjectId[],
): Promise<void> {
  if (!requestedIds || requestedIds.length === 0) return;
  const wsObj = new Types.ObjectId(workspaceId);
  const reqObjs = requestedIds.map((id) => new Types.ObjectId(id));
  const count = await machineModel.countDocuments({
    _id: { $in: reqObjs },
    workspaceId: wsObj,
    isDeleted: false,
  });
  if (count !== reqObjs.length) {
    throw new BadRequestException({
      code: 'INVALID_MACHINE_ID',
      message: 'One or more machineIds do not belong to this workspace',
    });
  }
  if (scopedMachineIds && scopedMachineIds.length > 0) {
    const scopedHex = new Set(scopedMachineIds.map((i) => i.toHexString()));
    for (const id of reqObjs) {
      if (!scopedHex.has(id.toHexString())) {
        throw new ForbiddenException({
          code: 'MACHINE_OUT_OF_SCOPE',
          message: 'Requested machine is outside your assigned resource scope',
        });
      }
    }
  }
}
