import type { GstinFilingPeriod } from '../party-intelligence/gstin-monitor/filing-status.types';

export interface GstinInfo {
  legalName: string;
  tradeName?: string;
  state: string;
  stateCode: string;
  address?: string;
  registrationDate?: string;
  status: 'active' | 'cancelled' | 'suspended' | 'provisional';
}

export interface GstinProviderAdapter {
  fetchByGstin(gstin: string): Promise<GstinInfo>;

  /**
   * Phase 17 / FIN-16-02 D-10 — Fetch filing-status periods for a GSTIN.
   *
   * Returns up to `periods` most-recent filing periods across GSTR-1 and
   * GSTR-3B. Wave-1 plan 03 implements the SurePass mapping; spike doc at
   * `.planning/phases/17-party-intelligence-crm/17-SUREPASS-SPIKE.md` documents
   * the endpoint contract. If unverified, plan 03 ships behind the
   * `SUREPASS_FILING_STUB` env flag returning [].
   */
  fetchFilingStatus(gstin: string, periods?: number): Promise<GstinFilingPeriod[]>;
}
