import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class DisposeAssetDto {
  @IsDateString()
  disposalDate: string;

  @IsNumber()
  @Min(0)
  disposalProceedsPaise: number;

  /** Required when disposalProceedsPaise > 0 (e.g. '1001' cash, '1002' bank). */
  @IsString()
  @IsOptional()
  cashOrBankAccountCode?: string;

  @IsEnum(['sale', 'scrap', 'writeoff'])
  disposalType: 'sale' | 'scrap' | 'writeoff';

  @IsString()
  @IsOptional()
  narration?: string;

  /** Must be true when ItcReversalService.computeReversal returns applicable=true. */
  @IsBoolean()
  @IsOptional()
  acknowledgeItcReversal?: boolean;
}
