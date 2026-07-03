# Boost Post Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project git rule:** the OWNER stages and commits. Where a step says "commit", stage the listed files and pause for the owner. The assistant never runs git.
>
> **Test/typecheck rule (resource caution):** run vitest for ONLY the touched files with `--no-file-parallelism`. Typecheck via `npx nest build` (SWC), never whole-project `tsc`.

**Goal:** Build the first-party ad delivery engine, advertiser prepaid wallet, idempotent billing, Boost Post lifecycle, event ingestion, and admin endpoints in the NestJS backend so a post can be boosted, served to a targeted audience, measured, and billed.

**Architecture:** A new `src/modules/connect/ads` module owns ad serving. Durable state in MongoDB (wallet, ledger, campaign, ad set, creative, placement, impression, click, rollup). Hot-path state in Redis (per-user ad profile cache, frequency-cap counters, pacing flags). Decisioning is one fast in-memory call against the cached profile. Billing is a two-phase commit (reserve at win, debit on confirmed viewability or click) keyed by `impressionToken` for idempotency, reconciled nightly.

**Tech Stack:** NestJS, Mongoose/MongoDB, Redis (ioredis, already in stack), `@nestjs/schedule` crons, class-validator DTOs, vitest. Conventions: env via `src/config/env.ts`, `JwtAuthGuard` + tenant scope + throttler, `AuditService.logEvent`, PostHog/OTel/Sentry wiring.

**Worktree:** backend `.worktrees/crewroster-backend/zari360-connect`. All paths below are relative to that worktree root.

---

## File Structure

```
src/modules/connect/ads/
  ads.module.ts
  schemas/  (9: advertiser-wallet, ad-wallet-ledger, ad-campaign, ad-set, ad-creative, ad-placement, ad-impression, ad-click, ad-daily-rollup)
  dto/      (create-boost, audience-estimate, wallet-topup, decide, record-event, admin-review, admin-placement)
  lib/      (targeting.ts, ecpm.ts, pacing.ts)  -- pure, fully unit-tested
  services/ (wallet, ad-profile, frequency-cap, audience, ad-decision, boost, ad-events, ad-rollup, pacing.repo, ad-repos)
  crons/    (pacing.daemon, reconcile.cron, rollup.cron)
  controllers/ (boost, wallet, audience, decide, ads-admin)
  __tests__/*.vitest.ts
```

This is **Plan 1 of 2** (backend). Plan 2 (web) covers the Boost composer, wallet UI, feed render seam, results view, and i18n.

---

## Task 1: Module scaffold + audit enum

**Files:** Create `ads.module.ts`; Modify `src/app.module.ts` (register `AdsModule`); Modify the AppModule audit enum (add `ADS = ''ads''`).

- [x] Step 1: `grep -rn "AUTH = ''auth''" src/` to find the audit enum file; add `ADS = ''ads'',`.
- [x] Step 2: create empty `@Module({})` class `AdsModule`.
- [x] Step 3: add `AdsModule` to `imports` in `src/app.module.ts`.
- [x] Step 4: `npx nest build` (expect success).
- [ ] Step 5: Commit (owner): `feat(ads): scaffold ads module + ADS audit enum`.

## Task 2-9: Schemas (one task each, same shape: write schema -> `npx nest build` -> commit)

Full schema code is in the design spec data-model section and reproduced inline during execution. Collections + key fields:

- **advertiser-wallet** `ad_advertiser_wallets`: workspaceId(unique), balance(min0), reserved(min0), lastTopUpAt. 1 credit = INR 1 ex-GST.
- **ad-wallet-ledger** `ad_wallet_ledgers`: workspaceId, type(topup|reserve|debit|release|refund|adjustment), amount(signed), balanceAfter, reservedAfter, campaignId?, idempotencyKey?, ref?, note?, recordedBy?. Index {workspaceId,createdAt:-1}; PARTIAL UNIQUE {idempotencyKey} where exists.
- **ad-campaign** `ad_campaigns`: workspaceId, ownerUserId, kind(boost_post), sourcePostId, objective(reach|inquiries|profile_visits), status(draft|pending_review|active|paused|completed|rejected), totalBudget, budgetSpent, startAt, endAt, pacing(even), billingEvent(cpm|cpc), bid. Index {workspaceId,status},{status,endAt}.
- **ad-set** `ad_sets`: campaignId, targeting(TargetingSpec embedded: roles[],sectors[],districts[],companySizes[],maxConnectionDegree?), placements[], freqCapCount, freqCapWindowSec.
- **ad-creative** `ad_creatives`: campaignId, kind(promoted_post), postRef, reviewStatus(pending|approved|rejected), reviewedBy?, rejectionReason?.
- **ad-placement** `ad_placements`: key(unique, ''feed_promoted_post''), surface(feed|rail), floorCpm, enabled.
- **ad-impression** `ad_impressions`: campaignId, adSetId, creativeId, userId, placementKey, impressionToken(unique), servedAt, viewable, charged, chargeAmount. Index {campaignId,servedAt:-1}.
- **ad-click** `ad_clicks`: impressionToken(unique), campaignId, userId, clickedAt, valid, chargeAmount.
- **ad-daily-rollup** `ad_daily_rollups`: campaignId, date(YYYY-MM-DD IST), impressions, viewableImpressions, clicks, validClicks, spend, ctr, viewabilityRate. Index {campaignId,date:-1}.

> Confirm the post model name with `grep -rn "ConnectPost\|@Schema" src/modules/connect/feed | head` and use the real registered name in `ref`.

## Task 10: lib/targeting.ts (pure, TDD)

- Test: matches when constrained dims match; rejects mismatch; empty arrays = no constraint; honors maxConnectionDegree.
- Impl `matchesTargeting(spec, profile)`: for each dim, if spec array non-empty and excludes profile value -> false; maxConnectionDegree: profile.connectionDegree > max -> false; else true. Export `AdProfile {role,sector,district,companySize,connectionDegree}`.
- TDD: write test -> `npx vitest run .../targeting.vitest.ts --no-file-parallelism` (FAIL) -> impl -> PASS -> commit.

## Task 11: lib/ecpm.ts (pure, TDD)

- `ecpm({billingEvent,bid,predictedCtr})`: cpm -> bid; cpc -> predictedCtr*bid*1000.
- `score(ecpm, relevance)`: ecpm*(0.85+0.15*relevance).
- TDD same loop.

## Task 12: lib/pacing.ts (pure, TDD)

- `targetImpressionsPerMinute(budgetRemaining, minutesLeft, avgCpm)`: 0 if minutesLeft<=0 or avgCpm<=0; else floor((budgetRemaining/minutesLeft)/avgCpm\*1000).
- `shouldThrottle(lastMinute, target)`: target<=0 -> true; else lastMinute > target\*1.2.
- TDD same loop.

## Task 13: WalletService.topup + getWallet (TDD)

- Use `@nestjs/mongoose` decorator-mock pattern (ref `src/modules/auth/__tests__/auth.service.audit.vitest.ts`). Create `__tests__/helpers/ad-model-mocks.ts` with in-memory wallet model (findOne, findOneAndUpdate honoring `$gte` guards + `$inc` + `$set` + `$setOnInsert`) and ledger model (findOne/exists/create that throws code 11000 on duplicate idempotencyKey).
- `topup(workspaceId, amount, meta)`: reject amount<=0; `findOneAndUpdate {$inc:{balance:amount}, $set:{lastTopUpAt}}` upsert new; write ledger row type=topup with balanceAfter/reservedAfter; `writeLedger` swallows 11000 (idempotent).
- `getWallet`: findOne or upsert empty.
- TDD: topup credits balance + writes topup row with balanceAfter.

## Task 14: WalletService.reserve (guarded, TDD)

- `reserve(ws, amount, campaignId)`: atomic `findOneAndUpdate({workspaceId, balance:{$gte:amount}}, {$inc:{balance:-amount, reserved:amount}}, {new})`; null -> return false (insufficient); else ledger type=reserve, return true.
- TDD: sufficient -> moves balance to reserved; insufficient -> false, no change.

## Task 15: WalletService.debit (idempotent) + release (TDD)

- `debit(ws, amount, campaignId, idempotencyKey)`: if ledger.findOne({idempotencyKey}) exists -> return (already charged); `findOneAndUpdate {$inc:{reserved:-amount}}`; try create ledger debit row with idempotencyKey; on 11000 -> undo reserved decrement (`$inc:{reserved:amount}`) and return.
- `release(ws, amount, campaignId)`: `$inc:{reserved:-amount, balance:amount}`; ledger type=release.
- TDD: debit twice same key -> charged once, one ledger row; release returns reserved to balance.

## Task 16: FrequencyCapService (Redis, TDD)

- Step 0: `grep -rn "ioredis\|REDIS_CLIENT\|@InjectRedis\|RedisModule" src/ | head` -> real token; replace ''REDIS_CLIENT''.
- `hitAndCheck(userId, adSetId, windowSec, cap)`: key `freqcap:{userId}:{adSetId}:{windowSec}`; INCR; if n===1 set EXPIRE windowSec; return n<=cap.
- TDD with fake redis (incr/expire): allows up to cap then blocks.

## Task 17: AdProfileService (Redis cache, TDD)

- `get(userId)`: read `adprofile:{userId}`; hit -> JSON.parse; miss -> source.buildFor(userId), set with EX 900, return.
- Collaborator `AD_PROFILE_SOURCE` (ProfileSource.buildFor). TDD with fake redis: cache hit no rebuild; miss builds+caches.
- Step 5: provide real source in module (reads role/sector/district/companySize from workspace+Connect profile+ERP designation, connection-degree from Connect graph; safe defaults). `grep -rn "designation\|industry" src/modules/team src/modules/workspaces | head`.

## Task 18: AudienceService (reach estimate, TDD)

- `estimate(spec)`: counter.countMatching(spec); if < FLOOR(50) -> {reach:50, belowFloor:true}; else {reach:n, belowFloor:false}.
- Collaborator `AUDIENCE_COUNTER`. TDD: above floor returns count; below floor hides exact + flags.
- Step 5: real counter = Mongo aggregate over same source collections.

## Task 19: AdDecisionService (9-step, TDD) -- hot path

- Constructor takes 6 injectable collaborators (PlacementRepo, CandidateRepo, ProfileRepo, FreqCapRepo, PacingRepo, ImpressionOpener) so it is unit-testable without Mongo/Redis.
- `decide({userId, placementKey})`: 1) placement.get; null/disabled -> null. 2) profiles.get. 3) candidates.top(key,50). For each: skip if authorUserId===userId; skip if !matchesTargeting; skip if pacing.isThrottled; skip if !freqcap.hitAndCheck; else push {c, score(ecpm(c), c.relevance)}. If none -> null. Sort desc by score. Winner. If ecpm(winner) < floorCpm -> null (caller falls back to house promo). impressions.open(...) -> {impressionToken}. Return {impressionToken, postRef, campaignId}.
- TDD: returns winner+token; excludes own author; drops targeting mismatch; null when placement disabled.
- Known simplification: freq-cap consumes a hit on losing candidates (OK for single-candidate slots; note in PROGRESS).

## Task 20: PacingRepoRedis + PacingDaemon

- `PacingRepoRedis.isThrottled(campaignId)`: get `pacing:{id}` != null. `setThrottle(id, ttl)`: set EX. TDD with fake redis.
- `PacingDaemon` @Cron(EVERY_MINUTE): for each active campaign (endAt>now): minutesLeft, budgetRemaining, avgCpm (cpm->bid, cpc->max(1,bid\*10)); target=targetImpressionsPerMinute(...); lastMinute=countDocuments impressions servedAt>=now-60s; if shouldThrottle -> setThrottle(id,60).

## Task 21: BoostService.create (TDD)

- Constructor: campaigns, adsets, creatives, WalletService, RollupReader.
- `create(input)`: billingEvent = reach?cpm:cpc; bid = cpm?40:4; startAt=now, endAt=now+days\*86400000; create campaign (status pending_review); create adset (placements [feed_promoted_post], freqCap 3/86400); create creative (reviewStatus pending); wallet.reserve(ws, totalBudget, campaignId); if !reserved -> throw BadRequest ''insufficient wallet balance''; return campaign.
- TDD: creates pending_review + cpm for reach + reserve called; throws when reserve false.

## Task 22: BoostService.pause/resume (TDD)

- `pause(id, ws)`: load+scope-check; if active: unspent=max(0,total-spent); release(ws,unspent,id); status=paused; save.
- `resume(id, ws)`: if paused: need=max(0,total-spent); ok = need===0 || reserve; if !ok throw; status=active; save.
- TDD: pause releases unspent (500-120=380).

## Task 23: BoostService.status (TDD)

- `status(id, ws)`: load+scope-check; agg=rollups.aggregateFor(id); return {status, objective, spend, budgetRemaining, reach:viewableImpressions, views:impressions, clicks}.
- TDD: returns spend + metrics + budgetRemaining.

## Task 24: AdEventsService.recordImpression (cpm debit, idempotent, TDD)

- Collaborators: ImpressionRepo (findOne, setViewableAndCharge=atomic guarded update), CampaignSpendRepo (incSpend), WalletDebiter (debit), optional ClickRepo.
- `recordImpression(token)`: load impr; if !impr || charged -> return; if billingEvent!==cpm -> setViewableAndCharge(token,0) return; charge=bid/1000; updated=setViewableAndCharge(token,charge); if !updated -> return (lost race); campaigns.incSpend; wallet.debit(ws,charge,campaignId,token).
- Real setViewableAndCharge = `findOneAndUpdate({impressionToken,charged:false},{$set:{viewable:true,charged:true,chargeAmount}},{new})`; null -> already charged.
- TDD: charges cpm once on first beacon; retry no double-charge; debit called with bid/1000.

## Task 25: AdEventsService.recordClick (cpc debit, idempotent, TDD)

- `recordClick(token, userId)`: load impr; valid=true (basic); created=clicks.createIfAbsent(token, doc); if !created -> return (dup); if billingEvent!==cpc || !valid -> return; charge=bid; incSpend; wallet.debit(ws,charge,campaignId,`click:${token}`).
- Real createIfAbsent = insert into ad_clicks on unique impressionToken; 11000 -> false.
- TDD: charges cpc once per token; key `click:tok`.

## Task 26: ReconcileCron (TDD pure helper)

- `reconcileAmount({status, reservedForCampaign, confirmedSpend})`: active|pending_review -> 0; else max(0, reserved-confirmed).
- @Cron(EVERY_DAY_AT_3AM): for active campaigns with endAt<=now: release the gap; set status=completed; save.
- TDD: completed releases gap (380); active releases 0.

## Task 27: RollupCron (TDD pure math)

- `computeRates({impressions,viewableImpressions,clicks,validClicks,spend})`: ctr=impressions>0?clicks/impressions:0; viewabilityRate=impressions>0?viewable/impressions:0.
- @Cron(EVERY_DAY_AT_2AM): aggregate yesterday impressions (count, viewable cond-sum, spend sum) per campaign; aggregate clicks; computeRates; upsert ad_daily_rollups {campaignId,date}.
- TDD: computeRates correct + zero-safe.

## Task 28: DTOs (class-validator)

- create-boost: TargetingDto (roles/sectors/districts/companySizes arrays w/ ArrayMaxSize, maxConnectionDegree? 1..3); CreateBoostDto (postId, objective IsIn, totalBudget @Min(99), days IsIn[3,7,14,30], targeting ValidateNested).
- audience-estimate (targeting), wallet-topup (amount @Min(1), ref?), record-event (impressionToken), decide (placementKey), admin-review (AdminRejectDto reason, AdminApproveDto note?), admin-placement (floorCpm @Min(0), enabled).
- `npx nest build` -> commit.

## Task 29: Boost/Wallet/Audience controllers

- Step 0: `grep -rn "JwtAuthGuard" src/modules/connect | head`; `grep -rn "req.user.workspaceId\|@CurrentWorkspace\|@Workspace(" src/modules/connect | head` -> adjust imports + scope source.
- BoostController `connect/ads/boosts`: POST create, GET :id status, POST :id/pause, POST :id/resume. workspaceId from req.user (never body).
- WalletController `connect/ads/wallet`: GET, POST topup (note: gateway payment confirms before topup in real flow).
- AudienceController `connect/ads/audience`: POST estimate.
- All `@UseGuards(JwtAuthGuard)`. `npx nest build` -> commit.

## Task 30: Decide + Events controller

- DecideController `connect/ads`: POST decide (userId from req.user); POST events/impression @HttpCode(204); POST events/click @HttpCode(204).
- `npx nest build` -> commit.

## Task 31: AdsAdminController + audit

- Step 0: `grep -rn "AdminGuard\|@Roles(''admin''\|SuperAdmin" src/ | head`; `grep -rn "logEvent(" src/common/audit | head`.
- `admin/connect/ads`: GET review (pending creatives); POST review/:id/approve (creative approved + campaign active); POST review/:id/reject (creative rejected + campaign rejected + wallet.release unspent); GET placements; PUT placements/:key; GET revenue (sum budgetSpent).
- Wire AuditService.logEvent with AppModule.ADS on every write. `npx nest build` -> commit.

## Task 32: Concrete Mongo repos (ad-repos.ts)

- CandidateRepoMongo.top(placementKey, limit): find adsets by placement; for each, find active in-budget in-date campaign (`$expr {$lt:[''$budgetSpent'',''$totalBudget'']}`) + approved creative; map to Candidate {predictedCtr 0.01, relevance 1}; sort by bid desc; slice.
- PlacementRepoMongo.get(key): findOne lean.
- ImpressionOpenerMongo.open(...): impressionToken=randomUUID(); create ad_impressions (pending); return {impressionToken}.
- Also add thin concrete impls for AdEventsService collaborators: ImpressionRepo (atomic setViewableAndCharge), CampaignSpendRepo.incSpend (guarded `$inc budgetSpent`), ClickRepo.createIfAbsent (unique-index insert).
- Note: N+1 candidate read OK early; replace with one aggregation when active-campaign count grows (PROGRESS).
- `npx nest build` -> commit.

## Task 33: Module wiring + tokens + seed + observability

- MongooseModule.forFeature all 9 schemas. Register all services/repos/crons/controllers.
- AdDecisionService + AdEventsService take positional interface args: register via `useFactory` passing concrete collaborators (or refactor to `@Inject(token)` per arg; pick one, stay consistent).
- Provide `REDIS_CLIENT` (useExisting repo token), `AD_PROFILE_SOURCE` (real), `AUDIENCE_COUNTER` (real).
- onModuleInit: idempotent seed placement `feed_promoted_post` (upsert $setOnInsert surface feed, floorCpm 0, enabled true).
- Observability: PostHog events `ads.boost_created` / `ads.wallet_topped_up` / `ads.creative_approved` / `ads.creative_rejected` / `ads.campaign_completed`; OTel spans around create/decide/charge; Sentry.captureException on billing catch with tags {module:''ads'',op}.
- `npx nest build` (success) + `npx vitest run src/modules/connect/ads --no-file-parallelism` (all PASS) -> commit.

## Task 34: Throttler tiers + final scope audit

- `grep -rn "@Throttle(" src/modules/connect | head`. Apply: wallet/topup ~10/min, boosts create ~20/min, events/\* ~120/min, audience/estimate ~30/min (repo named-tier syntax).
- Confirm every endpoint has JwtAuthGuard, reads workspaceId from auth (never body), and boosts/:id scope blocks cross-workspace reads.
- `npx nest build` + full ads vitest -> commit.

---

## Self-Review

**Spec coverage:** data model -> T2-9; decision engine -> T10/11/19/20/32; boost API -> T21/22/23/29/30; billing reserve/two-phase/reconcile/release -> T13/14/15/24/25/26; targeting -> T10/17/18; measurement+IVT -> T24/25/27; admin -> T31; security/RBAC/throttler -> T29-34; reuse (ledger pattern, Redis) -> T3/13/16/17. Web composer/wallet UI/feed seam/results/i18n -> Plan 2 (not here).
**Placeholders:** none in logic. `grep` lines are repo-discovery (Redis token, post model, guard/decorator paths, AuditService signature, throttler syntax) -- repo-specific identifiers that must be read from the codebase; each names what to find + how to use it.
**Type consistency:** TargetingSpec (persistence) vs TargetingDto (validation) mapped 1:1; AdProfile identical across targeting.ts/ad-profile/decision tests; impressionToken single idempotency key across impression/click (`click:` prefix)/wallet debit; ecpm/score signatures match; BoostService rollups reader present from T21 (tests pass it) so T23 consistent.
**Known simplifications (record in PROGRESS):** freq-cap consumes hit on losers; candidate read N+1; predictedCtr/relevance constants; IVT basic. All OK for foundation, flagged for later slices.

## Execution Handoff

Plan 1 of 2 (backend). Plan 2 (web) covers composer, wallet UI, feed render seam, results, i18n.
Execution options: (1) Subagent-Driven (recommended) -- fresh subagent per task, review between; (2) Inline -- this session with checkpoints.
