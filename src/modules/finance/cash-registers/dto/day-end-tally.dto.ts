import { Type } from 'class-transformer';
import { IsArray, IsInt, Min, ValidateNested } from 'class-validator';

export class DenominationCountDto {
  /** Valid Indian currency denomination: 2000, 500, 200, 100, 50, 20, 10, 5, 2, 1 */
  @IsInt()
  @Min(1)
  denomination!: number;

  @IsInt()
  @Min(0)
  count!: number;
}

export class DayEndTallyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DenominationCountDto)
  denominationBreakdown!: DenominationCountDto[];
}
