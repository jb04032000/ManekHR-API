import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from './workspace.schema';
import { User } from '../../users/schemas/user.schema';
import { Role } from '../../rbac/schemas/role.schema';

/**
 * Status lifecycle for a workspace membership row:
 *   - 'invited'   — pending invite (token issued, not yet accepted)
 *   - 'active'    — accepted; user has access
 *   - 'declined'  — invitee explicitly declined
 *   - 'suspended' — temporarily blocked by owner / admin (rare)
 *   - 'removed'   — soft-deleted on member removal; retains audit trail
 *                   (W2.1 2026-05-10). Re-grant creates a new active row.
 */
export const WORKSPACE_MEMBER_STATUSES = [
  'active',
  'invited',
  'suspended',
  'declined',
  'removed',
] as const;
export type WorkspaceMemberStatus = (typeof WORKSPACE_MEMBER_STATUSES)[number];

@Schema({ timestamps: true })
export class WorkspaceMember extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: User | Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Role', default: null })
  roleId?: Role | Types.ObjectId;

  @Prop({
    type: String,
    enum: WORKSPACE_MEMBER_STATUSES,
    default: 'active',
  })
  status: WorkspaceMemberStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  invitedBy?: User | Types.ObjectId;

  @Prop()
  inviteToken?: string;

  @Prop()
  inviteTokenHash?: string;

  @Prop()
  inviteExpiry?: Date;

  @Prop()
  inviteeIdentifier?: string;

  @Prop({ type: String, enum: ['email', 'mobile'], default: null })
  inviteeType?: string | null;

  @Prop()
  joinedAt?: Date;

  // ── Wave 2 invite consolidation (2026-05-10) ───────────────────────────
  // When set, this membership row is tied to a directory employee
  // (TeamMember). On invite-accept, in addition to flipping status='active',
  // the linked TeamMember gets hasAppAccess=true + linkedUserId set.
  // Bare workspace-collaborator invites (co-founder, accountant) leave this
  // null. One token, one accept endpoint, one mental model — replaces the
  // previous split between workspaces.inviteMember + team.grantAccess.
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  linkedTeamMemberId?: Types.ObjectId | null;

  // Soft-delete metadata. When status flips to 'removed' (lifecycle L4):
  //   removedAt: timestamp of removal
  //   removedBy: actor who triggered removal (owner / admin)
  // Existing data + audit log retained per compliance + dispute resolution
  // requirement (locked decision #7).
  @Prop({ type: Date })
  removedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  removedBy?: User | Types.ObjectId;

  // P2.0.3 (2026-05-15) — timestamp of decline. Surfaces on the Sent /
  // History tabs of /dashboard/invitations so the owner can see when
  // a candidate rejected the invite. Pairs with status='declined'.
  @Prop({ type: Date })
  declinedAt?: Date;

  // P2.6 (2026-05-15) — dedup field for the hourly invite-expiry cron
  // (`InviteExpiryCron`). When the sweep finds an `inviteExpiry < now`
  // row and emits the expired notification(s), it stamps this field so
  // subsequent ticks skip the row. Avoids notification storm + dodges
  // changing the `status` enum (rows stay `status='invited'` per the
  // P2.6 locked decision).
  @Prop({ type: Date })
  expiryNotifiedAt?: Date;
}

export const WorkspaceMemberSchema = SchemaFactory.createForClass(WorkspaceMember);

// ── P1.1 (2026-05-14) — partial unique index migration ─────────────────────
// Replaces the pre-existing `{workspaceId:1, userId:1}` sparse-unique index.
// MongoDB `sparse: true` only excludes documents where the indexed field is
// MISSING, not where it is `null`. Identifier-only invites store `userId: null`
// (invitee not yet a platform user), so two such invites in the same workspace
// would collide with E11000. Partial filter `{userId: {$type: 'objectId'}}`
// enforces uniqueness only on rows where `userId` is an actual ObjectId, which
// is the intended semantic (one user, one membership row per workspace).
//
// Explicit name is required because Mongoose's auto-generated name
// (`workspaceId_1_userId_1`) collides with the legacy index during the online
// dual-index swap performed by `migrate-workspace-member-partial-index.ts`.
WorkspaceMemberSchema.index(
  { workspaceId: 1, userId: 1 },
  {
    name: 'workspaceId_userId_partial_unique_v2',
    unique: true,
    partialFilterExpression: { userId: { $type: 'objectId' } },
  },
);

// Lookup index for the invite-binding sweep performed by
// `auth.register` post-signup (P1.4) and the existing
// `workspaces.inviteMember` create-time identifier lookup. Compound (not
// unique) so multiple status snapshots co-exist.
WorkspaceMemberSchema.index(
  { workspaceId: 1, inviteeIdentifier: 1, status: 1 },
  { name: 'workspaceId_inviteeIdentifier_status_lookup' },
);

WorkspaceMemberSchema.index({ inviteeIdentifier: 1 }, { sparse: true });

// Invite-token consumer lookup (launch perf — Workstream F). Both the auth
// signup-with-invite paths (AuthService.register + SmsOtpService.verifyOtp) and
// WorkspacesService.joinWithToken / accept-invite run
// findOne({ inviteTokenHash, status: 'invited' }) as a pre-flight. inviteTokenHash
// had no index (the existing indexes are workspaceId- or inviteeIdentifier-led),
// so every invited signup scanned the workspacemembers collection. Sparse:
// inviteTokenHash is null/absent on the vast majority of rows (only live pending
// invites carry it), so the index stays tiny. status second so the equality on
// status:'invited' is also covered. Non-unique (a member can be re-invited).
// Additive, no migration.
WorkspaceMemberSchema.index({ inviteTokenHash: 1, status: 1 }, { sparse: true });
