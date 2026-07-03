/**
 * Phase 17 / FIN-16-01 D-09 + FIN-16-05 D-29 + FIN-16-02 D-11 — settings DTO.
 *
 * Body for PATCH /workspaces/:wsId/settings/party-intelligence.
 *
 * Three nested namespaces (all optional — caller patches whichever changes):
 *   - rfmTuning: numeric thresholds for the 4 RFM-segment knobs (D-09)
 *   - greetings: master-on/off + per-channel sub-toggles (D-29)
 *   - gstinPollCadenceDays: 1..30 (D-11; default 7)
 *
 * class-validator min/max enforced (T-17-W1C-02 RFM threshold-injection
 * mitigation).
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class RfmTuningDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  newWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  vipRfmFloor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  dormantMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  dormantMax?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  churnedCutoff?: number;
}

export class GreetingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsapp?: boolean;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RfmTuningDto)
  rfmTuning?: RfmTuningDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GreetingsDto)
  greetings?: GreetingsDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  gstinPollCadenceDays?: number;
}
