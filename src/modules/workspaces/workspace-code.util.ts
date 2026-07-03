// Derives a short, uppercase workspace code from a workspace name.
//
// What it does: turns "ManekHR Textiles" -> "ZARI" (letters preferred), or
// falls back to alphanumerics, then "WS". This is the {WS} token embedded in
// every employee code (single source of truth = Workspace.workspaceCode).
//
// Cross-module links:
//   • workspaces.service.create (new workspaces) and team.service
//     (ensureWorkspaceCode, legacy backfill) both call this, then suffix a
//     number on collision to guarantee a globally-unique Workspace.workspaceCode.
//   • renderEmployeeCode (team.service) substitutes {WS} with the stored code.
//
// Watch: keep the output within [A-Z0-9] and short (<= 6) so the final employee
// code stays inside the TeamMember.employeeCode regex (^[A-Za-z0-9_-]{1,32}$).
export function deriveWorkspaceCodeBase(name?: string): string {
  const upper = (name ?? '').toUpperCase();
  const letters = upper.replace(/[^A-Z]/g, '');
  const base = letters.length >= 2 ? letters : upper.replace(/[^A-Z0-9]/g, '');
  return base.slice(0, 6) || 'WS';
}
