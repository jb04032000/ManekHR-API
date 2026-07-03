import { IsBoolean } from 'class-validator';

export class AnomalyRuleToggleDto {
  @IsBoolean()
  enabled: boolean;
}
