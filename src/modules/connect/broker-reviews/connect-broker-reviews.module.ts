import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BrokerReview, BrokerReviewSchema } from './schemas/broker-review.schema';
import { BrokerRating, BrokerRatingSchema } from './schemas/broker-rating.schema';
import { Introduction, IntroductionSchema } from '../introductions/schemas/introduction.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { BrokerReviewService } from './broker-review.service';
import { BrokerReviewController, BrokerReviewPublicController } from './broker-review.controller';
import { AuditModule } from '../../audit/audit.module';
import { ConnectProfileModule } from '../profile/connect-profile.module';

/**
 * ManekHR Connect — Broker Reviews module (verified-but-anonymous, anchored to a
 * confirmed introduction). Owns the `BrokerReview` collection + the denormalized
 * `BrokerRating` aggregate, the write/own-read endpoints (`/connect/broker-reviews`)
 * + the public proof-led broker profile.
 *
 * Wiring mirrors `ConnectIntroductionsModule`:
 *   - registers its own `BrokerReview` + `BrokerRating` schemas;
 *   - registers `Introduction` (read access: the confirmed-introduction party gate
 *     + the live proof counts) and `User` (read access: reviewer names for the
 *     `named` card / anonymous initials);
 *   - `AuditModule` for write-event logging; `PostHogService` is `@Global()` so
 *     no PostHog import is needed;
 *   - `ConnectProfileModule` re-exports `MongooseModule`, making the
 *     `ConnectProfile` model available for the reviewer-city snapshot.
 *
 * Nothing imports this module, so it is a LEAF — no cycle. `BrokerReviewService`
 * is exported for any later read-side consumer (e.g. folding the broker rating
 * into a profile card).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BrokerReview.name, schema: BrokerReviewSchema },
      { name: BrokerRating.name, schema: BrokerRatingSchema },
      // Read access: the confirmed-introduction party gate + live proof counts.
      { name: Introduction.name, schema: IntroductionSchema },
      // Read access: reviewer names (named card) + anonymous initials.
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
    // Re-exports the ConnectProfile model — the reviewer-city snapshot read.
    ConnectProfileModule,
  ],
  controllers: [BrokerReviewController, BrokerReviewPublicController],
  providers: [BrokerReviewService],
  exports: [BrokerReviewService],
})
export class ConnectBrokerReviewsModule {}
