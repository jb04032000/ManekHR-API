# Cron / Scheduler Hardening - Migration Plan

Date: 2026-06-04
ADR: `docs/architecture/scheduler-contract.md`
Status: Proposed - awaiting owner "go" before any code change.

## Goal

Bring all ~45 scheduled jobs in `crewroster-backend` up to the scheduler contract:
single execution across instances (BullMQ repeatable jobs), idempotent writes, and
a required `CRON CONTRACT` comment header. Complete the `CRON_JOBS` registry as the
single source of truth.

## Why now

Not live yet (single dev instance), so no production fire - but the bug is latent:
the first scale-up or rolling deploy makes all 45 jobs double-fire, and several of
them send messages or post financial entries. Fixing it before launch is the
no-shortcut choice.

## Full cron inventory (classified by blast radius)

Blast radius = what a double-run actually does. This is the work order: Tier A first.

### Tier A - double-run causes real damage (money sent/posted, messages sent twice)

| Job                       | File                                                            | Side effect of double-run                                       |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Payroll auto-generate     | `salary/crons/payroll-auto-generate.cron.ts`                    | Duplicate payroll run                                           |
| Commission schedule       | `salary/crons/commission-schedule.cron.ts`                      | Duplicate commission dispatch                                   |
| Trial reminder            | `subscriptions/billing/crons/trial-reminder.cron.ts`            | Duplicate email                                                 |
| Renewal notice            | `subscriptions/billing/crons/renewal-notice.cron.ts`            | Duplicate email                                                 |
| Win-back                  | `subscriptions/billing/crons/win-back.cron.ts`                  | Duplicate email                                                 |
| Abandoned checkout        | `subscriptions/billing/crons/abandoned-checkout.cron.ts`        | Duplicate email                                                 |
| Scheduled subscriptions   | `subscriptions/subscriptions.service.ts:777`                    | Duplicate subscription state change                             |
| Dunning                   | `subscriptions/subscriptions.service.ts:895`                    | Duplicate dunning action                                        |
| Included-credits grant    | `connect/monetization/crons/included-credits-grant.cron.ts`     | Duplicate credit grant                                          |
| Late fee                  | `finance/payments/late-fee/late-fee.cron.ts`                    | Duplicate late-fee posting                                      |
| Loan EMI                  | `finance/loan-accounts/loan-emi.cron.ts`                        | Duplicate EMI posting                                           |
| Depreciation              | `finance/fixed-assets/depreciation/depreciation.cron.ts`        | Duplicate depreciation entry                                    |
| Recurring expense         | `finance/expenses/recurring/recurring-expense.cron.ts`          | Duplicate expense voucher                                       |
| Recurring sales           | `finance/sales/recurring/recurring.cron.ts`                     | Duplicate sales invoice                                         |
| Capital-goods ITC         | `finance/purchases/capital-goods-itc/capital-goods-itc.cron.ts` | Duplicate ITC posting                                           |
| Reminder dispatcher       | `finance/reminders/dispatcher/reminder-dispatcher.cron.ts`      | Duplicate payment/maintenance reminders                         |
| Greetings                 | `finance/party-intelligence/greetings/greetings.cron.ts`        | Duplicate greeting message                                      |
| Leave accrual             | `leave/leave-accrual.cron.ts`                                   | Duplicate leave credit (claims idempotent - VERIFY)             |
| Leave comp-off expiry     | `leave/leave-maintenance.cron.ts:34`                            | Duplicate expiry ledger entry                                   |
| Leave year-end            | `leave/leave-maintenance.cron.ts:90`                            | Duplicate carry-forward/encashment (claims idempotent - VERIFY) |
| Defaulter alert           | `attendance/crons/defaulter-alert.cron.ts`                      | Duplicate HR/Manager alert                                      |
| Sample alarm              | `finance/inventory/samples/samples.cron.ts`                     | Duplicate sample-expiry alarm                                   |
| JW pending alarm          | `finance/job-work/pending-alarm/jw-pending-alarm.cron.ts`       | Duplicate job-work alarm                                        |
| GST verify-data           | `finance/gst/verify-data/verify-data-cron.service.ts`           | Duplicate verification side effects                             |
| Maintenance notifications | `maintenance/maintenance-notifications.cron.ts`                 | Duplicate due-notification (claims dedup - VERIFY)              |
| MSG91 balance             | `sms/services/msg91-balance.service.ts`                         | Possible duplicate low-balance alert                            |
| Add-ons (x2)              | `add-ons/add-ons.service.ts:1143,1226`                          | Duplicate add-on lifecycle action                               |
| Unassigned-device digest  | `attendance-devices/crons/unassigned-digest.cron.ts`            | Duplicate digest email                                          |

### Tier B - double-run wastes work or throws dup-key (no real-world harm)

| Job                                 | File                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| Trending refresh (the reported one) | `connect/feed/discovery/trending-refresh.service.ts`             |
| Trending tags                       | `connect/tags/trending-tags.service.ts`                          |
| RFM segmenter                       | `finance/party-intelligence/rfm/rfm.cron.ts`                     |
| GSTIN monitor                       | `finance/party-intelligence/gstin-monitor/gstin-monitor.cron.ts` |
| Anomaly streak                      | `anomalies/anomaly-streak.cron.ts`                               |
| Maintenance counters                | `maintenance/maintenance-counters.cron.ts`                       |
| Ads rollup                          | `connect/ads/crons/rollup.cron.ts`                               |
| Ads reconcile                       | `connect/ads/crons/reconcile.cron.ts`                            |
| Ads pacing daemon                   | `connect/ads/crons/pacing.daemon.ts`                             |
| Auto-present                        | `attendance/auto-present.cron.ts:32`                             |
| Auto-close stale sessions           | `attendance/auto-present.cron.ts:316`                            |

### Tier C - naturally idempotent (predicate-based delete/cleanup)

| Job                 | File                                      |
| ------------------- | ----------------------------------------- |
| Session cleanup     | `sessions/session-cleanup.cron.ts`        |
| Recycle-bin purge   | `finance/recycle-bin/recycle-bin.cron.ts` |
| Invite expiry sweep | `workspaces/invite-expiry.cron.ts`        |
| Offboard            | `team/offboard.cron.ts`                   |

> Counts are from the audit grep; exact per-job idempotency is confirmed when each
> job is migrated. "VERIFY" tags mark jobs that already claim idempotency in their
> description - we confirm the claim holds rather than assume it.

## Execution method (the no-shortcut standard - locked)

Risk-first (Tier A -> B -> C), module-by-module, test-gated. Per job:

1. Read it; understand exactly what it writes and its natural period.
2. Wrap the body in `singleFlight.runExclusive(jobKey, periodBucket(), fn)` with a
   cadence-matched bucket (`dayBucket` for daily+, `hourBucket` hourly,
   `minuteBucket` sub-hour).
3. **Audit existing idempotency against the code** (do not trust the comment).
   Add a durable `{jobKey, period, entity}` claim marker ONLY where a real gap
   exists. Most Tier A jobs are already guarded (see finding below).
4. Add the `CRON CONTRACT` header.
5. Add/extend the `CronJobKey` + `CRON_JOBS` registry entry.
6. Add a run-twice test asserting a single effect.
7. Verify (scoped vitest + `nest build`) before the next module lands.

Money-critical jobs are done with focused review, NOT parallel subagents.

### Audit finding (2026-06-04) - existing idempotency is good

Spot-checked Tier A: `trial-reminder` (keyed `trial:<subId>` in MarketingService)
and `payroll-auto-generate` (`lastAutoGenerateKey === monthKey` guard + perquisite
history) are already idempotent. The codebase has a consistent idempotency culture.
So Tier A work is mostly wrap + header + verify, with claim markers only for the
unguarded few. Also: the shipped role gate already stops the operational
multi-instance double-fire once deployed as web + worker; single-flight is the
multi-worker / retry hardening on top.

## Status tracker

| Job                                                                                          | Wrap | Idempotent                                   | Header | Test | Status                         |
| -------------------------------------------------------------------------------------------- | ---- | -------------------------------------------- | ------ | ---- | ------------------------------ |
| Foundation (env, SingleFlightService, period-key, SchedulerModule, role gate, start scripts) | -    | -                                            | -      | yes  | DONE + verified                |
| connect.trending_refresh                                                                     | yes  | yes (convergent upsert)                      | yes    | yes  | DONE + verified                |
| billing.trial_reminder                                                                       | yes  | yes (dispatch anchorKey)                     | yes    | yes  | DONE + verified                |
| billing.renewal_notice                                                                       | yes  | yes (anchorKey+periodEnd)                    | yes    | yes  | DONE + verified                |
| billing.win_back                                                                             | yes  | yes (anchorKey+cancelledAt)                  | yes    | yes  | DONE + verified                |
| billing.abandoned_checkout                                                                   | yes  | yes (anchorKey/paymentId)                    | yes    | yes  | DONE + verified                |
| payroll_auto_generate                                                                        | yes  | yes (lastAutoGenerateKey)                    | yes    | yes  | DONE + verified                |
| commission.dispatch                                                                          | yes  | yes (disbursementLog guard)                  | yes    | yes  | DONE + verified                |
| leave.accrual                                                                                | yes  | yes (ledger period dedup)                    | yes    | yes  | DONE + verified                |
| leave.comp_off_expiry                                                                        | yes  | yes (lotRemaining>0 state)                   | yes    | yes  | DONE + verified                |
| leave.year_end                                                                               | yes  | yes (alreadyClosed guard)                    | yes    | yes  | DONE + verified                |
| finance.late_fee_accrual                                                                     | yes  | yes (LateFeeEntry unique)                    | yes    | yes  | DONE + verified                |
| finance.loan_emi                                                                             | yes  | yes (LoanEmiRun unique)                      | yes    | yes  | DONE + verified                |
| finance.depreciation                                                                         | yes  | yes (DepreciationRun unique)                 | yes    | yes  | DONE + verified                |
| finance.recurring_expense                                                                    | yes  | partial (cursor; crash-gap flagged)          | yes    | yes  | DONE + verified                |
| finance.recurring_invoice                                                                    | yes  | partial (cursor; crash-gap flagged)          | yes    | yes  | DONE + verified                |
| finance.capital_goods_itc                                                                    | yes  | partial (cursor; crash-gap flagged)          | yes    | yes  | DONE + verified                |
| scheduled_subscriptions (process)                                                            | yes  | yes (state: scheduled->active)               | yes    | yes  | DONE + verified                |
| subscription.expire_stale                                                                    | yes  | yes (predicate updateMany)                   | yes    | yes  | DONE + verified                |
| connect.included_credits_grant                                                               | yes  | yes (wallet grant idempotencyKey)            | yes    | yes  | DONE + verified                |
| reminder_dispatcher                                                                          | yes  | yes (per-day idempotency log)                | yes    | yes  | DONE + verified                |
| greetings.dispatch                                                                           | yes  | yes (GreetingsDispatchLog dedup)             | yes    | yes  | DONE + verified                |
| sample_alarm                                                                                 | yes  | yes (state flip predicate)                   | yes    | yes  | DONE + verified                |
| finance.jw_pending_alarm                                                                     | yes  | yes (state + 7-day dedup stamp)              | yes    | yes  | DONE + verified                |
| finance.gst_verify_data                                                                      | yes  | yes (scan overwrite per firm/period)         | yes    | yes  | DONE + verified                |
| defaulter_alert                                                                              | yes  | yes (DefaulterAlertDispatch guard)           | yes    | yes  | DONE + verified                |
| maintenance.notifications                                                                    | yes  | yes (per recipient/schedule/dueOn)           | yes    | yes  | DONE + verified                |
| msg91 balance poll                                                                           | yes  | effective (snapshot append; alert throttled) | yes    | yes  | DONE + verified                |
| attendance.unassigned_digest                                                                 | yes  | effective (single daily trigger)             | yes    | yes  | DONE + verified                |
| expired_addons                                                                               | yes  | yes (state flip predicate)                   | yes    | yes  | DONE + verified                |
| addons.credit_checks                                                                         | yes  | yes (threshold + 7d alert throttle)          | yes    | yes  | DONE + verified                |
| **TIER A COMPLETE (28/28)**                                                                  |      |                                              |        |      | DONE                           |
| connect.trending_refresh (counted above)                                                     | yes  | yes (convergent upsert)                      | yes    | yes  | DONE + verified                |
| connect.trending_tags                                                                        | yes  | yes (convergent recompute: zero + upsert)    | yes    | yes  | DONE + verified                |
| connect.ads_rollup                                                                           | yes  | yes (upsert {campaignId, date})              | yes    | yes  | DONE + verified                |
| connect.ads_reconcile                                                                        | yes  | yes (status-flip predicate; crash-gap noted) | yes    | yes  | DONE + verified                |
| connect.ads_pacing                                                                           | yes  | yes (convergent Redis throttle SET)          | yes    | yes  | DONE + verified                |
| rfm.segmenter                                                                                | yes  | yes (convergent recompute per workspace)     | yes    | yes  | DONE + verified                |
| gstin.monitor                                                                                | yes  | yes (convergent overwrite per party)         | yes    | yes  | DONE + verified                |
| anomaly_missed_streak                                                                        | yes  | yes (record contextKey dedup)                | yes    | yes  | DONE + verified                |
| auto_present                                                                                 | yes  | yes (existing-attendance skip predicate)     | yes    | yes  | DONE + verified                |
| auto_close_stale                                                                             | yes  | yes (checkOut:null predicate flip)           | yes    | yes  | DONE + verified                |
| maintenance.counter_refresh                                                                  | yes  | yes (convergent recompute per schedule)      | yes    | yes  | DONE + verified                |
| **TIER B COMPLETE (11/11)**                                                                  |      |                                              |        |      | DONE                           |
| session_cleanup                                                                              | yes  | yes (naturally idempotent predicate delete)  | yes    | yes  | DONE + verified                |
| finance.recycle_bin_purge                                                                    | yes  | yes (naturally idempotent predicate delete)  | yes    | yes  | DONE + verified                |
| invite.expiry_sweep                                                                          | yes  | yes (expiryNotifiedAt dedup stamp)           | yes    | yes  | DONE + verified                |
| offboard_cron                                                                                | yes  | yes (isActive predicate state-flip)          | yes    | yes  | DONE + verified                |
| **TIER C COMPLETE (4/4)**                                                                    |      |                                              |        |      | DONE. All Tier A/B/C migrated. |

## Approach

### Phase 0 - Foundation (no behavior change)

- Land the ADR (done) + this plan.
- **Web/worker process split.** `PROCESS_ROLE` env (`web` | `worker` | `all`,
  default `all` for dev); `start:web` / `start:worker` scripts; bootstrap gates
  the scheduler + queue consumers to `worker`/`all`. Single execution becomes
  structural, not a flag.
- Add a shared `runExclusive(jobKey, periodKey, fn)` Redis single-flight helper
  and collapse `ScheduleModule.forRoot()` to one place.
- Extend `CronJobKey` + `CRON_JOBS` registry to cover all ~45 jobs.
- One missed-run heartbeat alert (a silent no-run is the one failure the gate +
  lock cannot surface on their own).
- Add the lint/review rule (or a startup assertion) that every scheduled job has a
  registry entry, a single-flight wrap, and a CRON CONTRACT header.

### Deferred (tracked, not built now)

- **Cursor-based crons crash-window.** `recurring-expense`, `recurring-invoice`,
  and `capital-goods-itc` are idempotent for re-runs via a `nextRunAt` /
  `nextAmortisationMonth` cursor, but a crash between the generate/post and the
  cursor advance could double-generate on the next run (no per-(entity, period)
  claim marker). Single-flight + role gate close the multi-instance case; this
  residual crash-window is a separate hardening item - add a `{templateId,
period}` / `{scheduleId, month}` claim marker with a run-twice-across-crash
  test. Not built now to avoid touching the money-write path without a dedicated
  test pass.

- **Per-tenant scan reduction.** Several jobs run hourly and scan every workspace
  to act on the ~1/24 whose local time matches (RFM, GSTIN monitor, greetings).
  Cheap at low tenant counts; the future scaling cost. Fix (bucket-by-due-time or
  per-tenant enqueue) is a measured optimization, done when tenant count and cost
  are real. The Phase 0 architecture does not block it. Do NOT build speculatively.

### Phase 1 - Tier A (money/message jobs)

Per job: migrate to repeatable job -> add/verify idempotency (claim-marker for
send/post jobs) -> add `CRON CONTRACT` header -> add a "run twice = one effect"
test. Done module-by-module so each is independently verifiable.

### Phase 2 - Tier B (materialization jobs)

Same treatment. This is where `trending-refresh` delete-then-insert becomes a
convergent upsert and the original dup-key error is fixed at the root.

### Phase 3 - Tier C (cleanup jobs)

Migrate to repeatable jobs + add the `CRON CONTRACT` header with "naturally
idempotent" noted. Minimal code change.

### Phase 4 - Verification + docs

- Run-twice tests green for every Tier A job.
- Update backend `CLAUDE.md` to point at the ADR as the binding standard for any
  new scheduled job.

## Out of scope

- Changing what any job does or its schedule. This is execution-model + idempotency
  - documentation only. Any behavioral change surfaces separately for approval.

## Open items for the owner

- Confirm "go" to start Phase 0.
- Confirm git discipline holds (owner stages + commits; assistant runs no git ops).
