import { Workspace } from '../schemas/workspace.schema';
import { WorkspaceMember } from '../schemas/workspace-member.schema';
import { Role } from '../../rbac/schemas/role.schema';

export interface WorkspaceWithRole {
  workspace: Workspace;
  currentUserRole: Role | null; // null for system member role
}

export interface WorkspaceMemberResult {
  member: WorkspaceMember;
}
