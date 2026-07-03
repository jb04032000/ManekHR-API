import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RecurringExpenseTemplate,
  RecurringExpenseTemplateSchema,
} from './recurring-expense-template.schema';
import { RecurringExpenseTemplateService } from './recurring-expense-template.service';
import { RecurringExpenseTemplateController } from './recurring-expense-template.controller';
import { RecurringExpenseCron } from './recurring-expense.cron';
import { ExpensesModule } from '../expenses.module';

// ScheduleModule.forRoot() is registered in SalaryModule — not duplicated here
// (Pitfall 3). @Cron works as long as it is present anywhere in the tree.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RecurringExpenseTemplate.name, schema: RecurringExpenseTemplateSchema },
    ]),
    ExpensesModule,
  ],
  controllers: [RecurringExpenseTemplateController],
  providers: [RecurringExpenseTemplateService, RecurringExpenseCron],
  exports: [RecurringExpenseTemplateService],
})
export class RecurringExpenseModule {}
