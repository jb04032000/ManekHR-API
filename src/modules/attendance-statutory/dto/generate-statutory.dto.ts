import {
  IsEnum, IsDateString, IsOptional, IsNumber, IsArray, IsMongoId,
  Min, Max, registerDecorator, ValidationOptions, ValidationArguments,
} from 'class-validator';

export enum StatutoryTemplate {
  MH_FORM_T = 'mh_form_t',
  FORM_25_OT = 'form_25_ot',
  PF_ESI_WAGE = 'pf_esi_wage',
  LOP_AUDIT = 'lop_audit',
  GJ_FORM_D = 'gj_form_d',
}

/** Runs against `to` field; checks `to >= from` and `to - from <= 366 days`. */
function IsValidStatutoryDateRange(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsValidStatutoryDateRange',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(toValue: unknown, args: ValidationArguments) {
          const dto = args.object as { from?: string; to?: string };
          if (typeof dto.from !== 'string' || typeof toValue !== 'string') return false;
          const fromDate = new Date(dto.from);
          const toDate = new Date(toValue);
          if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return false;
          if (toDate < fromDate) return false;
          const days = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
          return days <= 366;
        },
        defaultMessage() {
          return 'to must be >= from and within 366 days of from';
        },
      },
    });
  };
}

export class GenerateStatutoryDto {
  @IsEnum(StatutoryTemplate)
  template: StatutoryTemplate;

  @IsDateString()
  from: string;

  @IsDateString()
  @IsValidStatutoryDateRange()
  to: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  memberScope?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  customDailyRate?: number;
}
