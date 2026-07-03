import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Review, ReviewSchema } from './schemas/review.schema';
import { SellerRating, SellerRatingSchema } from './schemas/seller-rating.schema';
import { ReviewService } from './review.service';
import { ReviewController, ReviewPublicController } from './review.controller';
import { AuditModule } from '../../audit/audit.module';
import { User, UserSchema } from '../../users/schemas/user.schema';

/**
 * ManekHR Connect — Reviews & Ratings module (marketplace Phase C). Owns the
 * `Review` + denormalized `SellerRating` aggregate, the write/own-read endpoints
 * (`/connect/reviews`) + the public seller-reviews list. `ReviewService` is
 * exported so the profile / company / marketplace reads can fold the aggregate
 * into their cards (R2).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Review.name, schema: ReviewSchema },
      { name: SellerRating.name, schema: SellerRatingSchema },
      // Registered for read access only: the public list populates the
      // reviewer's viewer-facing identity (name / avatar / handle).
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
  ],
  controllers: [ReviewController, ReviewPublicController],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class ConnectReviewsModule {}
