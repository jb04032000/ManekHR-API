import { Injectable, Logger } from '@nestjs/common';

// ─── Posting result ───────────────────────────────────────────────────────────
export interface LedgerPostResult {
  posted: boolean;
  reason?: string;
}

/**
 * SalaryLedgerPostingService — Finance-bridge STUB (2026-07-04).
 *
 * The Finance module was physically removed (owner directive: no use for this
 * business). This service always behaved as "silently skip when no Finance
 * firm is configured" (D-07) — salary payment was NEVER blocked by Finance
 * setup, even before removal. ManekHR never enabled FINANCE in its module
 * preset, so every workspace was ALREADY on this no-firm path; this stub just
 * makes that permanent instead of resolving a firm that can no longer exist.
 *
 * Callers (salary.service.ts) already treat `{ posted: false }` as a normal,
 * non-error outcome — no call-site changes needed.
 */
@Injectable()
export class SalaryLedgerPostingService {
  private readonly logger = new Logger(SalaryLedgerPostingService.name);

  /** Public accessor so salary.service.ts's COA picker endpoint can no-op cleanly. */
  async resolveFirmId(_workspaceId: string): Promise<string | null> {
    return null;
  }

  /** D-10 COA picker: no Finance firm can exist, so no cash/bank accounts. */
  async findCashBankAccounts(
    _workspaceId: string,
  ): Promise<{ accountId: string; code: string; name: string }[]> {
    return [];
  }

  async postSalaryPayment(
    payment: any,
    _salary: any,
    _coaAccountId: string | undefined,
    _userId: string,
  ): Promise<LedgerPostResult> {
    this.logger.debug(
      `Salary ledger posting skipped for payment ${String(payment?._id)} — Finance module not configured`,
    );
    return { posted: false, reason: 'finance_not_configured' };
  }

  async postAdvancePayment(
    payment: any,
    _advanceRequest: any,
    _coaAccountId: string | undefined,
    _userId: string,
  ): Promise<LedgerPostResult> {
    this.logger.debug(
      `Advance ledger posting skipped for payment ${String(payment?._id)} — Finance module not configured`,
    );
    return { posted: false, reason: 'finance_not_configured' };
  }

  async postSalaryReversal(_payment: any, _userId: string): Promise<LedgerPostResult> {
    return { posted: false, reason: 'finance_not_configured' };
  }

  async postAdvanceReversal(_payment: any, _userId: string): Promise<LedgerPostResult> {
    return { posted: false, reason: 'finance_not_configured' };
  }
}
