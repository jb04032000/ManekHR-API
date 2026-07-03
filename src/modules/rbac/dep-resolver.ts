import { BadRequestException } from '@nestjs/common';
import type { GrantedPermission } from './permission-matcher';
import {
  findRegistryNode,
  isValidPermissionPath,
  type PermissionNode,
  type PermissionScope,
} from './permission-registry';

const SCOPE_RANK: Record<PermissionScope, number> = { self: 0, all: 1 };

/**
 * Walk the registry tree and find the node whose `actions` includes the
 * given fully-qualified action path. Used to locate the `requires` chain
 * declared on the node.
 *
 * Action path examples — `team.member.create` (action='create' on the
 * `member` feature), `team.profile.bank.edit` (action='edit' on the
 * sub-feature node `bank` under `profile`).
 */
function nodeForActionPath(actionPath: string): PermissionNode | undefined {
  const segs = actionPath.split('.');
  // Try each split point: node = first n segments, action = remainder.
  for (let cut = segs.length - 1; cut >= 1; cut--) {
    const nodePath = segs.slice(0, cut).join('.');
    const action = segs.slice(cut).join('.');
    const node = findRegistryNode(nodePath);
    if (node?.actions?.some((a) => a.action === action)) return node;
  }
  return undefined;
}

/**
 * Combined per-action + per-node prerequisites for an action path.
 * Per-action `requires` (declared on `PermissionActionDef.requires`) is
 * MERGED with the node-level `requires` so an action can declare its own
 * narrower / broader dep set without duplicating the common node-level deps.
 *
 * Order is per-node first, then per-action; the resolver de-dupes by path
 * downstream, so order is purely for readable error messages.
 */
function requiresForActionPath(actionPath: string): string[] {
  const node = nodeForActionPath(actionPath);
  if (!node) return [];
  // The action key is everything past the node's path. Look it up to fetch
  // its per-action `requires` (if any).
  const actionDef = node.actions?.find((a) => actionPath.endsWith(`.${a.action}`));
  // Some actions are multi-segment (none today, but the registry supports
  // it). The simple `.action` endsWith is correct for current usage; revisit
  // if any future action contains a dot.
  return [...(node.requires ?? []), ...(actionDef?.requires ?? [])];
}

function parseRequire(req: string): { path: string; scope?: PermissionScope } {
  const [path, scope] = req.split('@');
  return { path, scope: scope as PermissionScope | undefined };
}

/**
 * Cross-leaf dependency check. A grant whose node declares `requires: [...]`
 * needs every prerequisite present at sufficient scope. Industry pattern
 * (Workday / Deel) — prevents orphan grants like `member.delete` without
 * `directory.view`. Run at every grant-save alongside `assertViewEditCoherent`.
 */
export function assertDepsResolved(grants: GrantedPermission[]): void {
  for (const g of grants) {
    if (!isValidPermissionPath(g.path)) {
      throw new BadRequestException(`Unknown permission path: ${g.path}`);
    }
  }
  const have = new Map(grants.map((g) => [g.path, g.scope]));
  for (const g of grants) {
    for (const req of requiresForActionPath(g.path)) {
      const { path: reqPath, scope: reqScope } = parseRequire(req);
      const held = have.get(reqPath);
      if (!held) throw new BadRequestException(`${g.path} requires ${reqPath}.`);
      if (reqScope && SCOPE_RANK[held] < SCOPE_RANK[reqScope]) {
        throw new BadRequestException(
          `${g.path} requires ${reqPath} at scope '${reqScope}' or wider (held '${held}').`,
        );
      }
    }
  }
}

/**
 * Auto-add or upgrade missing dependency grants. Pure; returns a new array.
 * Used by role-preset application + UI grid auto-toggle.
 *
 * **Single-level only.** The outer loop iterates the input `grants`; deps
 * added to `out` are NOT re-walked for their own `requires`. The current
 * registry has no transitive deps (dep-of-dep). If/when one is introduced,
 * replace the single pass with a fixpoint loop (resolve until `out` stops
 * growing).
 */
export function resolveImplicitDeps(grants: GrantedPermission[]): GrantedPermission[] {
  const out: GrantedPermission[] = [...grants];
  const have = (path: string): GrantedPermission | undefined => out.find((g) => g.path === path);
  for (const g of grants) {
    for (const req of requiresForActionPath(g.path)) {
      const { path: reqPath, scope: reqScope } = parseRequire(req);
      const existing = have(reqPath);
      const target: PermissionScope = reqScope ?? 'self';
      if (!existing) {
        out.push({ path: reqPath, scope: target });
      } else if (reqScope && SCOPE_RANK[existing.scope] < SCOPE_RANK[reqScope]) {
        const idx = out.indexOf(existing);
        out[idx] = { path: reqPath, scope: reqScope };
      }
    }
  }
  return out;
}
