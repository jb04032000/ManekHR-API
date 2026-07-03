import { SetMetadata } from '@nestjs/common';

/** Reflector metadata key for `@LegacyUnclassified`. */
export const LEGACY_UNCLASSIFIED_KEY = 'rbac:legacy-unclassified';

/**
 * TRANSITIONAL — RBAC re-architecture (design §8). Marks a route (or whole
 * controller) that has NOT yet been hand-classified with a real permission
 * marker.
 *
 * Once `RolesGuard` is global + deny-by-default, an unmarked route is denied.
 * This marker keeps a legacy route reachable by any authenticated user — the
 * exact posture it had before the flip (its controller still does its own
 * tenant scoping) — while making the outstanding classification debt
 * explicit, greppable, and logged rather than a silent fail-open.
 *
 * Applied in bulk at class level by `scripts/tag-legacy-unclassified.ts`. A
 * handler-level real marker (`@RequirePermission` / `@RequirePermissions` /
 * `@AuthenticatedOnly` / `@Public`) overrides it per route. Every remaining
 * occurrence is tracked debt — replace during that module's rollout. The
 * marker (and the guard branch honouring it) is removed in the final phase,
 * after which an unmarked route is a hard deny.
 */
export const LegacyUnclassified = () => SetMetadata(LEGACY_UNCLASSIFIED_KEY, true);
