import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import {
  RequirePermissions,
  RolesGuard,
} from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { BarcodeService, LabelSize } from './barcode.service';

@Controller('workspaces/:wsId/finance/firms/:firmId/inventory/items/:itemId/label')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.INVENTORY, subFeature: 'barcode' })
export class BarcodeController {
  constructor(private readonly service: BarcodeService) {}

  /**
   * GET /workspaces/:wsId/finance/firms/:firmId/inventory/items/:itemId/label
   * Returns a PDF buffer with barcode + QR labels in the requested size.
   * D-09 LOCKED: PDF generated via jsPDF + bwip-js (NOT pdfkit).
   * D-16: 5 label sizes supported: 20x10, 30x20, 38x25, 50x30, a4_sheet
   */
  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @Header('Content-Type', 'application/pdf')
  async getLabel(
    @Param('wsId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('itemId') itemId: string,
    @Query('labelSize') labelSize: string = '38x25',
    @Query('lotId') lotId?: string,
    @Query('batchId') batchId?: string,
    @Query('copies') copies?: string,
    @Res() res?: Response,
  ) {
    const validSizes: LabelSize[] = ['20x10', '30x20', '38x25', '50x30', 'a4_sheet'];
    if (!validSizes.includes(labelSize as LabelSize)) {
      throw new BadRequestException(
        `Invalid labelSize '${labelSize}'. Valid: ${validSizes.join(', ')}`,
      );
    }

    const buf = await this.service.generateLabelPdf(wsId, firmId, itemId, {
      labelSize: labelSize as LabelSize,
      lotId,
      batchId,
      copies: copies ? parseInt(copies, 10) : 1,
    });

    res.setHeader('Content-Disposition', `inline; filename="label-${itemId}.pdf"`);
    res.send(buf);
  }
}
