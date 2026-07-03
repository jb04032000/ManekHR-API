import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PurchaseBill,
  PurchaseBillSchema,
} from '../../purchases/purchase-bill/purchase-bill.schema';
import { Gstr2bService } from './gstr2b.service';
import { Gstr2bController } from './gstr2b.controller';

/**
 * Gstr2bModule - GSTR-2B (ITC) reconciliation.
 *
 * Provides Gstr2bService (parse uploaded 2B + match vs posted purchase bills) and
 * Gstr2bController (POST /reconcile). Registers PurchaseBill (the books side).
 * Cross-link: aggregated by GstModule alongside Gstr1Module/Gstr3bModule.
 * Stateless - no new schema; reconciliation is computed on demand.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: PurchaseBill.name, schema: PurchaseBillSchema }])],
  providers: [Gstr2bService],
  controllers: [Gstr2bController],
  exports: [Gstr2bService],
})
export class Gstr2bModule {}
