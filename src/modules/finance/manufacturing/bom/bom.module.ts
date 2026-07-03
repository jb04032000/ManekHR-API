import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BomDefinition, BomDefinitionSchema } from './bom.schema';
import { Item, ItemSchema } from '../../items/item.schema';
import {
  ManufacturingVoucher,
  ManufacturingVoucherSchema,
} from '../manufacturing-vouchers/manufacturing-voucher.schema';
import { BomService } from './bom.service';
import { BomController } from './bom.controller';
import { SubscriptionsModule } from '../../../subscriptions/subscriptions.module';
import { WorkspacesModule } from '../../../workspaces/workspaces.module';

/**
 * BomModule — provides BomService for BoM CRUD, explosion, and standard-cost.
 *
 * ManufacturingVoucher schema is registered here (not imported from
 * ManufacturingVouchersModule) to avoid a circular module-level dependency:
 *   BomModule → ManufacturingVouchersModule → BomModule
 *
 * MongooseModule.forFeature is schema-only and does not create a module-level
 * cycle; Mongoose deduplicates the collection registration at runtime.
 * BomService.delete() uses @InjectModel('ManufacturingVoucher') for BOM_IN_USE
 * checks. The token 'ManufacturingVoucher' resolves to the same collection
 * regardless of which module registers the schema.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BomDefinition.name, schema: BomDefinitionSchema },
      { name: Item.name, schema: ItemSchema },
      { name: ManufacturingVoucher.name, schema: ManufacturingVoucherSchema },
    ]),
    SubscriptionsModule,
    WorkspacesModule,
  ],
  controllers: [BomController],
  providers: [BomService],
  exports: [BomService],
})
export class BomModule {}
