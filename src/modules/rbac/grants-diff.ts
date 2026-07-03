import type { GrantedPermission } from './permission-matcher';

export interface GrantsDiff {
  added: GrantedPermission[];
  removed: GrantedPermission[];
  scopeChanged: { path: string; from: string; to: string }[];
}

/**
 * Compute the before/after diff between two grant arrays. Pure. Used by
 * audit emission on role-permission and per-member override changes — keeps
 * the log structured enough that compliance reviewers can spot privilege
 * escalations at a glance.
 */
export function diffGrants(before: GrantedPermission[], after: GrantedPermission[]): GrantsDiff {
  const b = new Map(before.map((g) => [g.path, g.scope]));
  const a = new Map(after.map((g) => [g.path, g.scope]));
  const added: GrantedPermission[] = [];
  const removed: GrantedPermission[] = [];
  const scopeChanged: GrantsDiff['scopeChanged'] = [];
  for (const [path, scope] of a) {
    const prev = b.get(path);
    if (prev === undefined) {
      added.push({ path, scope });
    } else if (prev !== scope) {
      scopeChanged.push({ path, from: prev, to: scope });
    }
  }
  for (const [path, scope] of b) {
    if (!a.has(path)) removed.push({ path, scope });
  }
  return { added, removed, scopeChanged };
}
