import {
  IsString,
  IsDate,
  IsNumber,
  IsArray,
  IsOptional,
  IsEnum,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PaymentAllocationDto {
  @IsString() invoiceId: string;
  @IsString() invoiceNumber: string;
  @IsNumber() @Min(0) invoiceDuePaise: number;
  @IsNumber() @Min(1) allocatedPaise: number;
}

export class CreatePaymentReceiptDto {
  @IsString() financialYear: string;
  @Type(() => Date) @IsDate() receiptDate: Date;
  @IsString() partyId: string;
  @IsEnum(['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'razorpay', 'cashfree'])
  paymentMode: string;
  @IsOptional() @IsString() bankAccountId?: string;
  @IsOptional() @IsString() referenceNo?: string;
  @IsOptional() @Type(() => Date) @IsDate() referenceDate?: Date;
  @IsNumber() @Min(1) totalAmountPaise: number;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations: PaymentAllocationDto[];
  @IsOptional() @IsString() brokerPartyId?: string;
  @IsOptional() @IsString() onlinePaymentId?: string;
  @IsOptional() @IsEnum(['razorpay', 'cashfree']) onlinePaymentGateway?: string;
}
