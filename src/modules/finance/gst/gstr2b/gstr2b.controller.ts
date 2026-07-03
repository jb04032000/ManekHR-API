import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  SubscriptionGuard,
  RequireSubscription,
} from '../../../../common/guards/subscription.guard';
import { AppModule } from '../../../../common/enums/modules.enum';
import { Gstr2bService } from './gstr2b.service';
import { Gstr2bReconcileDto } from './dto/gstr2b-reconcile.dto';

/**
 * Gstr2bController
 *
 * Base path: /workspaces/:wsId/firms/:firmId/gstr2b
 * Guards mirror Gstr1Controller: JwtAuthGuard + RolesGuard + SubscriptionGuard,
 * gated on the gst_compliance subscription feature.
 *
 * POST /reconcile - upload a GSTN GSTR-2B JSON for a period; returns the 4-bucket
 * reconciliation (matched/partial/missing-in-books/missing-in-2B) vs posted purchase
 * bills. Stateless (no upload persisted), read-only on the books -> view permission.
 * Cross-link: Gstr2bService.reconcile + gstr2b-recon pure core.
 */
@ApiTags('Finance - GST')
@Controller('workspaces/:wsId/firms/:firmId/gstr2b')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstr1_filing' })
export class Gstr2bController {
  constructor(private readonly service: Gstr2bService) {}

  @Post('reconcile')
  @RequirePermissions(AppModule.FINANCE, 'view_gst_compliance' as any)
  async reconcile(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() body: Gstr2bReconcileDto,
  ) {
    const data = await this.service.reconcile(wsId, firmId, body.period, body.twoB);
    return { success: true, data };
  }
}
