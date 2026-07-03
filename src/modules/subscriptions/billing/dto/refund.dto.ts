import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RequestRefundDto {
  /**
   * Amount to refund in paise. Omit for a full refund of the
   * remaining balance (totalPaise minus prior refunds).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class AdminDirectRefundDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsIn(['normal', 'optimum'])
  speed?: 'normal' | 'optimum';

  @IsOptional()
  @IsBoolean()
  bypassWindow?: boolean;
}

export class ApproveRefundDto {
  @IsOptional()
  @IsIn(['normal', 'optimum'])
  speed?: 'normal' | 'optimum';
}

export class RejectRefundDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class RefundListQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

// ── RefundPolicy admin DTO ───────────────────────────────────────────

export class UpdateRefundPolicyDto {
  @IsOptional()
  @IsBoolean()
  customerSelfServiceEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  eligibleWithinDays?: number;

  @IsOptional()
  @IsBoolean()
  allowPartial?: boolean;

  @IsOptional()
  @IsBoolean()
  requireSecondAdminApprovalAfterWindow?: boolean;

  @IsOptional()
  @IsBoolean()
  autoDowngradeOnFullRefund?: boolean;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => String)
  reasons?: string[];
}
