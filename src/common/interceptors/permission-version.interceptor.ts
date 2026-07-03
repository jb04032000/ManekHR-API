import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { WorkspaceMember } from '../../modules/workspaces/schemas/workspace-member.schema';
import { TeamMember } from '../../modules/team/schemas/team-member.schema';
import { Role } from '../../modules/rbac/schemas/role.schema';
import { computePermissionVersion } from '../../modules/rbac/permission-version';

type WorkspaceMemberDoc = WorkspaceMember & { _id: unknown };
type TeamMemberDoc = TeamMember & { _id: unknown };
type RoleDoc = Role & { _id: unknown };

/**
 * Phase 2.3 — emits `X-Permission-Version` on every workspace-scoped
 * response so the FE can detect permission drift without polling.
 *
 * Design goals:
 *   - Cheap: 3 `.lean()` DB calls max per request. All fields are indexed.
 *   - Fail-safe: any error silently skips header emission — the response
 *     is never blocked.
 *   - Idempotent on the client: same version value → no cache invalidation.
 *   - Scope guard: only runs when `req.params.workspaceId` + `req.user.sub`
 *     are both present (workspace-scoped authenticated requests).
 */
@Injectable()
export class PermissionVersionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PermissionVersionInterceptor.name);

  constructor(
    @InjectModel(WorkspaceMember.name) private readonly memberModel: Model<WorkspaceMemberDoc>,
    @InjectModel(TeamMember.name) private readonly teamMemberModel: Model<TeamMemberDoc>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDoc>,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{
      url?: string;
      originalUrl?: string;
      params?: { workspaceId?: string; wsId?: string; id?: string };
      user?: { sub?: string };
    }>();
    const res = http.getResponse<{ setHeader: (k: string, v: string) => void }>();

    // Resolve workspaceId from any of the three param names, but only trust
    // `:id` when the URL is unambiguously workspace-scoped (i.e. the path
    // segment after /workspaces/ matches an ObjectId hex).
    const url: string = req?.url ?? req?.originalUrl ?? '';
    const workspaceMatch = url.match(/^\/(?:api\/)?workspaces\/([0-9a-fA-F]{24})\b/);
    const workspaceId =
      workspaceMatch?.[1] ??
      req?.params?.workspaceId ??
      req?.params?.wsId ??
      (req?.params?.id && /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : undefined);

    const userId = req?.user?.sub;

    // SSE endpoints (e.g. /me/permission-events) stream the body incrementally;
    // calling res.setHeader after the first chunk flushes throws
    // ERR_HTTP_HEADERS_SENT. The version header is meaningless on a long-lived
    // stream anyway, so skip these routes entirely.
    if (url.includes('/me/permission-events')) {
      return next.handle();
    }

    return next.handle().pipe(
      // mergeMap (not tap) so the async header write completes before the
      // value propagates downstream — prevents headers-after-flush on fast
      // responses (C3 fix).
      mergeMap(async (value) => {
        if (!workspaceId || !userId) return value;
        try {
          const version = await this.computeForUser(workspaceId, userId);
          if (version) res.setHeader('X-Permission-Version', version);
        } catch (e) {
          this.logger.debug(
            `permission-version compute skipped for ws=${workspaceId}: ${(e as Error).message}`,
          );
        }
        return value;
      }),
    );
  }

  private async computeForUser(workspaceId: string, userId: string): Promise<string | null> {
    // 2026-05-22: explicit ObjectId casts. Schema declares workspaceId /
    // userId / linkedUserId as union types (`Workspace | Types.ObjectId`)
    // and Mongoose's implicit string-to-ObjectId cast does not fire
    // reliably on union-typed paths in v8. Without these casts the
    // membership lookup intermittently returns null, the header drops
    // from the response, then on the next request it matches again --
    // FE sees alternating "header present" vs "header absent" patterns
    // and noticeVersion() invalidates the cache repeatedly, producing an
    // infinite refetch + re-render loop on the dashboard.
    const wsOid = new Types.ObjectId(workspaceId);
    const userOid = new Types.ObjectId(userId);

    const member = await this.memberModel
      .findOne({ workspaceId: wsOid, userId: userOid, status: 'active' })
      .select('roleId')
      .lean();

    if (!member) return null;

    const roleId = (member as { roleId?: { toString(): string } }).roleId;

    const [role, teamMember] = await Promise.all([
      roleId
        ? this.roleModel.findById(roleId).select('permissions permissionPaths').lean()
        : Promise.resolve(null),
      this.teamMemberModel
        .findOne({ workspaceId: wsOid, linkedUserId: userOid, isDeleted: false })
        .select('permissionOverrides permissionPathOverrides')
        .lean(),
    ]);

    return computePermissionVersion({
      roleId: roleId?.toString() ?? null,
      rolePermissions: (role as { permissions?: unknown[] } | null)?.permissions as
        | Parameters<typeof computePermissionVersion>[0]['rolePermissions']
        | undefined,
      rolePermissionPaths: (role as { permissionPaths?: unknown[] } | null)?.permissionPaths as
        | Parameters<typeof computePermissionVersion>[0]['rolePermissionPaths']
        | undefined,
      memberPermissionOverrides: (teamMember as { permissionOverrides?: unknown[] } | null)
        ?.permissionOverrides as
        | Parameters<typeof computePermissionVersion>[0]['memberPermissionOverrides']
        | undefined,
      memberPermissionPathOverrides: (teamMember as { permissionPathOverrides?: unknown[] } | null)
        ?.permissionPathOverrides as
        | Parameters<typeof computePermissionVersion>[0]['memberPermissionPathOverrides']
        | undefined,
    });
  }
}
