import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin approve-listing payload (optional reviewer note for the audit trail). */
export class ApproveListingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Admin reject-listing payload. The reason is shown to the listing owner. */
export class RejectListingDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
