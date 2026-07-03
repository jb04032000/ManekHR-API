import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCallTodoDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsMongoId()
  partyId: string;

  @IsOptional()
  @IsMongoId()
  invoiceId?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  invoiceIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  totalOverdueAmountPaise?: number;

  @IsOptional()
  @IsEnum(['payment_followup', 'sales_followup', 'service_reminder', 'other'])
  callType?: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high', 'urgent'])
  priority?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsMongoId()
  assignedTo: string;
}

export class UpdateCallTodoDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  totalOverdueAmountPaise?: number;

  @IsOptional()
  @IsEnum(['payment_followup', 'sales_followup', 'service_reminder', 'other'])
  callType?: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high', 'urgent'])
  priority?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsMongoId()
  assignedTo?: string;

  @IsOptional()
  @IsEnum(['pending', 'in_progress', 'done', 'snoozed', 'cancelled'])
  status?: string;
}

export class SnoozeCallTodoDto {
  @IsInt()
  @Min(1)
  @Max(30)
  days: number;
}

export class CompleteCallTodoDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  completionNote?: string;
}

export class ListCallTodosQueryDto {
  @IsOptional()
  @IsEnum(['pending', 'in_progress', 'done', 'snoozed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsMongoId()
  assignedTo?: string;

  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high', 'urgent'])
  priority?: string;
}
