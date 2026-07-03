import { PartialType } from '@nestjs/mapped-types';
import { CreateRecurringExpenseDto } from './create-recurring-expense.dto';

export class UpdateRecurringExpenseDto extends PartialType(CreateRecurringExpenseDto) {}
