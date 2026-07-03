import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReminderRuleDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsEnum(['invoice_overdue', 'invoice_due_soon', 'service_maintenance'])
  triggerType: string;

  @IsInt()
  daysOffset: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  escalationLevel?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  cooldownHours?: number;

  @IsOptional()
  @IsBoolean()
  channelInApp?: boolean;

  @IsOptional()
  @IsBoolean()
  channelEmail?: boolean;

  @IsOptional()
  @IsBoolean()
  channelSms?: boolean;

  @IsOptional()
  @IsBoolean()
  channelPush?: boolean;

  @IsOptional()
  @IsBoolean()
  channelWhatsApp?: boolean;

  @IsOptional()
  @IsString()
  emailTemplateKey?: string;

  @IsOptional()
  @IsString()
  smsTemplateKey?: string;

  @IsOptional()
  @IsString()
  whatsAppCampaignName?: string;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateReminderRuleDto extends CreateReminderRuleDto {}

export class ListRulesQueryDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsEnum(['invoice_overdue', 'invoice_due_soon', 'service_maintenance'])
  triggerType?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
