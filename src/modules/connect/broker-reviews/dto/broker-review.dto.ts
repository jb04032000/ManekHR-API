import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  BROKER_REVIEW_VISIBILITIES,
  type BrokerReviewVisibility,
} from '../schemas/broker-review.schema';

/**
 * Create or edit (upsert) the caller's review of a broker, anchored to a CONFIRMED
 * introduction. Mirrors `UpsertReviewDto`'s class-validator style. The broker is
 * DERIVED from `introductionId` by the service — never a body field (so a body
 * cannot forge which broker is reviewed).
 */
export class UpsertBrokerReviewDto {
  @IsMongoId()
  introductionId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  /** Anonymous (default) or named opt-in. */
  @IsOptional()
  @IsIn(BROKER_REVIEW_VISIBILITIES)
  visibility?: BrokerReviewVisibility;
}

/** The broker's single reply to a review. */
export class ReplyBrokerReviewDto {
  @IsString()
  @MaxLength(1000)
  text: string;
}

/** Path-param validation for the reply / withdraw routes (id is a Mongo id). */
export class BrokerReviewIdParam {
  @IsMongoId()
  id: string;
}
