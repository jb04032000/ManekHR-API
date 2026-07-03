import type { GrantedPermission } from '../../rbac/permission-matcher';
import type { PermissionModuleDef, PermissionNode } from '../../rbac/permission-registry';

/** Read-shaped action verbs. Everything else is treated as a write. */
const READ_ACTIONS = new Set(['view']);

/**
 * Bookkeeping write verbs an external accountant may perform when the firm
 * grants a module `write` access AND the invite's scopeRole is
 * 'adjusting_entry'. Deliberately EXCLUDES destructive verbs
 * (delete/delete_permanent), cost-bearing customer comms (send), and admin
 * config (manage) - those stay firm-internal.
 */
const ACCOUNTANT_WRITE_ACTIONS = new Set(['create', 'edit', 'post', 'record']);

/**
 * Only finance is writable by an accountant. Team/salary remain read-only even
 * with module `write` access - an external accountant posts adjusting entries,
 * not employee/payroll mutations.
 */
const ACCOUNTANT_WRITABLE_MODULES = new Set(['finance']);

export interface AccountantInviteAccess {
  /** 'read_only' | 'adjusting_entry' */
  scopeRole: string;
  /** access: 'none' | 'read' | 'write' */
  modulePermissions: { module: string; access: string }[];
}

/**
 * Translate an accepted accountant invite's coarse module access into the
 * explicit leaf-grant list RolesGuard matches against (same shape as a role's
 * `permissionPaths`). Registry-driven so new permission leaves are classified
 * automatically; fail-closed - only leaves the policy explicitly allows are
 * granted.
 *
 * Policy (researched vs Xero "Adviser" / QuickBooks "Accountant" / Zoho Books):
 *  - Reads: any NON-sensitive leaf in a module the invite grants `read`/`write`,
 *    scoped 'all' (an accountant reviews the whole firm's books).
 *  - Writes: ONLY finance bookkeeping verbs (create/edit/post/record), ONLY when
 *    module access is `write` AND scopeRole is 'adjusting_entry'. Never
 *    delete/send/manage; never team/salary writes.
 *  - Sensitive leaves (PAN/Aadhaar/bank/statutory/org) are never granted to an
 *    external accountant through the coarse module toggle.
 */
export function accountantGrantsFromInvite(
  invite: AccountantInviteAccess,
  registry: PermissionModuleDef[],
): GrantedPermission[] {
  const grants: GrantedPermission[] = [];
  const writesUnlocked = invite.scopeRole === 'adjusting_entry';

  for (const mp of invite.modulePermissions ?? []) {
    if (mp.access !== 'read' && mp.access !== 'write') continue; // 'none'/unknown -> no access
    const moduleDef = registry.find((m) => m.module === mp.module);
    if (!moduleDef) continue;
    const canWriteModule =
      mp.access === 'write' && writesUnlocked && ACCOUNTANT_WRITABLE_MODULES.has(mp.module);

    const walk = (nodes: PermissionNode[], prefix: string, sensitiveAncestor: boolean): void => {
      for (const node of nodes) {
        const path = `${prefix}.${node.key}`;
        const sensitive = sensitiveAncestor || node.sensitive === true;
        if (!sensitive) {
          for (const a of node.actions ?? []) {
            if (READ_ACTIONS.has(a.action)) {
              grants.push({ path: `${path}.${a.action}`, scope: 'all' });
            } else if (canWriteModule && ACCOUNTANT_WRITE_ACTIONS.has(a.action)) {
              grants.push({ path: `${path}.${a.action}`, scope: 'all' });
            }
          }
        }
        if (node.children) walk(node.children, path, sensitive);
      }
    };
    walk(moduleDef.features, mp.module, false);
  }
  return grants;
}
