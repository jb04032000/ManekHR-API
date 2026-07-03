import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for "post as a demo account" — a plain text feed post. */
export class PostAsDemoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  body: string;
}
