/**
 * Cron Job Constants
 * Centralized cron schedule definitions
 * All cron jobs should use these constants for consistency
 */

export const CRON_SCHEDULES = {
  EVERY_HOUR: '0 * * * *',
  EVERY_DAY_AT_MIDNIGHT: '0 0 * * *',
  EVERY_DAY_AT_00_05_UTC: '5 0 * * *',
  PAYROLL_AUTO_GENERATE_SCHEDULE: '15 0 * * *',
  EVERY_DAY_AT_MIDNIGHT_IST: '30 0 * * *', // Midnight IST = 18:30 UTC
  EVERY_DAY_AT_2_30_UTC: '30 2 * * *',
  // Uploads storage-orphan reconcile (report-only). 04:15 UTC keeps it clear of
  // the 03:00 ads reconcile and the 02:30 stale-session close.
  EVERY_DAY_AT_4_15_UTC: '15 4 * * *',
  // Connect over-limit reconcile (grace-clock + once-per-episode notice). 04:45
  // UTC keeps it clear of the 04:15 uploads reconcile and the ads crons.
  EVERY_DAY_AT_4_45_UTC: '45 4 * * *',
  // ERP member-cap reconcile (grace-clock + once-per-episode over-cap notice).
  // 05:00 UTC keeps it clear of the 04:45 Connect over-limit reconcile.
  EVERY_DAY_AT_5_00_UTC: '0 5 * * *',
  EVERY_WEEK: '0 0 * * 0',
  EVERY_MONTH: '0 0 1 * *',
  EVERY_15_MINUTES: '*/15 * * * *',
  REMINDER_DISPATCHER: '30 7 * * *', // 07:30 IST daily
  SAMPLE_ALARM: '30 3 * * *', // 03:30 UTC = 09:00 IST — sample voucher alarm dispatcher (F-09 D-07)
  // Phase 17 Plan 01 — Party Intelligence crons. Hourly registration; per-workspace
  // tz filter happens inside the handler (research §Pattern 1: @Cron timezone is
  // class-load static, so we use one hourly cron + Intl.DateTimeFormat per-ws filter).
  RFM_SEGMENTER: '0 * * * *', // hourly — handler filters by per-ws tz local hour === 2
  GSTIN_MONITOR: '0 * * * 0', // hourly on Sundays — handler filters by per-ws tz local hour === 3
  GREETINGS_DISPATCH: '0 * * * *', // hourly — handler filters by per-ws tz local hour === 9
  // Phase 24 — Maintenance crons (D-04, RESEARCH §15). IST timezone applied per-cron.
  MAINTENANCE_COUNTER_REFRESH: '0 2 * * *', // 02:00 IST daily — refresh hours/output cached counters
  MAINTENANCE_NOTIFICATIONS: '0 6 * * *', // 06:00 IST daily — create due notifications (deduped per workspaceId+scheduleId+dueOn)
  // Leave epic L2a (2026-05-16) — daily leave-accrual sweep.
  LEAVE_ACCRUAL: '0 1 * * *', // 01:00 IST daily — post upfront + periodic leave credits
  // Leave epic L2b (2026-05-16) — comp-off expiry + year-end close.
  LEAVE_COMP_OFF_EXPIRY: '0 3 * * *', // 03:00 IST daily — expire comp-off lots
  LEAVE_YEAR_END: '0 2 * * *', // 02:00 IST daily — leave year-end close (Jan window only)
  // Attendance defaulter alert (2026-05-17) — monthly on the 1st at 06:00 IST.
  MONTHLY_1ST_AT_6AM: '0 6 1 * *', // 06:00 IST on the 1st of each month
} as const;

export const CRON_TIMEZONES = {
  UTC: 'UTC',
  IST: 'Asia/Kolkata',
} as const;

export enum CronJobKey {
  SESSION_CLEANUP = 'session_cleanup',
  OFFBOARD_CRON = 'offboard_cron',
  SCHEDULED_SUBSCRIPTIONS = 'scheduled_subscriptions',
  EXPIRED_ADDONS = 'expired_addons',
  AUTO_PRESENT = 'auto_present',
  PAYROLL_AUTO_GENERATE = 'payroll_auto_generate',
  ANOMALY_MISSED_STREAK = 'anomaly_missed_streak',
  AUTO_CLOSE_STALE = 'auto_close_stale',
  REMINDER_DISPATCHER = 'reminder_dispatcher',
  SAMPLE_ALARM = 'sample_alarm',
  // Phase 17 Plan 01 — Party Intelligence crons (Wave 1 plans implement handlers).
  RFM_SEGMENTER = 'rfm.segmenter',
  GSTIN_MONITOR = 'gstin.monitor',
  GREETINGS_DISPATCH = 'greetings.dispatch',
  // Phase 24 — Maintenance crons (D-04, RESEARCH §15).
  MAINTENANCE_COUNTER_REFRESH = 'maintenance.counter_refresh',
  MAINTENANCE_NOTIFICATIONS = 'maintenance.notifications',
  // P2.6 (2026-05-15) — hourly sweep of expired WorkspaceMember invite
  // rows. Fires INVITE_EXPIRED notifications to grantor + invitee (if
  // userId bound) and stamps `expiryNotifiedAt` to dedup.
  INVITE_EXPIRY_SWEEP = 'invite.expiry_sweep',
  // Leave epic L2a (2026-05-16) — daily accrual sweep: posts upfront +
  // periodic leave credits for every active member.
  LEAVE_ACCRUAL = 'leave.accrual',
  // Leave epic L2b (2026-05-16) — comp-off lot expiry + annual year-end close.
  LEAVE_COMP_OFF_EXPIRY = 'leave.comp_off_expiry',
  LEAVE_YEAR_END = 'leave.year_end',
  // Attendance defaulter alert (2026-05-17) — monthly sweep of prior-month
  // attendance defaulters; fires notifications to HR/Manager.
  DEFAULTER_ALERT = 'defaulter_alert',
  // Connect feed trending refresh (scheduler hardening 2026-06-04) — every 15
  // min, rebuilds the materialized connect_trending set via convergent upsert.
  CONNECT_TRENDING_REFRESH = 'connect.trending_refresh',
  // D4 billing marketing crons (scheduler hardening 2026-06-04) — message-
  // idempotent via MarketingCampaignDispatch unique anchorKey; single-flight
  // wrapped so a tick fires once across workers.
  BILLING_TRIAL_REMINDER = 'billing.trial_reminder',
  BILLING_RENEWAL_NOTICE = 'billing.renewal_notice',
  BILLING_WIN_BACK = 'billing.win_back',
  BILLING_ABANDONED_CHECKOUT = 'billing.abandoned_checkout',
  // Salary commission dispatch (scheduler hardening 2026-06-04) — monthly; money-
  // idempotent per (schedule, month, year) via CommissionSchedule.disbursementLog.
  COMMISSION_DISPATCH = 'commission.dispatch',
  // Finance posting crons (scheduler hardening 2026-06-04). Strong guards:
  // late-fee (LateFeeEntry unique {invoice, date}), loan-emi (LoanEmiRun unique
  // {firm, loan, month}), depreciation (DepreciationRun unique {firm, month, type}).
  // Cursor-guarded (nextRunAt / nextAmortisationMonth advance): recurring expense
  // + invoice + capital-goods ITC.
  FINANCE_LATE_FEE = 'finance.late_fee_accrual',
  FINANCE_LOAN_EMI = 'finance.loan_emi',
  FINANCE_DEPRECIATION = 'finance.depreciation',
  FINANCE_RECURRING_EXPENSE = 'finance.recurring_expense',
  FINANCE_RECURRING_INVOICE = 'finance.recurring_invoice',
  FINANCE_CAPITAL_GOODS_ITC = 'finance.capital_goods_itc',
  // Subscription + Connect monetization crons (scheduler hardening 2026-06-04).
  SUBSCRIPTION_EXPIRE_STALE = 'subscription.expire_stale',
  CONNECT_INCLUDED_CREDITS = 'connect.included_credits_grant',
  // Finance notification/alarm crons (scheduler hardening 2026-06-04).
  FINANCE_JW_PENDING_ALARM = 'finance.jw_pending_alarm',
  FINANCE_GST_VERIFY_DATA = 'finance.gst_verify_data',
  // Remaining Tier A crons (scheduler hardening 2026-06-04).
  MSG91_BALANCE_POLL = 'sms.msg91_balance_poll',
  ATTENDANCE_UNASSIGNED_DIGEST = 'attendance.unassigned_digest',
  ADDONS_CREDIT_CHECKS = 'addons.credit_checks',
  // Tier B materialization crons (scheduler hardening 2026-06-04) — double-run
  // wastes work or throws dup-key, no money/message side effect. Idempotent via
  // convergent recompute/upsert or predicate state-flip; single-flight wrapped.
  CONNECT_TRENDING_TAGS = 'connect.trending_tags',
  ADS_ROLLUP = 'connect.ads_rollup',
  ADS_RECONCILE = 'connect.ads_reconcile',
  ADS_PACING = 'connect.ads_pacing',
  // Tier C cleanup crons (scheduler hardening 2026-06-04) — naturally idempotent
  // predicate deletes/sweeps; single-flight wrapped. SESSION_CLEANUP / OFFBOARD_CRON
  // / INVITE_EXPIRY_SWEEP keys already exist above; only recycle-bin is new.
  RECYCLE_BIN_PURGE = 'finance.recycle_bin_purge',
  // Uploads storage-orphan reconcile (Phase-0 cleanup 2026-06-11) — nightly,
  // REPORT-ONLY. Compares UploadEvent ownership rows against the actual stored
  // objects and logs/metrics two drift classes (live row whose object is gone;
  // deleted row whose object lingers). Never deletes anything. Single-flight
  // wrapped; naturally idempotent (read + log only).
  UPLOADS_ORPHAN_RECONCILE = 'uploads.orphan_reconcile',
  // Connect over-limit reconcile (grandfathering, 2026-06-12) — nightly. Starts/
  // clears the per-(user,kind) grace clock (overLimitSince) and fires the once-
  // per-episode over-limit notice for passive users who never open the usage
  // surface. Suppression itself is computed at READ time (never stored), so this
  // job writes no suppression flag. Naturally idempotent: convergent clock writes
  // + notification guarded by the per-episode notifiedAt marker. Single-flight
  // wrapped.
  CONNECT_OVER_LIMIT_RECONCILE = 'connect.over_limit_reconcile',
  // ERP member-cap reconcile (grandfathering, 2026-06-23) — nightly. Starts/
  // clears the per-workspace grace clock (overCapSince) and fires the once-per-
  // episode over-cap notice for workspaces whose owner never opens a capped
  // report. The allowed-member set itself is computed at READ time (never
  // stored), so this job writes no cap flag. Naturally idempotent: convergent
  // clock writes + notification guarded by the per-episode notifiedAt marker.
  // Single-flight wrapped.
  ERP_MEMBER_CAP_RECONCILE = 'erp.member_cap_reconcile',
  // Connect referral release (feed harden 2026-07-02, CN-REF-6) — daily sweep
  // that credits qualified referrals past their holdback. Money path, so it MUST
  // be single-flight wrapped like every other credit cron (it was a bare @Cron,
  // so two workers could double-run it). Per-side creditReferral idempotency is
  // the backstop, but the lock prevents the racing budget/cap re-evaluation.
  CONNECT_REFERRAL_RELEASE = 'connect.referral_release',
}

export interface CronJobConfig {
  key: CronJobKey;
  schedule: string;
  timezone: string;
  description: string;
}

export const CRON_JOBS: CronJobConfig[] = [
  {
    key: CronJobKey.SESSION_CLEANUP,
    schedule: CRON_SCHEDULES.EVERY_HOUR,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Clean up expired sessions every hour',
  },
  {
    key: CronJobKey.OFFBOARD_CRON,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT,
    timezone: CRON_TIMEZONES.IST,
    description: 'Offboard members whose resignation date has passed (midnight IST)',
  },
  {
    key: CronJobKey.SCHEDULED_SUBSCRIPTIONS,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT,
    timezone: CRON_TIMEZONES.IST,
    description: 'Process scheduled subscriptions (midnight IST)',
  },
  {
    key: CronJobKey.EXPIRED_ADDONS,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_00_05_UTC,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Process expired add-ons at 00:05 UTC',
  },
  {
    key: CronJobKey.AUTO_PRESENT,
    schedule: CRON_SCHEDULES.EVERY_15_MINUTES,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Auto-mark attendance when shifts start',
  },
  {
    key: CronJobKey.PAYROLL_AUTO_GENERATE,
    schedule: CRON_SCHEDULES.PAYROLL_AUTO_GENERATE_SCHEDULE,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Check eligible workspaces and auto-generate payroll at 00:15 UTC',
  },
  {
    key: CronJobKey.ANOMALY_MISSED_STREAK,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_MIDNIGHT_IST,
    timezone: CRON_TIMEZONES.IST,
    description: 'Detect missed-punch streaks (3+ consecutive working days) and create anomalies',
  },
  {
    key: CronJobKey.AUTO_CLOSE_STALE,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_2_30_UTC,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Auto-close sessions open >36h using shift end time (or checkIn+8h fallback)',
  },
  {
    key: CronJobKey.REMINDER_DISPATCHER,
    schedule: CRON_SCHEDULES.REMINDER_DISPATCHER,
    timezone: CRON_TIMEZONES.IST,
    description: 'Dispatch payment reminders + service-maintenance reminders (07:30 IST daily)',
  },
  {
    key: CronJobKey.SAMPLE_ALARM,
    schedule: CRON_SCHEDULES.SAMPLE_ALARM,
    timezone: CRON_TIMEZONES.UTC,
    description: 'Dispatch sample voucher expiry alarms (03:30 UTC = 09:00 IST daily)',
  },
  {
    key: CronJobKey.MAINTENANCE_COUNTER_REFRESH,
    schedule: CRON_SCHEDULES.MAINTENANCE_COUNTER_REFRESH,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Refresh hours/output cached counters for all hours_based + output_based maintenance schedules (02:00 IST daily)',
  },
  {
    key: CronJobKey.MAINTENANCE_NOTIFICATIONS,
    schedule: CRON_SCHEDULES.MAINTENANCE_NOTIFICATIONS,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Create in-app warning notifications for newly-due maintenance schedules (06:00 IST daily, deduped per workspaceId+scheduleId+dueOn)',
  },
  {
    key: CronJobKey.INVITE_EXPIRY_SWEEP,
    schedule: CRON_SCHEDULES.EVERY_HOUR,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Sweep WorkspaceMember rows where inviteExpiry < now AND status="invited" AND expiryNotifiedAt is unset; emit INVITE_EXPIRED notifications to grantor + bound invitee and stamp expiryNotifiedAt for dedup (hourly)',
  },
  {
    key: CronJobKey.LEAVE_ACCRUAL,
    schedule: CRON_SCHEDULES.LEAVE_ACCRUAL,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Post upfront + periodic leave-accrual ledger entries for every active member; idempotent — skips years/periods already credited (01:00 IST daily)',
  },
  {
    key: CronJobKey.LEAVE_COMP_OFF_EXPIRY,
    schedule: CRON_SCHEDULES.LEAVE_COMP_OFF_EXPIRY,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Expire comp-off lots past their validity — posts comp_off_expiry ledger entries and zeroes lotRemaining (03:00 IST daily)',
  },
  {
    key: CronJobKey.LEAVE_YEAR_END,
    schedule: CRON_SCHEDULES.LEAVE_YEAR_END,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Run the leave year-end close for the prior calendar year — carry-forward / lapse / annual encashment; idempotent, active only in the first week of January (02:00 IST daily)',
  },
  {
    key: CronJobKey.DEFAULTER_ALERT,
    schedule: CRON_SCHEDULES.MONTHLY_1ST_AT_6AM,
    timezone: CRON_TIMEZONES.IST,
    description:
      'Monthly attendance defaulter alerts — evaluates prior closed month, identifies members below minimum attendance threshold, and dispatches in-app + notification alerts to HR/Manager (06:00 IST on the 1st of each month)',
  },
  {
    key: CronJobKey.UPLOADS_ORPHAN_RECONCILE,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_4_15_UTC,
    timezone: CRON_TIMEZONES.UTC,
    description:
      'Report-only storage-orphan reconcile — samples UploadEvent rows and checks the active storage provider for drift (live row whose object is missing; deleted row whose object still exists). Logs + metrics only, never deletes (04:15 UTC daily)',
  },
  {
    key: CronJobKey.CONNECT_OVER_LIMIT_RECONCILE,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_4_45_UTC,
    timezone: CRON_TIMEZONES.UTC,
    description:
      'Connect over-limit reconcile — for every owner of a Connect item, start/clear the per-(user,kind) grace clock and fire the once-per-episode over-limit notice. Suppression stays computed at read time (no flag written). Idempotent; single-flight wrapped (04:45 UTC daily)',
  },
  {
    key: CronJobKey.ERP_MEMBER_CAP_RECONCILE,
    schedule: CRON_SCHEDULES.EVERY_DAY_AT_5_00_UTC,
    timezone: CRON_TIMEZONES.UTC,
    description:
      'ERP member-cap reconcile — for every candidate workspace, start/clear the per-workspace grace clock and fire the once-per-episode over-cap notice. The allowed-member set stays computed at read time (no flag written). Idempotent; single-flight wrapped (05:00 UTC daily)',
  },
];
