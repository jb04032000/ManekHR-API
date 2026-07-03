import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PaymentsQueryService } from './services/payments-query.service';
import { ListPaymentsQueryDto } from './dto/payments.dto';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

/**
 * Self-serve read-only listing of the caller's SubscriptionPayment rows.
 * Powers the web Invoices + Payment History tabs (D2).
 *
 * Note: invoice metadata + download stay on InvoiceController
 * (`subscriptions/payments/:id/invoice[/download|/regenerate]`) — this
 * controller only ships the list endpoint.
 */
@LegacyUnclassified()
@Controller('subscriptions/payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsQuery: PaymentsQueryService) {}

  @Get()
  list(@Req() req: any, @Query() query: ListPaymentsQueryDto) {
    return this.paymentsQuery.listForUser(req.user.sub, query);
  }
}
