import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsArray,
  IsMongoId,
} from 'class-validator';

export const STOCK_MOVEMENT_TYPES = [
  'purchase_in',
  'sale_out',
  'dc_out',
  'so_reserve',
  'so_release',
  'transfer_in',
  'transfer_out',
  'wastage_out',
  'sample_out',
  'sample_return_in',
  'consignment_out',
  'consignment_return_in',
  'opening_stock',
  'grn_in',
  'purchase_return_out',
  'credit_note_in',
  'debit_note_out',
  'manufacturing_in',
  'manufacturing_out',
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export class CreateStockMovementDto {
  @IsMongoId()
  workspaceId: string;

  @IsMongoId()
  firmId: string;

  @IsEnum(STOCK_MOVEMENT_TYPES)
  movementType: StockMovementType;

  @IsMongoId()
  itemId: string;

  @IsMongoId()
  godownId: string;

  @IsOptional()
  @IsMongoId()
  lotId?: string;

  @IsOptional()
  @IsMongoId()
  batchId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serialNos?: string[];

  /** Signed qty: positive = inward, negative = outward (unified sign convention per D-01). */
  @IsNumber()
  qty: number;

  /** Cost of goods per unit in paise. */
  @IsNumber()
  costPaise: number;

  @IsOptional()
  @IsMongoId()
  sourceVoucherId?: string;

  @IsOptional()
  @IsString()
  sourceVoucherType?: string;

  @IsOptional()
  @IsString()
  sourceVoucherNumber?: string;

  @IsOptional()
  @IsString()
  narration?: string;

  /**
   * Default 'stock'. Sample and consignment vouchers override to their bucket.
   * sample/consignment movements do NOT affect Item.qtyOnHand (per D-01).
   */
  @IsOptional()
  @IsEnum(['stock', 'sample', 'consignment'])
  bucketType?: 'stock' | 'sample' | 'consignment';
}
