import {
  BadRequestException,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../../common/guards/roles.guard';
import {
  RequireSubscription,
  SubscriptionGuard,
} from '../../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../../common/enums/modules.enum';
import { OcrService } from './ocr.service';

@Controller('workspaces/:wsId/finance/ocr')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'purchases_ocr' })
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  @Post('upload-vendor-bill')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadVendorBill(
    @Param('wsId') wsId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file required (multipart field name: file)');
    }
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException(`Unsupported mimeType: ${file.mimetype}`);
    }
    return this.ocrService.extractVendorBill(file.buffer, file.mimetype);
  }
}
