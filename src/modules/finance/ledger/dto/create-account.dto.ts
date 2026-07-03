import { IsString, IsIn, IsOptional } from 'class-validator';

export class CreateAccountDto {
  @IsString() name: string;
  @IsString() code: string;
  @IsOptional() @IsString() group?: string;
  @IsOptional() @IsString() subGroup?: string;
  @IsIn(['asset', 'liability', 'capital', 'income', 'expense']) type: string;
}
