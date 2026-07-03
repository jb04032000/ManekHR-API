import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import * as Sentry from '@sentry/nestjs';
import { Attendance } from '../../attendance/schemas/attendance.schema';
import { Salary } from '../../salary/schemas/salary.schema';
import { SaleInvoice } from '../../finance/sales/sale-invoice/sale-invoice.schema';
import { ExpenseVoucher } from '../../finance/expenses/expense-voucher.schema';
import { WorkspaceMember } from '../../workspaces/schemas/workspace-member.schema';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { ConnectProfile } from './schemas/connect-profile.schema';

/**
 * Window, in days, over which a workspace's ERP activity is counted to
 * decide the "ERP-linked" badge. Design-decisions doc §9.1.
 */
export const ERP_LINK_ACTIVITY_WINDOW_DAYS = 30;

/**
 * Days of total ERP inactivity after which a previously ERP-linked workspace
 * silently loses the badge. Design-decisions doc §9.1 ("Status decays after
 * 60 days of inactivity — silent, no penalty, just no badge").
 */
export const ERP_LINK_DECAY_DAYS = 60;

/** Activity thresholds — meeting ANY one of these earns the badge (§9.1). */
export const ERP_LINK_THRESHOLDS = {
  /** ≥ 5 attendance entries in the activity window. */
  attendance: 5,
  /** ≥ 1 payroll run in the activity window. */
  payrollRuns: 1,
  /** ≥ 3 invoices + expenses in the activity window. */
  invoices: 3,
} as const;

/** Raw activity counts for a workspace within the configured window. */
export interface ErpLinkSignals {
  /** Attendance entries created in the activity window. */
  attendance: number;
  /**
   * Distinct payroll runs in the activity window. A "payroll run" is a
   * distinct `(month, year)` for which `Salary` documents were generated
   * inside the window — this ERP has no separate `PayrollRun` collection.
   */
  payrollRuns: number;
  /**
   * Non-draft, non-cancelled sale invoices + expense vouchers created in the
   * activity window.
   */
  invoices: number;
}

/** The derived ERP-linked status for a workspace. */
export interface ErpLinkStatus {
  /** True when the workspace currently earns the ERP-linked badge. */
  linked: boolean;
  /**
   * Approx. date the workspace's ERP activity began — the earliest of the
   * first attendance / salary / invoice / expense document. `null` when the
   * workspace has no ERP activity at all. Powers the trust panel's "ERP
   * active since [date]" copy (design-decisions doc §9.3).
   */
  since: Date | null;
  /** The raw counts the verdict was derived from. */
  signals: ErpLinkSignals;
}

/**
 * Derives the "ERP-linked" moat signal for a workspace — the single most
 * important trust signal in ManekHR Connect (design-decisions doc §9).
 *
 * The badge is **derived, never stored** (`IDENTITY-MODEL.md`): this service
 * computes it live from real ERP activity collections. It reads only — it
 * never writes ERP data, and it never exposes operational rows (the privacy
 * wall): callers receive counts + a boolean, nothing more.
 *
 * Rule (design-decisions doc §9.1):
 *   ERP-linked = in the last 30 days the workspace logged
 *     ≥ 5 attendance entries, OR ≥ 1 payroll run, OR ≥ 3 invoices/expenses.
 *   The status decays after 60 days of total inactivity.
 *
 * The decay is naturally implied by the 30-day window — if the last activity
 * was > 30 days ago every count is 0 and `linked` is false. The explicit
 * 60-day check exists so that a caller can distinguish a workspace that has
 * *decayed* (was once linked, now silent ≥ 60 days) from one that simply
 * hasn't crossed a threshold yet; it also short-circuits the per-signal
 * queries for long-dormant workspaces.
 */
@Injectable()
export class ErpLinkService {
  private readonly logger = new Logger(ErpLinkService.name);
  private readonly tracer = trace.getTracer('connect.erp-link');

  constructor(
    @InjectModel(Attendance.name)
    private readonly attendanceModel: Model<Attendance>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    @InjectModel(SaleInvoice.name)
    private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(ExpenseVoucher.name)
    private readonly expenseVoucherModel: Model<ExpenseVoucher>,
    @InjectModel(WorkspaceMember.name)
    private readonly workspaceMemberModel: Model<WorkspaceMember>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    /**
     * The person's `ConnectProfile` — read ONLY to enforce the consent gate
     * (ADR-0004 / 2026-06-18 spec). `getUserStatus` returns `{ linked: false }`
     * unless `erpVerificationConsent.status === 'granted'`, so no ERP activity
     * is read and no badge is shown without explicit opt-in. Read-only here.
     */
    @InjectModel(ConnectProfile.name)
    private readonly connectProfileModel: Model<ConnectProfile>,
  ) {}

  /**
   * The "From your ERP" callout summary for a workspace OWNER (design doc
   * §9.4) — the active-karigar headcount + this month's payroll for the
   * workspace they own. `owner: false` when the user owns no workspace (the
   * callout simply does not render). Read-only; degrades to an empty summary
   * on any error — the callout is a trust *enhancement*, never load-bearing.
   *
   * `Salary.netSalary` is stored in rupees; the callout component wants paise,
   * so the summed total is scaled by 100.
   */
  async getErpSummary(
    userId: string | Types.ObjectId,
    now: Date = new Date(),
  ): Promise<{ owner: boolean; karigarCount: number; payrollPaise: number }> {
    return this.withSpan('connect.erp-link.getErpSummary', { userId: String(userId) }, async () => {
      const empty = { owner: false, karigarCount: 0, payrollPaise: 0 };
      try {
        const workspace = await this.workspaceModel
          .findOne({ ownerId: this.toObjectId(userId) })
          .select('_id')
          .lean<{ _id: Types.ObjectId }>()
          .exec();
        if (!workspace) return empty;

        const [karigarCount, payrollAgg] = await Promise.all([
          this.workspaceMemberModel
            .countDocuments({ workspaceId: workspace._id, status: 'active' })
            .exec(),
          this.salaryModel
            .aggregate<{ total: number }>([
              {
                $match: {
                  workspaceId: workspace._id,
                  month: now.getMonth() + 1,
                  year: now.getFullYear(),
                },
              },
              { $group: { _id: null, total: { $sum: '$netSalary' } } },
            ])
            .exec(),
        ]);

        const totalRupees = payrollAgg[0]?.total ?? 0;
        return { owner: true, karigarCount, payrollPaise: Math.round(totalRupees * 100) };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `ErpLinkService.getErpSummary failed for user ${String(userId)} — ${detail}`,
        );
        Sentry.captureException(err, { tags: { module: 'connect.erp-link', op: 'getErpSummary' } });
        return empty;
      }
    });
  }

  /**
   * Compute the ERP-linked status for one workspace.
   *
   * Read-only. On any unexpected error the verdict degrades to "not linked"
   * with zeroed signals rather than throwing — the ERP-linked badge is a
   * trust *enhancement*; a transient DB hiccup must never break the Connect
   * profile that renders it. The error is logged + reported to Sentry.
   *
   * @param workspaceId the workspace whose activity is evaluated.
   * @param now         injectable clock for deterministic testing; defaults
   *                    to the wall clock.
   */
  async getWorkspaceStatus(
    workspaceId: string | Types.ObjectId,
    now: Date = new Date(),
  ): Promise<ErpLinkStatus> {
    return this.withSpan(
      'connect.erp-link.getWorkspaceStatus',
      { workspaceId: String(workspaceId) },
      async (span) => {
        const wsObjectId = this.toObjectId(workspaceId);
        const windowStart = this.daysAgo(now, ERP_LINK_ACTIVITY_WINDOW_DAYS);
        const decayCutoff = this.daysAgo(now, ERP_LINK_DECAY_DAYS);

        try {
          // ── 60-day decay short-circuit ──────────────────────────────────
          // If the workspace has had NO ERP activity of any kind since the
          // decay cutoff, it is not linked and we can skip the per-signal
          // window queries entirely. `since` is also the earliest-activity
          // probe, so this single call does double duty.
          const since = await this.findFirstActivityDate(wsObjectId);
          const lastActivity = await this.findLastActivityDate(wsObjectId);

          if (lastActivity === null || lastActivity < decayCutoff) {
            // Never active, or silent for ≥ 60 days → decayed / unlinked.
            const result: ErpLinkStatus = {
              linked: false,
              since,
              signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
            };
            span.setAttributes({ linked: false, decayed: lastActivity !== null });
            return result;
          }

          // ── Per-signal counts within the 30-day activity window ─────────
          const [attendance, payrollRuns, invoices] = await Promise.all([
            this.countAttendance(wsObjectId, windowStart),
            this.countPayrollRuns(wsObjectId, windowStart),
            this.countInvoices(wsObjectId, windowStart),
          ]);

          const signals: ErpLinkSignals = { attendance, payrollRuns, invoices };
          const linked =
            attendance >= ERP_LINK_THRESHOLDS.attendance ||
            payrollRuns >= ERP_LINK_THRESHOLDS.payrollRuns ||
            invoices >= ERP_LINK_THRESHOLDS.invoices;

          span.setAttributes({
            linked,
            'signal.attendance': attendance,
            'signal.payrollRuns': payrollRuns,
            'signal.invoices': invoices,
          });

          return { linked, since, signals };
        } catch (err) {
          // Degrade gracefully — a trust badge must not break the profile.
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `ErpLinkService.getWorkspaceStatus failed for workspace ${String(
              workspaceId,
            )} — defaulting to not-linked. Error: ${detail}`,
          );
          Sentry.captureException(err, {
            tags: { module: 'connect.erp-link', op: 'getWorkspaceStatus' },
          });
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
          return this.unlinkedStatus();
        }
      },
    );
  }

  /**
   * Compute the ERP-linked status for a **user** — derived from their
   * EMPLOYMENT, not from any field on their `ConnectProfile`.
   *
   * Connect is a standalone product: a `ConnectProfile` is Person-scoped and
   * carries no workspace reference. A user's ERP-linked context therefore comes
   * from where they actually work — their active `WorkspaceMember` rows. This
   * method resolves every `{ userId, status: 'active' }` membership, runs the
   * existing per-workspace `getWorkspaceStatus` derivation for each, and folds
   * the results into a single verdict.
   *
   * Combine rule (documented):
   *   - `linked`  — true if ANY employing workspace is currently ERP-linked.
   *   - `since`   — the EARLIEST non-null `since` among the LINKED workspaces.
   *                 (When the user is not linked anywhere, `since` is `null` —
   *                 the public surface only ever shows "active since" for a
   *                 user who currently earns the badge.)
   *   - `signals` — the per-signal counts SUMMED across the linked workspaces.
   *                 Summing (rather than picking the single most-active
   *                 workspace) is deliberate: it gives a faithful picture of
   *                 the user's total ERP footprint, and it is fully
   *                 deterministic — no arbitrary tie-break when two workspaces
   *                 are equally active. Only linked workspaces contribute, so
   *                 a dormant employer cannot dilute the signal. The raw
   *                 `signals` never cross the privacy wall — the public
   *                 controller returns `{ linked, since }` only.
   *
   * Read-only. Like `getWorkspaceStatus`, this degrades gracefully: any
   * unexpected error resolves to the unlinked default rather than throwing —
   * the ERP-linked badge is a trust *enhancement* and must never break the
   * Connect profile that renders it.
   *
   * @param userId the user whose employment-derived ERP status is evaluated.
   * @param now    injectable clock for deterministic testing; defaults to the
   *               wall clock. Forwarded to each `getWorkspaceStatus` call.
   */
  async getUserStatus(
    userId: string | Types.ObjectId,
    now: Date = new Date(),
  ): Promise<ErpLinkStatus> {
    return this.withSpan(
      'connect.erp-link.getUserStatus',
      { userId: String(userId) },
      async (span) => {
        try {
          // ── Consent gate (ADR-0004 / 2026-06-18 spec) ──────────────────────
          // No ERP data is read and no badge is shown until the subject explicitly
          // opts in. Unless their ConnectProfile carries
          // `erpVerificationConsent.status === 'granted'`, short-circuit to the
          // unlinked default BEFORE any employment / ERP-activity query. Consent
          // is the gate — there is no separate feature flag.
          const consented = await this.hasUserConsented(userId);
          if (!consented) {
            span.setAttributes({ consented: false, linked: false });
            return this.unlinkedStatus();
          }
          span.setAttribute('consented', true);

          // Resolve the user's active employment — one verdict per employer.
          const memberships = await this.workspaceMemberModel
            .find({ userId: this.toObjectId(userId), status: 'active' })
            .select('workspaceId')
            .lean<Array<{ workspaceId: Types.ObjectId }>>()
            .exec();

          span.setAttribute('workspaceCount', memberships.length);

          if (memberships.length === 0) {
            // No active employment → no ERP-linked context at all.
            span.setAttribute('linked', false);
            return this.unlinkedStatus();
          }

          // Derive each employing workspace's status with the existing
          // per-workspace path (its own OTel child span attaches automatically).
          const statuses = await Promise.all(
            memberships.map((m) => this.getWorkspaceStatus(m.workspaceId, now)),
          );

          const linkedStatuses = statuses.filter((s) => s.linked);
          const linked = linkedStatuses.length > 0;

          // `since` — earliest non-null among the linked workspaces only.
          const sinceCandidates = linkedStatuses
            .map((s) => s.since)
            .filter((d): d is Date => d instanceof Date);
          const since =
            sinceCandidates.length === 0
              ? null
              : sinceCandidates.reduce((earliest, d) => (d < earliest ? d : earliest));

          // `signals` — summed across the linked workspaces.
          const signals: ErpLinkSignals = linkedStatuses.reduce<ErpLinkSignals>(
            (acc, s) => ({
              attendance: acc.attendance + s.signals.attendance,
              payrollRuns: acc.payrollRuns + s.signals.payrollRuns,
              invoices: acc.invoices + s.signals.invoices,
            }),
            { attendance: 0, payrollRuns: 0, invoices: 0 },
          );

          span.setAttributes({
            linked,
            linkedWorkspaceCount: linkedStatuses.length,
            'signal.attendance': signals.attendance,
            'signal.payrollRuns': signals.payrollRuns,
            'signal.invoices': signals.invoices,
          });

          return { linked, since, signals };
        } catch (err) {
          // Degrade gracefully — a trust badge must not break the profile.
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `ErpLinkService.getUserStatus failed for user ${String(
              userId,
            )} — defaulting to not-linked. Error: ${detail}`,
          );
          Sentry.captureException(err, {
            tags: { module: 'connect.erp-link', op: 'getUserStatus' },
          });
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
          return this.unlinkedStatus();
        }
      },
    );
  }

  /**
   * Consent-gated wrapper around `getWorkspaceStatus` for ENTITY reads
   * (CompanyPage / Storefront) — ADR-0004 / 2026-06-18 spec. Returns the empty
   * unlinked status unless the entity's own `erpLink.status === 'verified'`.
   * The link consent lives on the entity (an owner consented when they linked,
   * via the ownership-checked `linkErpWorkspace`); a revoked / absent link, or a
   * dangling `erpWorkspaceId` left by a cascade race, never reads ERP activity.
   *
   * `signature` of `getWorkspaceStatus` is intentionally unchanged: the gate is
   * applied here so existing internal callers (and the per-workspace owner panel)
   * keep their direct, ungated path. Read-only.
   *
   * @param entity the CompanyPage / Storefront whose link is evaluated.
   * @param now    injectable clock forwarded to `getWorkspaceStatus`.
   */
  async getConsentedWorkspaceStatus(
    entity: {
      erpWorkspaceId?: Types.ObjectId | string | null;
      erpLink?: { status?: string } | null;
    } | null,
    now: Date = new Date(),
  ): Promise<ErpLinkStatus> {
    // Gate: the badge is shown ONLY when the owner's link consent is live AND a
    // workspace pointer is present. An entity created/linked before this feature
    // (no `erpLink`) reads as not-verified → no badge until the owner re-links
    // through the consented path (intended; pre-launch, no real linked entities).
    if (!entity || entity.erpLink?.status !== 'verified' || !entity.erpWorkspaceId) {
      return this.unlinkedStatus();
    }
    return this.getWorkspaceStatus(entity.erpWorkspaceId, now);
  }

  /**
   * Whether the user has live ERP-verification consent on their ConnectProfile
   * (`erpVerificationConsent.status === 'granted'`). Read-only; degrades to
   * `false` (no badge) on any read fault — the safe default is "not consented".
   */
  private async hasUserConsented(userId: string | Types.ObjectId): Promise<boolean> {
    try {
      const profile = await this.connectProfileModel
        .findOne({ userId: this.toObjectId(userId) })
        .select('erpVerificationConsent')
        .lean<{ erpVerificationConsent?: { status?: string } | null }>()
        .exec();
      return profile?.erpVerificationConsent?.status === 'granted';
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ErpLinkService.hasUserConsented read failed for user ${String(userId)} — treating as not consented. ${detail}`,
      );
      return false;
    }
  }

  // ── Per-signal queries ─────────────────────────────────────────────────

  /**
   * Signal 1 — count `Attendance` documents created in the window.
   * Threshold: ≥ 5 (`ERP_LINK_THRESHOLDS.attendance`).
   */
  private async countAttendance(workspaceId: Types.ObjectId, windowStart: Date): Promise<number> {
    return this.attendanceModel
      .countDocuments({
        workspaceId,
        createdAt: { $gte: windowStart },
      })
      .exec();
  }

  /**
   * Signal 2 — count distinct payroll runs generated in the window.
   *
   * This ERP has no `PayrollRun` collection: payroll is a batch of `Salary`
   * documents, one per team member per `(month, year)`. A "payroll run" is
   * therefore a distinct `(month, year)` for which at least one `Salary`
   * document was *created* (generated) inside the window. Counted via an
   * aggregation `$group`. Threshold: ≥ 1 (`ERP_LINK_THRESHOLDS.payrollRuns`).
   */
  private async countPayrollRuns(workspaceId: Types.ObjectId, windowStart: Date): Promise<number> {
    const groups = await this.salaryModel
      .aggregate<{
        _id: { month: number; year: number };
      }>([
        { $match: { workspaceId, createdAt: { $gte: windowStart } } },
        { $group: { _id: { month: '$month', year: '$year' } } },
      ])
      .exec();
    return groups.length;
  }

  /**
   * Signal 3 — count sale invoices + expense vouchers created in the window.
   *
   * Only **`state: 'posted'`** documents count. §9.1 defines the moat as
   * "real operational data … not a self-claim" — so the filter is a positive
   * allow-list of the one *committed* state, not a `$nin` blocklist of the
   * known non-committed ones. This matters two ways:
   *   - It excludes `draft` AND `pending_approval` (a `SaleInvoice` that has
   *     been entered but not yet approved is not finalized operational
   *     activity — `SaleInvoiceService` itself only treats `posted` invoices
   *     as real revenue, e.g. its ledger / outstanding queries). It also
   *     excludes `cancelled` / `void`.
   *   - It is forward-safe: a future enum addition (a new pre-posting state)
   *     stays excluded automatically, whereas a `$nin` blocklist would
   *     silently start leaking it into the moat signal.
   * Soft-deleted sale invoices are excluded too (`isDeleted`). Threshold:
   * ≥ 3 (`ERP_LINK_THRESHOLDS.invoices`), summed across both collections.
   *
   * The `saleinvoices` collection's `voucherType` enum also permits
   * `quotation` / `sale_order` / `proforma` / `delivery_challan` (those
   * voucher types each have their own dedicated collection too, but the
   * shared schema leaves the door open). §9.1 counts *invoices*, so this
   * query is pinned to `voucherType: 'sale_invoice'` — matching how
   * `SaleInvoiceService` itself scopes every query on this collection — so a
   * stray non-invoice voucher cannot inflate the moat signal.
   */
  private async countInvoices(workspaceId: Types.ObjectId, windowStart: Date): Promise<number> {
    const [saleInvoices, expenses] = await Promise.all([
      this.saleInvoiceModel
        .countDocuments({
          workspaceId,
          voucherType: 'sale_invoice',
          createdAt: { $gte: windowStart },
          state: 'posted',
          isDeleted: { $ne: true },
        })
        .exec(),
      this.expenseVoucherModel
        .countDocuments({
          workspaceId,
          createdAt: { $gte: windowStart },
          state: 'posted',
        })
        .exec(),
    ]);
    return saleInvoices + expenses;
  }

  // ── Activity-span probes (for `since` + decay) ─────────────────────────

  /**
   * Earliest `createdAt` across all four ERP activity collections for the
   * workspace — i.e. when the factory's ERP track record began. Powers the
   * trust panel's "ERP active since [date]" copy. `null` when the workspace
   * has no ERP activity at all.
   */
  private async findFirstActivityDate(workspaceId: Types.ObjectId): Promise<Date | null> {
    return this.findActivityBoundary(workspaceId, 'asc');
  }

  /**
   * Latest `createdAt` across all four ERP activity collections — used for
   * the 60-day decay check. `null` when the workspace has no ERP activity.
   */
  private async findLastActivityDate(workspaceId: Types.ObjectId): Promise<Date | null> {
    return this.findActivityBoundary(workspaceId, 'desc');
  }

  /**
   * Shared earliest/latest-`createdAt` probe across all four collections.
   * `direction: 'asc'` → earliest; `'desc'` → latest. Each collection is
   * probed with a single indexed `findOne` (1-document sort), then the
   * boundary is reduced across the (≤ 4) candidates.
   */
  private async findActivityBoundary(
    workspaceId: Types.ObjectId,
    direction: 'asc' | 'desc',
  ): Promise<Date | null> {
    const sortValue = direction === 'asc' ? 1 : -1;
    const sort: Record<string, 1 | -1> = { createdAt: sortValue };

    const [att, sal, inv, exp] = await Promise.all([
      this.attendanceModel
        .findOne({ workspaceId })
        .select('createdAt')
        .sort(sort)
        .lean<{ createdAt?: Date }>()
        .exec(),
      this.salaryModel
        .findOne({ workspaceId })
        .select('createdAt')
        .sort(sort)
        .lean<{ createdAt?: Date }>()
        .exec(),
      this.saleInvoiceModel
        .findOne({ workspaceId, isDeleted: { $ne: true } })
        .select('createdAt')
        .sort(sort)
        .lean<{ createdAt?: Date }>()
        .exec(),
      this.expenseVoucherModel
        .findOne({ workspaceId })
        .select('createdAt')
        .sort(sort)
        .lean<{ createdAt?: Date }>()
        .exec(),
    ]);

    const dates: Date[] = [att, sal, inv, exp]
      .map((doc) => doc?.createdAt)
      .filter((d): d is Date => d instanceof Date);

    if (dates.length === 0) return null;

    return dates.reduce((boundary, d) => {
      if (direction === 'asc') return d < boundary ? d : boundary;
      return d > boundary ? d : boundary;
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
  }

  /**
   * The "not ERP-linked" verdict — no badge, no `since`, zeroed signals. The
   * single canonical default returned by both derivations on the no-activity /
   * no-employment / graceful-degradation paths.
   */
  private unlinkedStatus(): ErpLinkStatus {
    return {
      linked: false,
      since: null,
      signals: { attendance: 0, payrollRuns: 0, invoices: 0 },
    };
  }

  /** Returns the instant `days` days before `from`. */
  private daysAgo(from: Date, days: number): Date {
    return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  }

  /**
   * OpenTelemetry span wrapper — mirrors `WorkspacesService.withWorkspaceSpan`.
   * Span attributes carry only ids / counts / booleans, never raw PII.
   */
  private async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
