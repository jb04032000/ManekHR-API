import { IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Create or edit (upsert) the caller's review of a seller/person. */
export class UpsertReviewDto {
  @IsMongoId()
  subjectUserId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}
