import { describe, it, expect } from 'vitest';
import { accountantGrantsFromInvite } from '../accountant-access';
import type { PermissionModuleDef } from '../../../rbac/permission-registry';

// A compact registry covering every classification branch: read leaves, write
// leaves (create/edit/post/record), destructive/admin leaves (delete/send/
// manage), a sensitive node, and modules outside finance.
const REGISTRY: PermissionModuleDef[] = [
  {
    module: 'finance',
    labelKey: 'm.finance',
    features: [
      {
        key: 'invoice',
        labelKey: 'f.invoice',
        actions: [
          { action: 'view', scoped: true },
          { action: 'create', scoped: true },
          { action: 'edit', scoped: true },
          { action: 'post', scoped: true },
          { action: 'delete', scoped: true },
          { action: 'send', scoped: true },
        ],
      },
      { key: 'payment', labelKey: 'f.payment', actions: [{ action: 'record', scoped: true }] },
      { key: 'report', labelKey: 'f.report', actions: [{ action: 'view', scoped: false }] },
      { key: 'gst', labelKey: 'f.gst', actions: [{ action: 'manage', scoped: false }] },
      { key: 'settings', labelKey: 'f.settings', actions: [{ action: 'manage', scoped: false }] },
    ],
  },
  {
    module: 'team',
    labelKey: 'm.team',
    features: [
      { key: 'directory', labelKey: 't.dir', actions: [{ action: 'view', scoped: true }] },
      {
        key: 'member',
        labelKey: 't.member',
        actions: [
          { action: 'create', scoped: false },
          { action: 'delete', scoped: false },
        ],
      },
      {
        key: 'profile',
        labelKey: 't.profile',
        children: [
          {
            key: 'bank',
            labelKey: 't.bank',
            sensitive: true,
            actions: [{ action: 'view', scoped: true }],
          },
          { key: 'personal', labelKey: 't.personal', actions: [{ action: 'view', scoped: true }] },
        ],
      },
    ],
  },
  {
    module: 'salary',
    labelKey: 'm.salary',
    features: [
      { key: 'payslip', labelKey: 's.payslip', actions: [{ action: 'view', scoped: true }] },
      { key: 'run', labelKey: 's.run', actions: [{ action: 'create', scoped: false }] },
    ],
  },
];

const paths = (grants: { path: string }[]) => grants.map((g) => g.path).sort();

describe('accountantGrantsFromInvite - coarse module access -> explicit leaf grants', () => {
  it('read_only + finance:read grants only finance read leaves (workspace-wide), never writes', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'read_only', modulePermissions: [{ module: 'finance', access: 'read' }] },
      REGISTRY,
    );
    expect(paths(grants)).toEqual(['finance.invoice.view', 'finance.report.view']);
    expect(grants.every((g) => g.scope === 'all')).toBe(true);
  });

  it('read_only caps writes even when a module grants write access', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'read_only', modulePermissions: [{ module: 'finance', access: 'write' }] },
      REGISTRY,
    );
    expect(paths(grants)).toEqual(['finance.invoice.view', 'finance.report.view']);
  });

  it('adjusting_entry + finance:write adds bookkeeping writes (create/edit/post/record) but never delete/send/manage', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'adjusting_entry', modulePermissions: [{ module: 'finance', access: 'write' }] },
      REGISTRY,
    );
    expect(paths(grants)).toEqual([
      'finance.invoice.create',
      'finance.invoice.edit',
      'finance.invoice.post',
      'finance.invoice.view',
      'finance.payment.record',
      'finance.report.view',
    ]);
    // explicitly excluded: void, customer-facing send, GST/settings admin config
    expect(paths(grants)).not.toContain('finance.invoice.delete');
    expect(paths(grants)).not.toContain('finance.invoice.send');
    expect(paths(grants)).not.toContain('finance.gst.manage');
    expect(paths(grants)).not.toContain('finance.settings.manage');
  });

  it('adjusting_entry + finance:read grants reads only (writes need write access)', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'adjusting_entry', modulePermissions: [{ module: 'finance', access: 'read' }] },
      REGISTRY,
    );
    expect(paths(grants)).toEqual(['finance.invoice.view', 'finance.report.view']);
  });

  it('access "none" (or absent module) yields no grants for that module', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'adjusting_entry', modulePermissions: [{ module: 'finance', access: 'none' }] },
      REGISTRY,
    );
    expect(grants).toEqual([]);
  });

  it('excludes sensitive leaves (PAN/bank) from an external accountant read grant', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'read_only', modulePermissions: [{ module: 'team', access: 'read' }] },
      REGISTRY,
    );
    expect(paths(grants)).toEqual(['team.directory.view', 'team.profile.personal.view']);
    expect(paths(grants)).not.toContain('team.profile.bank.view');
  });

  it('never grants team/salary writes even with write access + adjusting_entry (writes are finance-only)', () => {
    const grants = accountantGrantsFromInvite(
      {
        scopeRole: 'adjusting_entry',
        modulePermissions: [
          { module: 'team', access: 'write' },
          { module: 'salary', access: 'write' },
        ],
      },
      REGISTRY,
    );
    // only the read leaves of team/salary, no member.create/delete, no run.create
    expect(paths(grants)).toEqual([
      'salary.payslip.view',
      'team.directory.view',
      'team.profile.personal.view',
    ]);
  });

  it('skips a module that is not present in the registry without throwing', () => {
    const grants = accountantGrantsFromInvite(
      { scopeRole: 'read_only', modulePermissions: [{ module: 'nonexistent', access: 'write' }] },
      REGISTRY,
    );
    expect(grants).toEqual([]);
  });
});
