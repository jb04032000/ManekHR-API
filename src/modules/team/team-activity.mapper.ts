import type { AuditEvent } from '../audit/schemas/audit-event.schema';
import { classifyTeamFields, type TeamFieldGroup } from './team-field-groups';

/**
 * Redacted, FE-safe shape of one team activity event (2026-05-22).
 *
 * The raw `AuditEvent` can carry `before`/`after`/`meta` with sensitive VALUES
 * (salary amounts, bank account numbers, PAN/Aadhaar). The activity feed must
 * never expose those — it answers "who did what to whom, when", not "what is
 * the value". This DTO carries only actor, action, target, timestamp, and a
 * fail-closed allowlisted `meta` (at most a coarse field-GROUP label).
 */
export interface ActivityEventDto {
  id: string;
  module: string;
  action: string;
  actor: { id: string; name: string };
  target: { id: string; name: string; type: string } | null;
  at: string; // ISO timestamp
  meta: Record<string, unknown>;
}

type RawEvent = AuditEvent & { _id?: unknown; createdAt?: Date };

/**
 * Build the SAFE meta for a team activity event. Fail-closed: only the keys
 * enumerated per action are emitted; `before`/`after` and every other meta key
 * are dropped. Sensitive VALUES are never returned — for an update we surface
 * at most the coarse field-GROUP labels touched (e.g. "compensation", "bank"),
 * derived from the same `team-field-groups` classifier the write-path uses.
 */
export function safeTeamActivityMeta(
  action: string,
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  switch (action) {
    case 'team.member_updated': {
      const fields = Array.isArray(meta.fieldsChanged) ? (meta.fieldsChanged as string[]) : [];
      const { groups } = classifyTeamFields(fields);
      return { groups: [...groups] as TeamFieldGroup[] };
    }
    case 'team.member_created':
      // salaryType is a CATEGORY ('monthly' | 'hourly'), never an amount.
      return typeof meta.salaryType === 'string' ? { salaryType: meta.salaryType } : {};
    case 'team.access_granted':
      // sendMethod is a channel category ('sms' | 'email' | ...).
      return typeof meta.sendMethod === 'string' ? { sendMethod: meta.sendMethod } : {};
    case 'team.bulk_status_changed':
    case 'team.bulk_archived':
    case 'team.bulk_restored':
      return typeof meta.count === 'number' ? { count: meta.count } : {};
    default:
      return {};
  }
}

/**
 * Map a raw `AuditEvent` to the redacted activity DTO. `targetName` is the
 * caller-resolved current name of the affected member (the audit row stores no
 * target-name snapshot); falls back to "Removed member" when unresolved.
 */
export function toTeamActivityDto(event: RawEvent, targetName?: string): ActivityEventDto {
  const entityId = event.entityId ? String(event.entityId) : '';
  return {
    id: String(event._id),
    module: event.module,
    action: event.action,
    actor: { id: String(event.actorId), name: event.actorNameSnapshot || 'Unknown user' },
    target: entityId
      ? { id: entityId, name: targetName ?? 'Removed member', type: event.entityType }
      : null,
    at: (event.createdAt ?? new Date()).toISOString(),
    meta: safeTeamActivityMeta(event.action, event.meta),
  };
}
