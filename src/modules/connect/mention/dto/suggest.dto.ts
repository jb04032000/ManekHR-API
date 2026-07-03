import { IsOptional, IsString, MaxLength, MinLength, IsIn } from 'class-validator';

export const MENTION_SCOPES = ['all', 'people', 'companies', 'storefronts'] as const;
export type MentionScope = (typeof MENTION_SCOPES)[number];

export class SuggestQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  q: string;

  @IsOptional()
  @IsIn(MENTION_SCOPES)
  scope?: MentionScope;
}
