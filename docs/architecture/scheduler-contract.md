# ADR: Scheduled Job Execution Contract

Status: Proposed (2026-06-04)
Scope: All `@Cron` / scheduled background jobs in `crewroster-backend`.
Supersedes: ad-hoc `@nestjs/schedule` `@Cron` usage scattered across modules.

---

## Context

The backend runs ~45 scheduled jobs via `@nestjs/schedule`'s `@Cron` decorator
across 15+ modules (billing, salary, finance, attendance, leave, connect,
subscriptions, sessions, maintenance, ads).

`@Cron` runs **in-process, on every instance of the application**. There is no
leader election, no `SCHEDULER_ENABLED` gate, and no distributed lock anywhere in
the codebase. Consequences:

1. **Multi-instance double-fire.** The moment the app runs on more than one node
   (PM2 cluster, multiple container replicas, autoscaling, or even the overlap
   window of a rolling deploy), every cron fires once per instance. Observed in
   logs as the same job logging completion N times at the identical second, and
   as `E11000 duplicate key` errors from the trending-refresh job racing itself.
2. **Real-world side-effect risk.** The loud symptom (a dup-key error) is the
   least harmful case. The dangerous jobs are the ones whose double-run sends an
   email/SMS twice, posts a ledger entry twice, or generates payroll twice.
3. **`ScheduleModule.forRoot()` sprawl.** It is registered in 4+ modules with a
   web of "do not register again here" comments, which is a symptom of an
   unmanaged scheduler with no single owner.

The app already runs **BullMQ on Redis** (`@nestjs/bullmq`, configured globally in
`app.module.ts`) with retries, backoff, and per-env key prefixing. The
infrastructure for a correct distributed scheduler is already in place and
operated in production.

## Decision

Scheduled work in this backend MUST follow a three-layer contract, run on a
dedicated worker process, and use BullMQ as the only job pipeline.

### Layer 0 - Web / worker process separation (deployment topology)

The same image boots two ways:

- **Web** (`start:web`) serves HTTP only. Scaled freely for traffic.
- **Worker** (`start:worker`) runs the BullMQ consumers and the repeatable-job
  schedulers. **Scheduled jobs run on the worker only.**

This makes single-execution structural rather than a flag someone can forget:
web replicas can scale to any number without multiplying cron runs, and heavy
background work (payroll, finance postings, tenant-wide scans) never competes
with live request latency or risks OOM-ing a request-serving process. A
`PROCESS_ROLE` env var (`web` | `worker` | `all`) selects the role; `all` is the
local-dev default so a single `npm run start:dev` still runs everything.

### BullMQ is the pipeline - no new orchestration tech

We do NOT add Temporal, Airflow, or a bespoke job engine. BullMQ on Redis is
already operated and provides everything needed: repeatable scheduling, retries
with backoff (`attempts: 3`, exponential - already configured), per-queue
concurrency caps (bound worker CPU/memory), and failed-job retention for
inspection. Required additions are small: a per-queue concurrency cap on every
consumer, and one **missed-run heartbeat alert** (a silent no-run is the one
failure BullMQ will not surface on its own).

### Layer 1 - Single execution across instances (role gate + Redis single-flight)

Jobs that must run **once globally per occurrence** are guaranteed single-fire by
two mechanisms, not by "run only one worker" (a convention that breaks silently
on misconfiguration):

1. **Role gate.** Web instances stop all scheduled jobs at boot via
   `SchedulerRegistry` (one bootstrap step, no per-job change). Only `worker` /
   `all` runs the scheduler.
2. **Redis single-flight lock.** Every scheduled job body runs inside
   `runExclusive(jobKey, periodKey, fn)` - a Redis `SET key val NX PX` claim on
   `{jobKey}:{periodKey}`. If the claim is already held, this occurrence is
   already running/ran elsewhere, so the job exits as a no-op. This makes
   single-fire hold for **any** number of worker instances.

Jobs stay as readable `@Cron` decorators in their owning modules (wrapped by the
helper), rather than being rewritten into separate queue producers + processors.

- **Why not BullMQ repeatable jobs?** Considered and rejected for the _scheduling_
  layer: it would rewrite ~45 jobs into producer+processor pairs for the same
  guarantee the role gate + single-flight lock already give with far less churn.
  BullMQ remains the pipeline for genuine **fan-out / queued work** (e.g. feed
  fan-out), where the queue model is the right fit - we are not adding a second
  mechanism for that, only declining to force every cron through it.
- A purely instance-local task (e.g. flushing an in-memory buffer each instance
  owns) may run unwrapped on every instance, but MUST say so in its header.

### Layer 2 - Idempotent writes (correctness independent of Layer 1)

Every job MUST be safe to run twice and produce the same end state. Correctness
must NOT depend on Layer 1 holding, because retries (BullMQ `attempts: 3`),
crashes mid-run, and future topology changes can all cause a re-run.

Acceptable idempotency strategies:

- **Convergent upsert.** Replace "delete-all then insert-all" with `bulkWrite`
  upserts keyed on a natural key, then prune stale rows. No empty window, no
  dup-key collision. (The feed fan-out worker already documents this exact
  discipline.)
- **Period claim marker.** Before doing side-effectful work for a period, write a
  unique `{ jobKey, periodKey }` marker. If the insert collides, another run
  already owns this period - exit as a no-op. Required for jobs that **send
  messages or post financial entries** (these cannot be made naturally
  convergent).
- **Naturally idempotent.** Delete/cleanup jobs whose effect is "remove rows
  matching a predicate" are idempotent by construction. They must still declare
  this in the header so the next reader knows the second run is a safe no-op.

### Layer 3 - The cron contract comment (no blind changes)

Every scheduled job MUST carry a `CRON CONTRACT` header block. A scheduled job
without one does not pass review. The two load-bearing fields are **Idempotent**
(can this be re-run safely, and how is that guaranteed) and **Writes** (what
collections and real-world side effects a mistake here actually touches).

```ts
/**
 * CRON CONTRACT - <human job name>
 * Execution:   Repeatable BullMQ job (single-instance guaranteed). Do NOT
 *              convert to a bare @Cron - that fires on every instance.
 *              See docs/architecture/scheduler-contract.md.
 * Schedule:    <cron expr> (<tz>) - <why this cadence>
 * Idempotent:  YES - <how: upsert on {key} | claim-marker on {jobKey,period}
 *              | naturally idempotent (predicate delete)>. Second run is a no-op.
 * Reads:       <collections>
 * Writes:      <collections + side effects, e.g. "sends SMS via MSG91",
 *              "posts ledger entry", "generates payroll run">
 * Missed run:  <catch-up behavior - does a skipped window self-heal next run?>
 * Owner:       <module>
 */
```

### Supporting requirements

- The existing `CronJobKey` enum and `CRON_JOBS` registry in
  `src/common/constants/cron.constants.ts` become the **single source of truth**.
  Every scheduled job MUST have an entry. The registry currently lists ~16 of ~45
  jobs; completing it is part of this work.
- `ScheduleModule.forRoot()` registration collapses to one place. Repeatable-job
  registration goes through one shared helper so every job is wired uniformly.
- Every job classified Tier A (see migration plan) gets a test that runs it twice
  in a row and asserts a single effect.

## Consequences

- One correct fix covers all 45 jobs and any future cron, instead of patching the
  symptom on the one job that happened to have a unique index.
- New scheduled jobs have a clear, enforced template; the comment contract makes
  the idempotency and blast radius of every job legible before anyone edits it.
- Migration is mechanical but broad. It is sequenced by blast radius (money/message
  jobs first) so the highest-risk jobs are made safe earliest.

## References

- Migration plan + full cron inventory: `docs/superpowers/plans/2026-06-04-cron-scheduler-hardening.md`
- Existing idempotent-upsert precedent: `src/modules/connect/feed/feed-fanout.processor.ts`
- Queue config: `src/app.module.ts` (`BullModule.forRootAsync`)
- Cron registry: `src/common/constants/cron.constants.ts`
