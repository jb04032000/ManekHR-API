import { IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { INTRODUCTION_ROLES, type IntroductionRole } from '../schemas/introduction.schema';

/**
 * Create an introduction. Mirrors `UpsertReviewDto`'s class-validator style
 * (`@IsMongoId` for user ids, `@IsOptional`/`@IsString`/`@MaxLength` for free
 * text). The broker is the caller (`req.user.sub`) — never a body field.
 *
 * `roleOfA` is partyA's role; the service derives `roleOfLow` from the canonical
 * ordering (if partyA is the low party, `roleOfLow = roleOfA`, else the opposite).
 */
export class CreateIntroductionDto {
  @IsMongoId()
  partyAUserId: string;

  @IsMongoId()
  partyBUserId: string;

  @IsIn(INTRODUCTION_ROLES)
  roleOfA: IntroductionRole;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Path-param validation for the confirm / decline routes (id is a Mongo id). */
export class IntroductionIdParam {
  @IsMongoId()
  id: string;
}
