import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ApiTags } from '@nestjs/swagger';
import { PurchaseBillService } from './purchase-bill.service';
import { PurchaseBillPolicyService } from './purchase-bill-policy.service';
import { CreatePurchaseBillDto } from './dto/create-purchase-bill.dto';

@ApiTags('Finance - Purchases')
@Controller('workspaces/:wsId/finance/firms/:firmId/purchases/bills')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_invoicing' })
export class PurchaseBillController {
  constructor(
    private readonly service: PurchaseBillService,
    // OQ-FB-5: resolves the maker-checker / four-eyes exemption (Owner / HR).
    private readonly policy: PurchaseBillPolicyService,
  ) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreatePurchaseBillDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createDraft(wsId, firmId, dto, user._id ?? user.sub);
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  list(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Query() query: any) {
    return this.service.list(wsId, firmId, query);
  }

  @Get(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(@Param('wsId') wsId: string, @Param('firmId') firmId: string, @Param('id') id: string) {
    return this.service.findOne(wsId, firmId, id);
  }

  @Patch(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() dto: any,
    @CurrentUser() user: any,
  ) {
    return this.service.updateDraft(wsId, firmId, id, dto, user._id ?? user.sub);
  }

  @Post(':id/post')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  async post(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @CurrentUser() user: any,
  ) {
    const userId = user._id ?? user.sub;
    // OQ-FB-5: resolve the four-eyes exemption (Owner / HR) before posting. The
    // service skips the self-post block when exempt OR when the firm toggle is
    // off (default). Cheap; owner short-circuits.
    const isExempt = await this.policy.isExemptFromMakerChecker(wsId, userId);
    return this.service.post(wsId, firmId, id, userId, idempotencyKey, isExempt);
  }

  @Post(':id/cancel')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  cancel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(wsId, firmId, id, user._id ?? user.sub, body?.reason);
  }

  @Delete(':id')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  delete(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.softDelete(wsId, firmId, id, user._id ?? user.sub);
  }
}
