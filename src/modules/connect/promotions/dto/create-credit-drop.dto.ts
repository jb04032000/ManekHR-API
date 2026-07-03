import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Create a Connect promotional credit drop (M3.2).
 *
 * `targetMode: 'users'` requires a non-empty `userIds`; `targetMode:
 * 'subscribers'` may pass an optional `planId` to narrow to one plan. The
 * service enforces the users-requires-ids rule (a cross-field check class-
 * validator does not express cleanly).
 */
export class CreateCreditDropDto {
  /** Credits to grant each recipient (1 .. 1,000,000). */
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  amountPerUser!: number;

  /** Admin-readable campaign label / reason. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(280)
  note!: string;

  /** Optional ISO-8601 expiry for the granted credits. Omit for no expiry. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /** Who receives the drop. */
  @IsIn(['subscribers', 'users'])
  targetMode!: 'subscribers' | 'users';

  /** Optional single-plan filter for `subscribers` mode. */
  @IsOptional()
  @IsMongoId()
  planId?: string;

  /** Explicit recipients for `users` mode (capped to keep one request bounded). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsMongoId({ each: true })
  userIds?: string[];
}
