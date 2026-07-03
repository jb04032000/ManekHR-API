import {
  checkC03Common,
  type CommonCheckDeps,
} from '../../gstr1/checks/common';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-03 — Missing/short HSN codes.
 *
 * Thin re-exporter: delegates to checkC03Common from Plan 12-04 gstr1/checks/common.ts.
 * No logic duplication. Firm.aato compared in Crores (RESEARCH Pitfall 9) inside common.ts.
 */
export async function checkC03(deps: CheckDeps): Promise<VerifyDataFinding[]> {
  const commonDeps: CommonCheckDeps = {
    saleInvoiceModel: deps.saleInvoiceModel,
    creditNoteModel: deps.creditNoteModel,
    debitNoteModel: deps.debitNoteModel,
    firmModel: deps.firmModel,
    partyModel: deps.partyModel,
    wsId: deps.wsId,
    firmId: deps.firmId,
    startDate: deps.startDate,
    endDate: deps.endDate,
    now: deps.now,
  };
  return checkC03Common(commonDeps);
}
