import { Module } from '@nestjs/common';
import { PushAdapter } from './push.adapter';

/**
 * `PushModule` — isolates `PushAdapter` (firebase-admin sender) so consumers
 * that only need push (e.g. `UserDevicesModule`) can import it WITHOUT pulling
 * in the whole `AdaptersModule`, which back-imports `NotificationsModule`
 * (via `InAppAdapter`). That back-edge would otherwise form a boot-time module
 * cycle: NotificationsModule -> UserDevicesModule -> AdaptersModule ->
 * NotificationsModule.
 *
 * `PushAdapter`'s only dependency is `ConfigService`, registered globally via
 * `ConfigModule.forRoot({ isGlobal: true })` in `AppModule`, so no `imports`
 * are needed here.
 */
@Module({
  providers: [PushAdapter],
  exports: [PushAdapter],
})
export class PushModule {}
