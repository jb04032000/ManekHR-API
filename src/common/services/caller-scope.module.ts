import { Global, Module } from '@nestjs/common';
import { CallerScopeService } from './caller-scope.service';

/**
 * Role Taxonomy P1 (2026-05-15) — `CallerScopeService` as a global
 * provider so any feature module (attendance / salary / regularization /
 * …) can inject it for `self`/`all` scope resolution without per-module
 * import wiring. Mirrors the `@Global()` pattern used by `PostHogService`.
 *
 * The service resolves Mongoose models lazily via `ModuleRef`, so this
 * module declares no `MongooseModule.forFeature` of its own.
 */
@Global()
@Module({
  providers: [CallerScopeService],
  exports: [CallerScopeService],
})
export class CallerScopeModule {}
