/**
 * Domain events emitted by the Workspaces lifecycle.
 *
 * `WorkspacesService` fires {@link WORKSPACE_DELETED} after it soft-deletes a
 * workspace (the owner `remove()` path AND the account-erasure
 * `softDeleteAllOwnedForErasure()` path — one event per workspace). Downstream
 * modules listen to react WITHOUT workspaces taking a dependency on them (no
 * module cycle): the Connect entities module clears the dangling ERP link on
 * every `CompanyPage` / `Storefront` that pointed at the deleted workspace,
 * audits the trust loss, and notifies the entity owner (ADR-0004 / 2026-06-18).
 *
 * Mirrors `auth/events/account-erasure.events.ts`. Fire-and-forget: a slow /
 * failing listener never blocks the workspace soft-delete write.
 */

/** Event name — a workspace was soft-deleted (owner delete or owner erasure). */
export const WORKSPACE_DELETED = 'workspace.deleted';

/**
 * Payload for {@link WORKSPACE_DELETED}. Carries the deleted workspace id + its
 * owner id; a listener re-reads whatever current state it needs so the event
 * stays a thin, stable signal.
 */
export interface WorkspaceDeletedEvent {
  /** The soft-deleted `Workspace` (stringified ObjectId). */
  workspaceId: string;
  /** The workspace owner at delete time (stringified ObjectId). */
  ownerId: string;
}
