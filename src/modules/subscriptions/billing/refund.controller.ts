import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { RefundService } from './services/refund.service';
import { RequestRefundDto } from './dto/refund.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve refund (D1h). Customer-initiated refund flow gated by
 * `RefundPolicy.customerSelfServiceEnabled`.
 *
 * Behaviour:
 *   - Within window AND no secondary approval needed → executed
 *     immediately on request, response carries terminal state.
 *   - Out of window OR policy requires secondary approval → returns
 *     a `pending_admin` request; customer is emailed; admin must
 *     approve via admin endpoint to trigger execution.
 *
 * Throttler: `billing-mutate` (10/60s). Refunds are cheap to attempt
 * but expensive to over-issue — same generosity as other write paths.
 */
@LegacyUnclassified()
@Controller('subscriptions/payments')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  @Post(':id/refund-request')
  @Throttle({ 'billing-mutate': { limit: 10, ttl: 60_000 } })
  @Idempotent()
  request(@Req() req: any, @Param('id') paymentId: string, @Body() dto: RequestRefundDto) {
    return this.refunds.requestRefund({
      paymentId,
      userId: req.user.sub,
      amountPaise: dto.amountPaise,
      reason: dto.reason,
    });
  }

  @Get('refund-requests')
  listMine(@Req() req: any) {
    return this.refunds.listMyRequests(req.user.sub);
  }

  @Get('refund-requests/:id')
  fetchMine(@Req() req: any, @Param('id') id: string) {
    return this.refunds.getRequestForUser(id, req.user.sub);
  }
}
