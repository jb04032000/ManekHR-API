/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Neutralise @nestjs/mongoose decorators before the migration (and the Role /
// TeamMember schema graph it imports) is evaluated.
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

import { StripAttendanceMarkEditSelfScopeService } from '../strip-attendance-mark-edit-self-scope';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';

/**
 * G2 / A+ strip migration — removes the retired `self` scope on attendance
 * mark/edit from roles + member path overrides, leaving every other grant
 * (notably Manager/HR `mark/edit@all` and deny-overrides) untouched.
 */
describe('StripAttendanceMarkEditSelfScopeService', () => {
  let roleModel: any;
  let teamMemberModel: any;

  const makeModels = (roles: any[], members: any[]) => {
    roleModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(roles) }),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    teamMemberModel = {
      find: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(members) }),
      updateOne: vi.fn().mockResolvedValue({}),
    };
    return new StripAttendanceMarkEditSelfScopeService(roleModel, teamMemberModel);
  };

  beforeEach(() => vi.clearAllMocks());

  it('strips self-scoped mark/edit from a Worker role (both flat + path stores), keeping everything else', async () => {
    const worker = {
      _id: 'r1',
      name: 'Worker',
      permissions: [
        {
          module: AppModule.ATTENDANCE,
          actions: [ModuleAction.VIEW, ModuleAction.MARK, ModuleAction.MANAGE_REGULARIZATIONS],
          actionScopes: ['self', 'self', 'self'],
        },
        { module: AppModule.TEAM, actions: [ModuleAction.VIEW], actionScopes: ['self'] },
      ],
      permissionPaths: [
        { path: 'attendance.record.view', scope: 'self' },
        { path: 'attendance.record.mark', scope: 'self' },
        { path: 'attendance.selfPunch.create', scope: 'self' },
      ],
    };
    const svc = makeModels([worker], []);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(1);
    expect(roleModel.updateOne).toHaveBeenCalledTimes(1);
    const set = roleModel.updateOne.mock.calls[0][1].$set;

    // Flat: mark dropped from the attendance grant; view + regularizations kept.
    const attn = set.permissions.find((p: any) => p.module === AppModule.ATTENDANCE);
    expect(attn.actions).toEqual([ModuleAction.VIEW, ModuleAction.MANAGE_REGULARIZATIONS]);
    expect(attn.actionScopes).toEqual(['self', 'self']);
    // Team grant untouched.
    expect(set.permissions.find((p: any) => p.module === AppModule.TEAM)).toBeDefined();

    // Path: mark@self dropped; view + selfPunch kept.
    expect(set.permissionPaths.map((g: any) => g.path)).toEqual([
      'attendance.record.view',
      'attendance.selfPunch.create',
    ]);
  });

  it('leaves a Manager role with mark/edit@all completely untouched', async () => {
    const manager = {
      _id: 'r2',
      name: 'Manager',
      permissions: [
        {
          module: AppModule.ATTENDANCE,
          actions: [ModuleAction.VIEW, ModuleAction.MARK, ModuleAction.EDIT],
          actionScopes: ['all', 'all', 'all'],
        },
      ],
      permissionPaths: [
        { path: 'attendance.record.mark', scope: 'all' },
        { path: 'attendance.record.edit', scope: 'all' },
      ],
    };
    const svc = makeModels([manager], []);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });

  it('removes a self force-ALLOW mark override on a member but keeps deny + all overrides', async () => {
    const member = {
      _id: 'm1',
      permissionPathOverrides: [
        { path: 'attendance.record.mark', allowed: true, scope: 'self' }, // retired → drop
        { path: 'attendance.record.edit', allowed: false }, // deny → keep
        { path: 'attendance.record.view', allowed: true, scope: 'self' }, // unrelated → keep
      ],
    };
    const svc = makeModels([], [member]);

    const result = await svc.run();

    expect(result.membersUpdated).toBe(1);
    const set = teamMemberModel.updateOne.mock.calls[0][1].$set;
    expect(set.permissionPathOverrides).toEqual([
      { path: 'attendance.record.edit', allowed: false },
      { path: 'attendance.record.view', allowed: true, scope: 'self' },
    ]);
  });

  it('is idempotent — a clean role + clean member trigger no writes', async () => {
    const cleanRole = {
      _id: 'r3',
      name: 'Member',
      permissions: [
        { module: AppModule.ATTENDANCE, actions: [ModuleAction.VIEW], actionScopes: ['self'] },
      ],
      permissionPaths: [{ path: 'attendance.record.view', scope: 'self' }],
    };
    const svc = makeModels([cleanRole], []);

    const result = await svc.run();

    expect(result.rolesUpdated).toBe(0);
    expect(result.membersUpdated).toBe(0);
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
