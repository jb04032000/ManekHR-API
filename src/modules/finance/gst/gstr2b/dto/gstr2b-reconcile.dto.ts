import { IsObject, IsString, Matches } from 'class-validator';

/**
 * Body for POST .../gstr2b/reconcile. Carries the tax period plus the raw GSTN
 * GSTR-2B JSON download. Cross-link: parsed by gstr2b-recon.parseGstr2b, matched
 * against posted PurchaseBills for the same period in Gstr2bService.reconcile.
 * Watch: `twoB` is the GSTN payload verbatim (top-level object that contains
 * `docdata` or is itself the docdata) - we do not constrain its inner shape here;
 * the pure parser is tolerant of missing sections.
 */
export class Gstr2bReconcileDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'period must be MMYYYY format (6 digits, e.g. 042025)' })
  period: string;

  @IsObject()
  twoB: Record<string, unknown>;
}
