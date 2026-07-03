/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub @nestjs/mongoose before importing the migration — the transitive
// TeamMember schema import would otherwise trip vitest's reflect-metadata
// pipeline.
vi.mock('@nestjs/mongoose', () => {
  const noopDecorator = () => () => undefined;
  return {
    Prop: () => noopDecorator(),
    Schema: () => noopDecorator(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (name: string) => `${name}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});

import {
  transformMemberOverrides,
  MigrateTeamOverridesToPathsService,
} from '../migrate-team-overrides-to-paths';
import type { FlatOverrideShape } from '../migrate-team-overrides-to-paths';

// ────────────────────────────────────────────────────────────────────────────
// Pure transform tests (no DB, no DI)
// ────────────────────────────────────────────────────────────────────────────

describe('transformMemberOverrides', () => {
  it('a member with a team:edit allow flat entry — removes it from permissionOverrides and expands paths', () => {
    const result = transformMemberOverrides({
      permissionOverrides: [{ module: 'team', action: 'edit', allowed: true, scope: 'all' }],
      permissionPathOverrides: [],
    });

    if (result === null) throw new Error('expected non-null result');

    // team flat entry removed from permissionOverrides
    expect(result.permissionOverrides).toHaveLength(0);
    // expanded paths contain the non-sensitive edit leaves
    const paths = result.permissionPathOverrides.map((o) => o.path);
    expect(paths).toContain('team.profile.personal.edit');
    expect(paths).toContain('team.profile.job.edit');
    // sensitive bank path excluded from allow expansion
    expect(paths).not.toContain('team.profile.bank.edit');
    // all expanded path entries carry allowed:true + scope
    expect(result.permissionPathOverrides.every((o) => o.allowed === true)).toBe(true);
  });

  it('a member with a team:edit deny flat entry — removes it and expands all leaves including sensitive', () => {
    const result = transformMemberOverrides({
      permissionOverrides: [{ module: 'team', action: 'edit', allowed: false }],
      permissionPathOverrides: [],
    });

    if (result === null) throw new Error('expected non-null result');

    expect(result.permissionOverrides).toHaveLength(0);
    const paths = result.permissionPathOverrides.map((o) => o.path);
    expect(paths).toContain('team.profile.personal.edit');
    // deny projection includes sensitive groups
    expect(paths).toContain('team.profile.bank.edit');
    expect(result.permissionPathOverrides.every((o) => o.allowed === false)).toBe(true);
  });

  it('preserves existing permissionPathOverrides, appending expanded entries', () => {
    const existing = [{ path: 'team.directory.view', allowed: true, scope: 'self' as const }];
    const result = transformMemberOverrides({
      permissionOverrides: [{ module: 'team', action: 'create', allowed: true, scope: 'all' }],
      permissionPathOverrides: existing,
    });

    if (result === null) throw new Error('expected non-null result');

    // existing path override is preserved at index 0
    expect(result.permissionPathOverrides[0]).toEqual(existing[0]);
    // expanded create path appended
    const paths = result.permissionPathOverrides.map((o) => o.path);
    expect(paths).toContain('team.member.create');
  });

  it('preserves non-team flat entries in permissionOverrides', () => {
    const attendanceOverride: FlatOverrideShape = {
      module: 'attendance',
      action: 'view',
      allowed: true,
      scope: 'all',
    };
    const result = transformMemberOverrides({
      permissionOverrides: [
        { module: 'team', action: 'view', allowed: true, scope: 'self' },
        attendanceOverride,
      ],
      permissionPathOverrides: [],
    });

    if (result === null) throw new Error('expected non-null result');

    // Only the non-team entry survives in permissionOverrides
    expect(result.permissionOverrides).toHaveLength(1);
    expect(result.permissionOverrides[0]).toEqual(attendanceOverride);
  });

  it('a member with only non-team flat entries → returns null (skipped)', () => {
    const result = transformMemberOverrides({
      permissionOverrides: [
        { module: 'attendance', action: 'view', allowed: true },
        { module: 'leave', action: 'create', allowed: false },
      ],
      permissionPathOverrides: [],
    });

    expect(result).toBeNull();
  });

  it('idempotency — calling transform on already-migrated output returns null', () => {
    // First pass
    const first = transformMemberOverrides({
      permissionOverrides: [{ module: 'team', action: 'edit', allowed: true, scope: 'all' }],
      permissionPathOverrides: [],
    });

    if (first === null) throw new Error('expected non-null first result');

    // Second pass on the output of the first pass — no team flat entries remain
    const second = transformMemberOverrides({
      permissionOverrides: first.permissionOverrides,
      permissionPathOverrides: first.permissionPathOverrides,
    });
    expect(second).toBeNull();
  });

  it('a member with empty permissionOverrides → returns null (nothing to migrate)', () => {
    expect(
      transformMemberOverrides({ permissionOverrides: [], permissionPathOverrides: [] }),
    ).toBeNull();
  });

  it('handles undefined fields gracefully', () => {
    expect(transformMemberOverrides({})).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Service-level tests (mocked Model, validates run() orchestration)
// ────────────────────────────────────────────────────────────────────────────

describe('MigrateTeamOverridesToPathsService', () => {
  let teamModel: any;
  let svc: MigrateTeamOverridesToPathsService;

  beforeEach(() => {
    teamModel = {
      find: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    svc = new MigrateTeamOverridesToPathsService(teamModel);
  });

  function findReturns(docs: any[]) {
    teamModel.find.mockReturnValue({ exec: vi.fn().mockResolvedValue(docs) });
  }

  it('migrates a member with a team flat override and writes the result', async () => {
    findReturns([
      {
        _id: 'm1',
        workspaceId: 'ws1',
        permissionOverrides: [{ module: 'team', action: 'edit', allowed: true, scope: 'all' }],
        permissionPathOverrides: [],
      },
    ]);

    const result = await svc.run(false);

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dryRun).toBe(false);

    const [filter, update] = teamModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'm1' });
    expect(update.$set.permissionOverrides).toEqual([]);
    const paths = update.$set.permissionPathOverrides.map((o: any) => o.path);
    expect(paths).toContain('team.profile.personal.edit');
    expect(paths).not.toContain('team.profile.bank.edit');
  });

  it('dry-run — does not write to DB but counts as migrated', async () => {
    findReturns([
      {
        _id: 'm2',
        workspaceId: 'ws1',
        permissionOverrides: [{ module: 'team', action: 'view', allowed: false }],
        permissionPathOverrides: [],
      },
    ]);

    const result = await svc.run(true);

    expect(result.migrated).toBe(1);
    expect(result.dryRun).toBe(true);
    // updateOne must NOT have been called in dry-run mode
    expect(teamModel.updateOne).not.toHaveBeenCalled();
  });

  it('records an error and continues when an update throws', async () => {
    findReturns([
      {
        _id: 'm3',
        workspaceId: 'ws1',
        permissionOverrides: [{ module: 'team', action: 'view', allowed: true, scope: 'self' }],
        permissionPathOverrides: [],
      },
      {
        _id: 'm4',
        workspaceId: 'ws1',
        permissionOverrides: [{ module: 'team', action: 'edit', allowed: true, scope: 'all' }],
        permissionPathOverrides: [],
      },
    ]);
    teamModel.updateOne
      .mockResolvedValueOnce({ acknowledged: true })
      .mockRejectedValueOnce(new Error('mongo timeout'));

    const result = await svc.run(false);

    expect(result.migrated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('m4');
  });
});
