import { describe, it, expect } from 'vitest';
import { buildRetentionPurgeAuditEvent } from '../retention-purge-audit';
import { AppModule } from '../../../common/enums/modules.enum';

/**
 * Phase 7 audit-at-purge (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8): every retention
 * cron must leave a grievance-trail record of WHAT it purged, under WHICH legal
 * basis, and that the window had genuinely elapsed. This pure builder produces
 * that audit event from a per-workspace purge summary so the shape is identical
 * across the salary / attendance / (future) crons.
 */
const SYS = '000000000000000000000000';
const WS = '5f8d04b3b54764421b7156aa';

describe('buildRetentionPurgeAuditEvent', () => {
  it('builds a per-workspace retention-purge audit with class counts, basis and window proof', () => {
    const ev = buildRetentionPurgeAuditEvent({
      module: AppModule.SALARY,
      systemUserId: SYS,
      workspaceId: WS,
      totalDeleted: 8,
      collections: { salary: 3, payment: 5 },
      windowYears: { payroll: 8, wage: 10 },
      cutoffs: { payroll: '2018-06-26T00:00:00.000Z', wage: '2016-06-26T00:00:00.000Z' },
      basis: 'statutory-retention-floor',
    });

    expect(ev.module).toBe(AppModule.SALARY);
    expect(ev.entityType).toBe('retention_purge');
    expect(ev.action).toBe('retention_purged');
    // System-actor, workspace-scoped — the grievance trail is per-workspace per-run.
    expect(ev.actorId).toBe(SYS);
    expect(ev.entityId).toBe(WS);
    expect(ev.workspaceId).toBe(WS);
    expect(ev.meta).toMatchObject({
      totalDeleted: 8,
      collections: { salary: 3, payment: 5 },
      windowYears: { payroll: 8, wage: 10 },
      basis: 'statutory-retention-floor',
    });
    expect(ev.meta?.cutoffs).toEqual({
      payroll: '2018-06-26T00:00:00.000Z',
      wage: '2016-06-26T00:00:00.000Z',
    });
  });
});
