import { IsString, IsIn, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class CreateCashRegisterDto {
  @IsString() name: string;
  @IsOptional() @IsIn(['main', 'petty_cash']) type?: string;
  @IsOptional() @IsNumber() imprestAmount?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
