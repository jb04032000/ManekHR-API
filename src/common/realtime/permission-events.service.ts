import { Injectable, MessageEvent } from '@nestjs/common';
import { Subject, Observable, Subscription, merge, interval } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export interface PermissionEvent {
  /** The affected member's platform User id (TeamMember.linkedUserId). */
  userId: string;
  workspaceId: string;
  changeKind: 'overrides_updated' | 'role_changed';
}

/**
 * Real-time permission-change fan-out (2026-05-22).
 *
 * A role/override edit pushes a lightweight signal to the affected member's
 * open SSE stream (`GET /workspaces/:wsId/me/permission-events`) so their web
 * client re-fetches `/me/permissions` immediately, with no 60s notification-poll
 * lag and no manual hard reload. Server-side enforcement never depended on this;
 * it only closes the UI-freshness gap.
 *
 * In-process RxJS Subject, correct for a single API instance. Under
 * horizontal scaling a member's stream may live on a different instance than
 * the one handling the edit, so multi-instance deployments must republish
 * `emit()` over Redis pub/sub (mirror the connect worktree's
 * `redis-io.adapter` pattern) and have each instance forward matching events
 * into its local Subject. Documented here so the scaling story is explicit;
 * out of scope for this single-instance fix.
 */
@Injectable()
export class PermissionEventsService {
  private readonly events$ = new Subject<PermissionEvent>();

  /** Publish a permission-change signal for one member in one workspace. */
  emit(event: PermissionEvent): void {
    this.events$.next(event);
  }

  /**
   * Observe every emitted permission-change event (all users/workspaces).
   * Used by RolesGuard to invalidate its per-(user, workspace) caller-context
   * cache the instant a role/override edit lands, so the short cache TTL never
   * delays a permission change. Same single-instance caveat as the SSE stream
   * above: under horizontal scaling this must be republished over Redis.
   */
  onEvent(handler: (event: PermissionEvent) => void): Subscription {
    return this.events$.subscribe(handler);
  }

  /**
   * SSE stream scoped to one (user, workspace). Emits a `permission-change`
   * event whenever a change targets that member in that workspace, plus a
   * 25s `ping` heartbeat so idle-timeout proxies (nginx default 60s,
   * Cloudflare 100s) never silently drop the connection.
   */
  streamForUser(userId: string, workspaceId: string): Observable<MessageEvent> {
    const changes$ = this.events$.pipe(
      filter((e) => e.userId === userId && e.workspaceId === workspaceId),
      map(
        (e): MessageEvent => ({
          type: 'permission-change',
          data: { workspaceId: e.workspaceId, changeKind: e.changeKind, at: Date.now() },
        }),
      ),
    );
    const heartbeat$ = interval(25_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: Date.now() } })),
    );
    return merge(changes$, heartbeat$);
  }
}
