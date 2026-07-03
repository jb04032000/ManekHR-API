import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../common/guards/admin.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { RefundService } from './services/refund.service';
import { RefundPolicyService } from './services/refund-policy.service';
import {
  AdminDirectRefundDto,
  ApproveRefundDto,
  RefundListQueryDto,
  RejectRefundDto,
  UpdateRefundPolicyDto,
} from './dto/refund.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin refund management (D1h). Three responsibilities:
 *   - Pending-queue review: list + approve/reject self-serve requests
 *     awaiting secondary approval.
 *   - Direct refund issuance: refund a payment without prior customer
 *     request (proactive goodwill / billing error correction).
 *   - RefundPolicy CRUD: tune the runtime rules.
 *
 * Locked under `JwtAuthGuard + IsAdminGuard`. Throttler `billing-mutate`
 * (10/60s) on writes. All writes accept `Idempotency-Key` header.
 */
@LegacyUnclassified()
@Controller('admin/billing')
@UseGuards(JwtAuthGuard, IsAdminGuard, ThrottlerGuard)
export class RefundAdminController {
  constructor(
    private readonly refunds: RefundService,
    private readonly policy: RefundPolicyService,
  ) {}

  // ── refund queue + actions ──────────────────────────────────────────

  @Get('refund-requests/pending')
  listPending(@Query() query: RefundListQueryDto) {
    return this.refunds.listPending(query.limit ?? 50, query.offset ?? 0);
  }

  @Post('refund-requests/:id/approve')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  approve(@Req() req: any, @Param('id') id: string, @Body() dto: ApproveRefundDto) {
    return this.refunds.approveRequest({
      requestId: id,
      adminUserId: req.user.sub,
      speed: dto.speed,
    });
  }

  @Post('refund-requests/:id/reject')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  reject(@Req() req: any, @Param('id') id: string, @Body() dto: RejectRefundDto) {
    return this.refunds.rejectRequest({
      requestId: id,
      adminUserId: req.user.sub,
      reason: dto.reason,
    });
  }

  @Post('payments/:id/refund')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  directRefund(@Req() req: any, @Param('id') paymentId: string, @Body() dto: AdminDirectRefundDto) {
    return this.refunds.directRefund({
      paymentId,
      adminUserId: req.user.sub,
      amountPaise: dto.amountPaise,
      reason: dto.reason,
      speed: dto.speed,
      bypassWindow: dto.bypassWindow,
    });
  }

  // ── policy CRUD ─────────────────────────────────────────────────────

  @Get('refund-policy')
  fetchPolicy() {
    return this.policy.getPolicy();
  }

  @Patch('refund-policy')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  updatePolicy(@Req() req: any, @Body() dto: UpdateRefundPolicyDto) {
    return this.policy.upsert(dto, req.user.sub);
  }
}
