import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class CreateAccountantInviteDto {
  @IsEmail() email: string;
  @IsOptional() @IsIn(['read_only', 'adjusting_entry']) scopeRole?: string;
}
