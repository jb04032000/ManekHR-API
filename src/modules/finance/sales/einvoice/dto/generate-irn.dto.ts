import { IsOptional, IsString } from 'class-validator';

/**
 * GenerateIrnDto
 *
 * Body for POST /:invoiceId/generate.
 * Invoice ID is supplied via path param, so body is empty for single-invoice route.
 * Optional body kept for future extension (e.g. overrideExemption flag).
 */
export class GenerateIrnDto {
  /** Optional — invoice ID can be in path param OR body. Controller uses path param. */
  @IsOptional()
  @IsString()
  invoiceId?: string;
}
