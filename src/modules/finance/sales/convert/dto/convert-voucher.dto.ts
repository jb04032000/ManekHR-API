import { IsArray, IsIn, IsMongoId, IsString } from 'class-validator';

export type ConvertSourceType = 'quotation' | 'sale_order' | 'proforma' | 'delivery_challan';
export type ConvertTargetType = 'sale_order' | 'proforma' | 'delivery_challan' | 'sale_invoice';

export class ConvertVoucherDto {
  @IsIn(['quotation', 'sale_order', 'proforma', 'delivery_challan'])
  sourceType: ConvertSourceType;

  @IsArray()
  @IsMongoId({ each: true })
  sourceIds: string[];

  @IsIn(['sale_order', 'proforma', 'delivery_challan', 'sale_invoice'])
  targetType: ConvertTargetType;
}
