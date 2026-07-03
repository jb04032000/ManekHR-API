import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpsertReminderTemplateDto {
  @IsEnum(['in_app', 'email', 'sms', 'push', 'whatsapp'])
  channel: string;

  @IsEnum(['invoice_overdue', 'invoice_due_soon', 'service_maintenance', 'final_notice'])
  eventType: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @MaxLength(5000)
  body: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
