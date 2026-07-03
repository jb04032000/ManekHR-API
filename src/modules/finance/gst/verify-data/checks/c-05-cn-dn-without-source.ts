import {
  checkC05Common,
  type CommonCheckDeps,
} from '../../gstr1/checks/common';
import type { CheckDeps } from './index';
import type { VerifyDataFinding } from '../verify-data.schema';

/**
 * C-05 — Credit/Debit Notes without sourceInvoiceId.
 *
 * Thin re-exporter: delegates to checkC05Common from Plan 12-04 gstr1/checks/common.ts.
 * No logic duplication.
 */
export async function checkC05(deps: CheckDeps): Promise<VerifyDataFinding[]> {
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
  return checkC05Common(commonDeps);
}
