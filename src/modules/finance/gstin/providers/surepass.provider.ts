import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { env } from '../../../../config/env';
import { GstinInfo, GstinProviderAdapter } from '../gstin-provider.interface';
import type {
  GstinFilingPeriod,
  GstinFilingStatus,
  GstinReturnKind,
} from '../../party-intelligence/gstin-monitor/filing-status.types';

/**
 * Structured GSTIN provider error. Caller (cron) catches by class name
 * and treats `auth` subclass as a loud-warn (key/SKU misconfiguration).
 */
export class GstinProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GstinProviderError';
  }
}
export class GstinProviderAuthError extends GstinProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GstinProviderAuthError';
  }
}

/** Map SurePass DD-MM-YYYY → Date. Returns null on parse failure. */
function parseDDMMYYYY(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  if (Number.isNaN(d) || Number.isNaN(mo) || Number.isNaN(y)) return null;
  return new Date(y, mo - 1, d);
}

/** Map MMYYYY tax_period → 'MM-YYYY'. */
function formatPeriod(taxPeriod: string): string {
  if (!taxPeriod || taxPeriod.length < 6) return taxPeriod ?? '';
  return `${taxPeriod.slice(0, 2)}-${taxPeriod.slice(2)}`;
}

const RETURN_MAP: Record<string, GstinReturnKind> = {
  GSTR1: 'GSTR-1',
  GSTR3B: 'GSTR-3B',
  GSTR9: 'GSTR-9',
};

@Injectable()
export class SurepassProvider implements GstinProviderAdapter {
  private readonly logger = new Logger(SurepassProvider.name);
  // Optional BYOK key set per-firm by callers (F-12-02 BYOK pattern).
  private firmGspKey: string | null = null;

  /**
   * F-12-02 BYOK pattern — caller wraps:
   *   provider.setFirmGspKey(key);
   *   try { ... } finally { provider.setFirmGspKey(null); }
   */
  setFirmGspKey(key: string | null): void {
    this.firmGspKey = key;
  }

  async fetchByGstin(gstin: string, apiKey?: string): Promise<GstinInfo> {
    const key = apiKey ?? env.surepass.apiKey;
    if (!key) {
      throw new ServiceUnavailableException('SUREPASS_NOT_CONFIGURED');
    }

    let response: Response;
    try {
      response = await fetch(
        `https://kyc-api.surepass.io/api/v1/gst/gst-to-pan?id=${encodeURIComponent(gstin)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'network error';
      throw new InternalServerErrorException(`GSTIN lookup failed: ${msg}`);
    }

    if (!response.ok) {
      throw new InternalServerErrorException(`Surepass HTTP ${response.status}`);
    }

    type SurepassGstResponse = {
      data?: {
        legal_name?: string;
        trade_name?: string;
        state?: string;
        gstin?: string;
        principal_place_of_business?: string;
        date_of_registration?: string;
        status?: string;
      };
    };
    const body = (await response.json()) as SurepassGstResponse;
    const d = body.data;
    if (!d) throw new InternalServerErrorException('Invalid Surepass response');

    return {
      legalName: d.legal_name ?? d.trade_name ?? '',
      tradeName: d.trade_name,
      state: d.state ?? '',
      stateCode: d.gstin?.slice(0, 2) ?? gstin.slice(0, 2),
      address: d.principal_place_of_business,
      registrationDate: d.date_of_registration,
      status: this.mapStatus(d.status ?? ''),
    };
  }

  private mapStatus(raw: string): GstinInfo['status'] {
    const s = raw.toLowerCase();
    if (s.includes('cancel')) return 'cancelled';
    if (s.includes('suspend')) return 'suspended';
    if (s.includes('provision')) return 'provisional';
    return 'active';
  }

  /**
   * Phase 17 / FIN-16-02 D-10 — Fetch filing-status periods for a GSTIN.
   *
   * Endpoint contract documented (and currently UNVERIFIED) at
   * `.planning/phases/17-party-intelligence-crm/17-SUREPASS-SPIKE.md`.
   *
   * Behaviour:
   *   - `SUREPASS_FILING_STUB=true`           → returns `[]` (manual-recheck-only)
   *   - missing key                            → ServiceUnavailableException
   *   - HTTP 401/403                          → throws GstinProviderAuthError
   *   - HTTP 5xx / network                    → throws GstinProviderError
   *   - HTTP 200 + valid envelope             → mapped, sorted-asc, capped to `periods`
   *
   * Sanitises: never logs the API key. BYOK key (`firmGspKey`) takes priority
   * over per-call apiKey, then `SUREPASS_FILING_API_KEY`, then `SUREPASS_API_KEY`.
   */
  async fetchFilingStatus(gstin: string, periods = 6): Promise<GstinFilingPeriod[]> {
    if (env.surepass.filingStub) {
      return [];
    }

    const key = this.firmGspKey ?? env.surepass.filingApiKey ?? env.surepass.apiKey;
    if (!key) {
      throw new ServiceUnavailableException('SUREPASS_NOT_CONFIGURED');
    }

    let response: Response;
    try {
      response = await fetch(
        `https://kyc-api.surepass.io/api/v1/gst/return-track?gstin=${encodeURIComponent(gstin)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'network error';
      throw new GstinProviderError(`SurePass network failure: ${msg}`, err);
    }

    if (response.status === 401 || response.status === 403) {
      throw new GstinProviderAuthError(
        `SurePass auth failed (HTTP ${response.status}) — verify API key + filing-status SKU`,
      );
    }
    if (response.status === 404) {
      // Treat 404 as "no filings on record" — not a failure.
      return [];
    }
    if (!response.ok) {
      throw new GstinProviderError(`SurePass HTTP ${response.status}`);
    }

    type SurepassFilingResponse = { data?: { filing_status?: unknown[] } };
    let body: SurepassFilingResponse;
    try {
      body = (await response.json()) as SurepassFilingResponse;
    } catch (err) {
      throw new GstinProviderError('SurePass response not JSON', err);
    }

    const filings: unknown[] = Array.isArray(body.data?.filing_status)
      ? body.data.filing_status
      : [];

    const mapped: GstinFilingPeriod[] = filings
      .map((d: unknown) => this.mapFilingRow(d))
      .filter((p): p is GstinFilingPeriod => p !== null);

    // Sort ascending by period (MM-YYYY → Date for sort).
    mapped.sort((a, b) => {
      const [am, ay] = a.period.split('-').map((n) => parseInt(n, 10));
      const [bm, by] = b.period.split('-').map((n) => parseInt(n, 10));
      const ad = new Date(ay, am - 1, 1).getTime();
      const bd = new Date(by, bm - 1, 1).getTime();
      return ad - bd;
    });

    // Cap to the requested count, taking the most-recent N.
    const capped = mapped.slice(-Math.max(1, periods));
    return capped;
  }

  private mapFilingRow(d: unknown): GstinFilingPeriod | null {
    if (!d || typeof d !== 'object') return null;
    const row = d as {
      return_type?: string;
      tax_period?: string | number;
      due_date?: string;
      date_of_filing?: string;
      status?: string;
    };
    const returnKind = row.return_type ? RETURN_MAP[row.return_type] : null;
    if (!returnKind) return null;
    const period = formatPeriod(String(row.tax_period ?? ''));
    if (!period) return null;
    const dueDate = parseDDMMYYYY(row.due_date) ?? new Date(0);
    const filedDate = parseDDMMYYYY(row.date_of_filing);
    const filed = String(row.status ?? '').toLowerCase() === 'filed';
    const status: GstinFilingStatus = filed
      ? 'FILED'
      : Date.now() > dueDate.getTime()
        ? 'OVERDUE'
        : 'NOT_FILED';
    return { return: returnKind, period, dueDate, filedDate, status };
  }
}
