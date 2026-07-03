import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { AuditLogService } from './services/audit-log.service';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

class AuditQueryDto {
  @IsOptional()
  @IsMongoId()
  actorUserId?: string;

  @IsOptional()
  @IsMongoId()
  targetUserId?: string;

  @IsOptional()
  @IsMongoId()
  subscriptionId?: string;

  @IsOptional()
  @IsMongoId()
  paymentId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsIn(['admin', 'self', 'system', 'webhook'])
  actorType?: 'admin' | 'self' | 'system' | 'webhook';

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Admin audit-log query (D1k).
 *
 * Single endpoint with multi-key filtering. Indexes on the audit
 * collection cover the common access patterns:
 *   - per target user (e.g. "show me everything that happened to
 *     customer X")
 *   - per actor user (e.g. "show me everything admin Y did")
 *   - per subscription / payment
 *   - per action type
 *   - per date range (used in combination with the above for
 *     window-bounded queries)
 *
 * Append-only — there is intentionally no PATCH/DELETE on audit
 * events. Compliance requirement.
 */
@LegacyUnclassified()
@Controller('admin/billing/audit')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class AuditAdminController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  query(@Query() q: AuditQueryDto) {
    return this.audit.query({
      actorUserId: q.actorUserId,
      targetUserId: q.targetUserId,
      subscriptionId: q.subscriptionId,
      paymentId: q.paymentId,
      action: q.action,
      actorType: q.actorType,
      dateFrom: q.dateFrom ? new Date(q.dateFrom) : undefined,
      dateTo: q.dateTo ? new Date(q.dateTo) : undefined,
      limit: q.limit,
      offset: q.offset,
    });
  }
}
