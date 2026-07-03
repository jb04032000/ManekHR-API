import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { User } from '../../users/schemas/user.schema';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';

/**
 * Scope tag attached per granted (module, action) pair.
 *
 * - `'self'` — actor may operate on their own data only (e.g. mark own
 *    attendance, view own salary slip).
 * - `'all'` — unscoped (operates on any data within the workspace).
 *
 * Stored as a parallel array (`Permission.actionScopes`) indexed against
 * `Permission.actions`. Every grant carries an explicit scope; a missing
 * `actionScopes[i]` falls back to `'self'` (least-privilege / fail-closed).
 */
export type PermissionScope = 'self' | 'all';

@Schema()
export class Permission {
  @Prop({ type: String, enum: AppModule, required: true })
  module: AppModule;

  @Prop({ type: [String], enum: ModuleAction, required: true })
  actions: ModuleAction[];

  /**
   * Parallel array indexed with `actions[]`. Each entry tags the granted
   * action with a scope (`'self'` | `'all'`). Seeded roles + the scope-
   * backfill migration populate this explicitly on every grant; a missing
   * entry falls back to `'self'` (least-privilege / fail-closed).
   */
  @Prop({ type: [String], enum: ['self', 'all'], required: false })
  actionScopes?: PermissionScope[];
}

/**
 * A permission grant addressed by a hierarchical registry path
 * (e.g. `team.profile.bank.view`). Phase 1a (RBAC re-architecture) — runs
 * alongside the legacy flat `Permission[]` during the fail-closed
 * transition; `RolesGuard` matches `@RequirePermission(path)` routes
 * against these.
 */
@Schema()
export class GrantedPermissionPath {
  @Prop({ type: String, required: true })
  path: string;

  @Prop({ type: String, enum: ['self', 'all'], required: true })
  scope: PermissionScope;
}

/**
 * Self-edit hierarchy policy (separation-of-duty).
 *
 * - `'allow'` — a member with this role may edit their own profile record.
 * - `'block'` — a member with this role may NOT edit their own sensitive
 *    profile fields (designation, salary config, bank, role assignment).
 *    Used for Manager / HR so they cannot change their own pay or title —
 *    only the workspace owner can. The owner is always exempt (bypasses
 *    RolesGuard entirely).
 *
 * Enforced by the self-edit hierarchy guard (Team module, Part B). Stored
 * on the role so the seeded library carries an explicit policy.
 */
export type SelfProfileEdit = 'allow' | 'block';

@Schema({ timestamps: true })
export class Role extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', default: null })
  workspaceId: Workspace | Types.ObjectId | null; // null for system roles

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  color?: string;

  @Prop({ default: false })
  isSystem: boolean;

  /**
   * Self-edit hierarchy policy — see `SelfProfileEdit`. Defaults to
   * `'allow'`; seeded Manager / HR roles ship `'block'`.
   */
  @Prop({ type: String, enum: ['allow', 'block'], default: 'allow' })
  selfProfileEdit: SelfProfileEdit;

  @Prop({ type: [Permission], default: [] })
  permissions: Permission[];

  /**
   * Hierarchical path grants (Phase 1a — RBAC re-architecture). Additive
   * alongside `permissions`; the legacy array stays until every route is
   * path-classified, then is removed in a cleanup wave.
   */
  @Prop({ type: [GrantedPermissionPath], default: [] })
  permissionPaths: GrantedPermissionPath[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: User | Types.ObjectId;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
