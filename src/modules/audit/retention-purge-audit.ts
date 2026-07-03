import { CreateAuditEventInput } from './audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/** A per-workspace retention-purge summary, the input to the grievance-trail audit. */
export interface RetentionPurgeAuditInput {
  /** Owning module (salary / attendance / ...). */
  module: AppModule;
  /** System actor id (env.systemUserId) — purges are system-only, never a user. */
  systemUserId: string;
  /** Workspace whose expired rows were purged. */
  workspaceId: string;
  /** Total rows hard-deleted this workspace this run. */
  totalDeleted: number;
  /** Per-collection deleted counts (the record CLASSES that were purged). */
  collections: Record<string, number>;
  /** The retention window (years) applied per class — the legal-basis duration. */
  windowYears: Record<string, number>;
  /** The cutoff date per window (ISO) — proof the window had genuinely elapsed. */
  cutoffs: Record<string, string>;
  /** The legal basis the records were retained under, then erased (e.g. statutory floor). */
  basis: string;
}

/**
 * Phase 7 audit-at-purge (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8). Builds the
 * grievance-trail audit event for one workspace's retention purge, identically
 * shaped across every retention cron, so a DPDP grievance can always show WHAT
 * was purged (class counts), under WHICH basis, and that the window had elapsed
 * (the cutoffs). Pure — the cron logs it best-effort via AuditService.logEvent.
 */
export function buildRetentionPurgeAuditEvent(
  input: RetentionPurgeAuditInput,
): CreateAuditEventInput {
  return {
    workspaceId: input.workspaceId,
    module: input.module,
    entityType: 'retention_purge',
    entityId: input.workspaceId,
    action: 'retention_purged',
    actorId: input.systemUserId,
    meta: {
      totalDeleted: input.totalDeleted,
      collections: input.collections,
      windowYears: input.windowYears,
      cutoffs: input.cutoffs,
      basis: input.basis,
    },
  };
}
