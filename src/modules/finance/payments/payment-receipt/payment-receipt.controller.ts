import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { PaymentReceiptService } from './payment-receipt.service';
import { CreatePaymentReceiptDto } from './dto/create-payment-receipt.dto';

@ApiTags('Finance - Banking')
@Controller('workspaces/:wsId/finance/firms/:firmId/payments/receipts')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'payments_payment_in' })
export class PaymentReceiptController {
  constructor(private readonly paymentReceiptService: PaymentReceiptService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreatePaymentReceiptDto,
    @CurrentUser() user: any,
  ) {
    return this.paymentReceiptService.createDraft(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() query: any) {
    return this.paymentReceiptService.list(wsId, firmId, query);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.paymentReceiptService.findOne(wsId, firmId, id);
  }

  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @CurrentUser() user: any,
  ) {
    return this.paymentReceiptService.postPaymentReceipt(
      wsId,
      firmId,
      id,
      user._id ?? user.sub,
      idempotencyKey,
    );
  }

  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.paymentReceiptService.cancel(wsId, firmId, id, user._id ?? user.sub, body.reason);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  voidDraft(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.paymentReceiptService.cancel(wsId, firmId, id, user._id ?? user.sub, 'voided');
  }
}
