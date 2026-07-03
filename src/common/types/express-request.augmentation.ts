import type { Types } from 'mongoose';
import type { AuthJwtPayload } from '../../modules/auth/types/auth.types';

/**
 * Centralized Express namespace augmentation for fields the platform layers
 * onto `req` at runtime:
 *
 *   - `req.user`        — set by `JwtAuthGuard` after JWT verification.
 *                         Carries the `AuthJwtPayload` (sub, jti, platform,
 *                         forgotPasswordReset). We extend `Express.User`
 *                         (passport's default-empty user interface) rather
 *                         than redefining `Request.user`, so the property's
 *                         declared type stays compatible with `@types/express`
 *                         and `@types/passport`.
 *
 *   - `req.resourceScope` — set by `ResourceScopeGuard` after RolesGuard. The
 *                           attached snapshot answers "may this caller see
 *                           machine X / location Y" without re-querying the
 *                           scope row in every controller.
 *
 *   - `req.workspace`   — set by `RolesGuard` after the (module, action)
 *                         permission check passes. Lets downstream controllers
 *                         read the resolved workspaceId without re-parsing
 *                         params/body/headers.
 *
 * Two earlier per-feature augmentations (subscription.guard.ts and
 * session-activity.middleware.ts) extend the same `Express.Request`
 * interface; each augmentation merges, so adding fields here does not
 * collide with those.
 */

interface ResourceScopeAttachment {
  hasScope: boolean;
  isOwner: boolean;
  scopedMachineIds: Types.ObjectId[];
  scopedLocationIds: Types.ObjectId[];
}

interface WorkspaceContextAttachment {
  id: string | Types.ObjectId;
}

declare global {
  // `namespace Express` is the only path supported by `@types/express` /
  // `@types/passport` for declaration merging — there is no module export
  // we could augment instead. The eslint disable applies to the declaration
  // merging block only.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // Empty extension is the canonical pattern for declaration-merging an
    // existing interface (passport's default-empty `User`). A `type` alias
    // would not merge; listing fields explicitly would duplicate
    // `AuthJwtPayload` and drift over time.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthJwtPayload {}

    interface Request {
      resourceScope?: ResourceScopeAttachment;
      workspace?: WorkspaceContextAttachment;
    }
  }
}

export type { ResourceScopeAttachment, WorkspaceContextAttachment };
