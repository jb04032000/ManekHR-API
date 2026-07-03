import {
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateNotificationDto {
  @IsMongoId() @IsNotEmpty() recipientId: string;
  @IsString() @IsNotEmpty() title: string;
  @IsString() @IsNotEmpty() message: string;
  @IsEnum(['info', 'warning', 'success', 'error']) @IsOptional() type?: string;
  @IsObject() @IsOptional() metadata?: any;
}
