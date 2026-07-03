import { Global, Module } from '@nestjs/common';
import { PermissionEventsService } from './permission-events.service';

/**
 * Global realtime fan-out (2026-05-22). Exposes `PermissionEventsService` to
 * any module without per-feature wiring (same `@Global` pattern as
 * `PostHogModule`): the team service emits permission-change signals, the
 * RBAC `MeController` streams them over SSE.
 */
@Global()
@Module({
  providers: [PermissionEventsService],
  exports: [PermissionEventsService],
})
export class RealtimeModule {}
