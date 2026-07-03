import { describe, it, expect } from 'vitest';
import { PERMISSION_REGISTRY, type PermissionNode } from '../permission-registry';

function find(path: string): PermissionNode | undefined {
  const [mod, ...rest] = path.split('.');
  let cur: PermissionNode | undefined = PERMISSION_REGISTRY.find(
    (m) => m.module === mod,
  )?.features.find((f) => f.key === rest[0]);
  for (const seg of rest.slice(1)) cur = cur?.children?.find((c) => c.key === seg);
  return cur;
}

function findOrThrow(path: string): PermissionNode {
  const node = find(path);
  if (!node) throw new Error(`registry node not found: ${path}`);
  return node;
}

describe('registry leaf metadata', () => {
  it.each(['team.profile.pay', 'team.profile.bank', 'team.profile.statutory', 'team.profile.org'])(
    '%s has sodOwnerOnlyOnSelf=true',
    (path) => expect(findOrThrow(path).sodOwnerOnlyOnSelf).toBe(true),
  );

  it.each(['team.profile.personal', 'team.profile.job', 'team.profile.documents'])(
    '%s has NO sodOwnerOnlyOnSelf',
    (path) => expect(findOrThrow(path).sodOwnerOnlyOnSelf).toBeUndefined(),
  );

  it('team.member.create bundles every profile-edit + directory.view@all deps', () => {
    const member = findOrThrow('team.member');
    const create = member.actions?.find((a) => a.action === 'create');
    expect(create?.requires).toEqual([
      'team.directory.view@all',
      'team.profile.personal.edit@all',
      'team.profile.job.edit@all',
      'team.profile.pay.edit@all',
      'team.profile.bank.edit@all',
      'team.profile.statutory.edit@all',
      'team.profile.org.edit@all',
      'team.profile.documents.edit@all',
    ]);
  });

  it('team.member.delete declares only the directory.view@all dep', () => {
    const member = findOrThrow('team.member');
    const del = member.actions?.find((a) => a.action === 'delete');
    expect(del?.requires).toEqual(['team.directory.view@all']);
  });

  it('team.appAccess declares directory + profile.org view@all deps at the node level', () =>
    expect(findOrThrow('team.appAccess').requires).toEqual([
      'team.directory.view@all',
      'team.profile.org.view@all',
    ]));
});
