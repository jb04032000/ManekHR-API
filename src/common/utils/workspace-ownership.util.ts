import { Types } from 'mongoose';

type OwnerIdLike = string | Types.ObjectId | { toString(): string } | null | undefined;
type UserIdLike = string | Types.ObjectId | { toString(): string } | null | undefined;

/**
 * Returns true when the supplied user is the owner of the supplied workspace.
 *
 * Centralises the literal `workspace.ownerId.toString() === userId` check
 * that was scattered across guards (RolesGuard, ResourceScopeGuard) and
 * services (maintenance.controller, firms.controller, workspaces.service).
 *
 * Pure function: caller passes the already-loaded workspace doc to avoid a
 * redundant DB round-trip. For "I have only the workspaceId" callers, use
 * `isWorkspaceOwnerById(workspaceModel, workspaceId, userId)` below.
 */
export function isWorkspaceOwner(
  workspace: { ownerId?: OwnerIdLike } | null | undefined,
  userId: UserIdLike,
): boolean {
  if (!workspace || workspace.ownerId == null || userId == null) return false;
  return workspace.ownerId.toString() === userId.toString();
}

/**
 * DB-bound variant for callers that hold only the workspaceId.
 * Returns false when the workspace is not found (matches the previous
 * behaviour of literal-check callers that fell through to a guard 403).
 */
export async function isWorkspaceOwnerById(
  workspaceModel: {
    findById(id: string | Types.ObjectId): { exec(): Promise<{ ownerId?: OwnerIdLike } | null> };
  },
  workspaceId: string | Types.ObjectId,
  userId: UserIdLike,
): Promise<boolean> {
  if (workspaceId == null || userId == null) return false;
  const workspace = await workspaceModel.findById(workspaceId).exec();
  return isWorkspaceOwner(workspace, userId);
}
