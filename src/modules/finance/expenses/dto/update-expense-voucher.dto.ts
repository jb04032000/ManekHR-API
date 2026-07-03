import { PartialType } from '@nestjs/mapped-types';
import { CreateExpenseVoucherDto } from './create-expense-voucher.dto';

/**
 * All fields from CreateExpenseVoucherDto are optional for updates.
 * Only mutable when voucher state === 'draft'.
 */
export class UpdateExpenseVoucherDto extends PartialType(CreateExpenseVoucherDto) {}
