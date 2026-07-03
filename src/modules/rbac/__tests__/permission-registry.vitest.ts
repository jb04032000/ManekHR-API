import { describe, it, expect } from 'vitest';
import {
  PERMISSION_REGISTRY,
  allPermissionPaths,
  isValidPermissionPath,
} from '../permission-registry';

describe('permission-registry', () => {
  it('exposes the team module', () => {
    expect(PERMISSION_REGISTRY.some((m) => m.module === 'team')).toBe(true);
  });

  it('accepts known leaf paths', () => {
    expect(isValidPermissionPath('team.directory.view')).toBe(true);
    expect(isValidPermissionPath('team.profile.bank.view')).toBe(true);
    expect(isValidPermissionPath('team.profile.bank.edit')).toBe(true);
    expect(isValidPermissionPath('team.appAccess.manage')).toBe(true);
  });

  it('rejects non-leaf and unknown paths', () => {
    expect(isValidPermissionPath('team.profile')).toBe(false);
    expect(isValidPermissionPath('team.profile.bank')).toBe(false);
    expect(isValidPermissionPath('team.bogus.view')).toBe(false);
    expect(isValidPermissionPath('finance.view')).toBe(false);
  });

  it('has no duplicate leaf paths', () => {
    const all = [...allPermissionPaths()];
    expect(new Set(all).size).toBe(all.length);
  });

  it('flags the sensitive profile groups', () => {
    const team = PERMISSION_REGISTRY.find((m) => m.module === 'team');
    const profile = team.features.find((f) => f.key === 'profile');
    const sensitive = (profile.children ?? [])
      .filter((c) => c.sensitive)
      .map((c) => c.key)
      .sort();
    expect(sensitive).toEqual(['bank', 'org', 'pay', 'statutory']);
  });

  // ── Finance billing slice (design spec 2026-06-01 SS6.B) ──────────────────

  it('exposes the finance module', () => {
    expect(PERMISSION_REGISTRY.some((m) => m.module === 'finance')).toBe(true);
  });

  it('registers the finance billing leaf paths', () => {
    for (const path of [
      'finance.invoice.view',
      'finance.invoice.create',
      'finance.invoice.edit',
      'finance.invoice.delete',
      'finance.invoice.post',
      'finance.invoice.send',
      'finance.creditNote.create',
      'finance.expense.view',
      'finance.expense.create',
      'finance.payment.record',
      'finance.report.view',
      'finance.gst.manage',
      'finance.settings.manage',
    ]) {
      expect(isValidPermissionPath(path), path).toBe(true);
    }
  });

  it('rejects non-leaf finance paths', () => {
    expect(isValidPermissionPath('finance.invoice')).toBe(false);
    expect(isValidPermissionPath('finance.bogus.view')).toBe(false);
  });

  it('scopes the voucher leaves and unscopes the workspace-level leaves', () => {
    const finance = PERMISSION_REGISTRY.find((m) => m.module === 'finance');
    const byKey = (key: string) => finance.features.find((f) => f.key === key);
    const action = (key: string, act: string) => byKey(key)?.actions?.find((a) => a.action === act);
    // Voucher / member-owned leaves carry the self/all axis.
    expect(action('invoice', 'view')?.scoped).toBe(true);
    expect(action('invoice', 'create')?.scoped).toBe(true);
    expect(action('expense', 'view')?.scoped).toBe(true);
    expect(action('payment', 'record')?.scoped).toBe(true);
    expect(action('creditNote', 'create')?.scoped).toBe(true);
    // Workspace-level config leaves have no self meaning.
    expect(action('invoice', 'send')?.scoped).toBe(false);
    expect(action('report', 'view')?.scoped).toBe(false);
    expect(action('gst', 'manage')?.scoped).toBe(false);
    expect(action('settings', 'manage')?.scoped).toBe(false);
  });

  it('flags the sensitive finance features', () => {
    const finance = PERMISSION_REGISTRY.find((m) => m.module === 'finance');
    const sensitiveFeatures = finance.features
      .filter((f) => f.sensitive)
      .map((f) => f.key)
      .sort();
    expect(sensitiveFeatures).toEqual(['creditNote', 'gst', 'settings']);
  });
});
