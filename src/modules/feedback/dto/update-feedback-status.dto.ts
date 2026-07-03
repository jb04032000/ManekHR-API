import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { FEEDBACK_STATUSES, type FeedbackStatus } from '../schemas/feedback.schema';

export class UpdateFeedbackStatusDto {
  @IsEnum(FEEDBACK_STATUSES)
  status: FeedbackStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}
