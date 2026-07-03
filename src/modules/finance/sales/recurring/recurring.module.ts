import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RecurringInvoiceTemplate,
  RecurringInvoiceTemplateSchema,
} from './recurring-template.schema';
import { RecurringInvoiceTemplateService } from './recurring-template.service';
import { RecurringTemplateController } from './recurring-template.controller';
import { RecurringInvoiceCron } from './recurring.cron';
import { SaleInvoiceModule } from '../sale-invoice/sale-invoice.module';

// NOTE: ScheduleModule.forRoot() is intentionally NOT imported here.
// It is already registered in SalaryModule — duplicating it causes NestJS
// to throw "The module X has already been declared" errors (Pitfall 3).
// The @Cron decorator works as long as ScheduleModule.forRoot() is present
// anywhere in the application module tree.

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: RecurringInvoiceTemplate.name,
        schema: RecurringInvoiceTemplateSchema,
      },
    ]),
    SaleInvoiceModule,
  ],
  controllers: [RecurringTemplateController],
  providers: [RecurringInvoiceTemplateService, RecurringInvoiceCron],
  exports: [RecurringInvoiceTemplateService],
})
export class RecurringModule {}
