import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateBillDto {
  @IsEnum(['payable', 'receivable']) type: string;
  @IsString() @IsNotEmpty() partyName: string;
  @IsNumber() @IsNotEmpty() amount: number;
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() invoiceUrl?: string;
  @IsDateString() @IsNotEmpty() dueDate: string;
}

export class UpdateBillDto {
  @IsString() @IsOptional() partyName?: string;
  @IsNumber() @IsOptional() amount?: string;
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() invoiceUrl?: string;
  @IsDateString() @IsOptional() dueDate?: string;
}

export class RecordBillPaymentDto {
  @IsNumber() @IsNotEmpty() amount: number;
  @IsDateString() @IsNotEmpty() paymentDate: string;
  @IsString() @IsOptional() note?: string;
  @IsEnum(['cash', 'bank_transfer', 'upi', 'cheque', 'other'])
  paymentMode: string;
}
