import { BadRequestException } from '@nestjs/common';
import type { GrantedPermission } from './permission-matcher';
import type { PermissionScope } from './permission-registry';
import { isValidPermissionPath } from './permission-registry';

const SCOPE_RANK: Record<PermissionScope, number> = { self: 0, all: 1 };
const LEAF_RE = /^(.+)\.(view|edit)$/;

interface LeafSlot {
  view?: PermissionScope;
  edit?: PermissionScope;
}

function bucket(grants: GrantedPermission[]): Map<string, LeafSlot> {
  const m = new Map<string, LeafSlot>();
  for (const g of grants) {
    const x = LEAF_RE.exec(g.path);
    if (!x) continue;
    const [, stem, action] = x;
    const slot = m.get(stem) ?? {};
    slot[action as 'view' | 'edit'] = g.scope;
    m.set(stem, slot);
  }
  return m;
}

/**
 * View-edit coherence invariant: for every leaf with an `edit` grant, a
 * `view` grant of scope >= `edit.scope` must also be present. Industry
 * standard (Rippling / Bamboo); edit logically requires view.
 *
 * Run at every grant save (`roles.service.setRolePermissions`,
 * `team.service.setPermissionOverrides`).
 */
export function assertViewEditCoherent(grants: GrantedPermission[]): void {
  for (const g of grants) {
    if (!isValidPermissionPath(g.path)) {
      throw new BadRequestException(`Unknown permission path: ${g.path}`);
    }
  }
  for (const [stem, { view, edit }] of bucket(grants)) {
    if (!edit) continue;
    if (!view) {
      throw new BadRequestException(
        `${stem}.edit requires ${stem}.view (industry edit-implies-view).`,
      );
    }
    if (SCOPE_RANK[view] < SCOPE_RANK[edit]) {
      throw new BadRequestException(
        `${stem}.edit@${edit} requires ${stem}.view@${edit} or higher (got @${view}).`,
      );
    }
  }
}

/**
 * Auto-promote `view` to match every `edit` grant's scope. Pure; returns a
 * new array. Used by role-preset application + UI grid normalisation.
 */
export function normaliseViewEditCoherent(grants: GrantedPermission[]): GrantedPermission[] {
  const buckets = bucket(grants);
  const out: GrantedPermission[] = [...grants];
  for (const [stem, { view, edit }] of buckets) {
    if (!edit) continue;
    if (!view) {
      out.push({ path: `${stem}.view`, scope: edit });
    } else if (SCOPE_RANK[view] < SCOPE_RANK[edit]) {
      const idx = out.findIndex((g) => g.path === `${stem}.view`);
      out[idx] = { path: `${stem}.view`, scope: edit };
    }
  }
  return out;
}
