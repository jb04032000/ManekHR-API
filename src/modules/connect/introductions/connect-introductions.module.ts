import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Introduction, IntroductionSchema } from './schemas/introduction.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { IntroductionService } from './introduction.service';
import { IntroductionController } from './introduction.controller';
import { AuditModule } from '../../audit/audit.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ConnectProfileModule } from '../profile/connect-profile.module';

/**
 * ManekHR Connect — Introductions module (broker introductions slice).
 *
 * Owns the `Introduction` collection + `IntroductionService` + the
 * `/connect/introductions` controller. Wiring mirrors `ConnectReviewsModule`:
 *   - registers its own `Introduction` schema + `User` (read access: the
 *     live/active/mobile-verified party guard + the populated party identity).
 *   - `AuditModule` for write-event logging; `PostHogService` is `@Global()` so
 *     no PostHog import is needed.
 *   - `NotificationsModule` — the service dispatches best-effort bells on
 *     create / full-confirm.
 *   - `ConnectProfileModule` re-exports `MongooseModule`, which makes the
 *     `ConnectProfile` model available for the `isBroker` creator gate (the same
 *     cross-module read pattern `ConnectNetworkModule` uses for the graph).
 *
 * Nothing imports this module, so it is a LEAF — no cycle. `IntroductionService`
 * is exported for any later read-side consumer.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Introduction.name, schema: IntroductionSchema },
      // Read access: the live-account + mobile-verified party guard, and the
      // populated party identity (name / avatar / handle) on list responses.
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
    NotificationsModule,
    // Re-exports the ConnectProfile model — the broker (`isBroker`) creator gate.
    ConnectProfileModule,
  ],
  controllers: [IntroductionController],
  providers: [IntroductionService],
  exports: [IntroductionService],
})
export class ConnectIntroductionsModule {}
