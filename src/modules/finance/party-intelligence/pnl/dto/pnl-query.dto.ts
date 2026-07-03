/**
 * Phase 17 / FIN-16-04 — Party P&L query DTO.
 *
 * Validates ?from=&to= ISO-8601 dates and enforces the D-25 hard cap of 5
 * years per request. Out-of-window queries return HTTP 400 BadRequest via
 * Nest's ValidationPipe (no aggregation cost). Default period (current
 * FY-to-date) is computed in the controller, not here, so a missing param
 * pair is valid.
 */
import {
  IsISO8601,
  IsOptional,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000; // ≥ 5 calendar years

/**
 * Runs against `to` field; checks `to >= from` and `to - from <= 5 years`.
 * Skips validation when either field is missing — `from`/`to` are optional
 * (controller fills defaults). Both must be present for the cap to apply.
 */
export function IsValidPnlDateRange(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsValidPnlDateRange',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(toValue: unknown, args: ValidationArguments) {
          const dto = args.object as { from?: string; to?: string };
          // Either side missing → controller fills defaults; allow.
          if (typeof dto.from !== 'string' || typeof toValue !== 'string') {
            return true;
          }
          const fromDate = new Date(dto.from);
          const toDate = new Date(toValue);
          if (
            Number.isNaN(fromDate.getTime()) ||
            Number.isNaN(toDate.getTime())
          ) {
            return false;
          }
          if (toDate < fromDate) return false;
          const spanMs = toDate.getTime() - fromDate.getTime();
          return spanMs <= FIVE_YEARS_MS;
        },
        defaultMessage() {
          return 'to must be >= from and within 5 years of from (D-25 cap)';
        },
      },
    });
  };
}

export class PnlQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  @IsValidPnlDateRange()
  to?: string;
}
