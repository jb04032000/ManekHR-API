import { IsMongoId, IsString, Matches, MinLength } from 'class-validator';

export class ReopenFyDto {
  @IsMongoId()
  fyId: string;

  @IsString()
  @MinLength(10)
  reason: string;

  @Matches(/^REOPEN$/)
  confirmation: string;
}
