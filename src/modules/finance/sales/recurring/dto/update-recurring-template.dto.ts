import { PartialType } from '@nestjs/mapped-types';
import { CreateRecurringTemplateDto } from './create-recurring-template.dto';

export class UpdateRecurringTemplateDto extends PartialType(CreateRecurringTemplateDto) {}
