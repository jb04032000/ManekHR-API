import { Module } from '@nestjs/common';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module';
import { GrnModule } from './grn/grn.module';
import { PurchaseBillModule } from './purchase-bill/purchase-bill.module';
import { PaymentOutModule } from './payment-out/payment-out.module';
import { CapitalGoodsItcModule } from './capital-goods-itc/capital-goods-itc.module';
import { PayablesListingModule } from './payables-listing/payables-listing.module';
import { TdsModule } from './tds/tds.module';
// PAUSED 2026-06-06 - OCR Capture (Vendor Bill OCR) held: needs a paid AI/OCR API
// + owner provider decision (Google Document AI / AWS Textract / LLM-vision). The
// ocr/ folder (OcrModule, OcrService, adapters, controller) is kept intact for
// revival; only its registration here is commented out so the
// POST /workspaces/:wsId/finance/ocr/upload-vendor-bill route is not mounted.
// Nothing else injects OcrService, so this is dependency-safe. Manual purchase-bill
// entry is unaffected. Revive via: rg "PAUSED 2026-06-06 . OCR Capture"
// import { OcrModule } from './ocr/ocr.module';

@Module({
  imports: [
    PurchaseOrderModule,
    GrnModule,
    PurchaseBillModule,
    PaymentOutModule,
    CapitalGoodsItcModule,
    PayablesListingModule,
    TdsModule,
    // OcrModule, // PAUSED 2026-06-06 - see note above
  ],
  exports: [
    PurchaseOrderModule,
    GrnModule,
    PurchaseBillModule,
    PaymentOutModule,
    CapitalGoodsItcModule,
    PayablesListingModule,
    TdsModule,
    // OcrModule, // PAUSED 2026-06-06 - see note above
  ],
})
export class PurchasesModule {}
