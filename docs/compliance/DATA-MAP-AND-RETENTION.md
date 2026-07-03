# Data Map & Retention Schedule (CrewRoster)

> **Status:** retention defaults **confirmed by the owner 2026-06-14**, pending a final **CA / labour-law sign-off**. This doc is the single source of truth for the Workstream G module-hardening sessions (see `MODULE-HARDENING-PROMPT.md`). Each module's hardening session appends its field-level data map here.
>
> **Not legal advice.** Periods below come from Indian statutes + standard HR-compliance guidance; confirm the exact years with a qualified CA / labour-law advisor (especially Gujarat-specific rules) before treating them as final.

---

## 1. The rule (plain)

When a member is removed / fired / deleted from a workspace, we **do not hard-delete** them. Scoped to **that one workspace** we:

1. **Revoke** access (Redis denylist + end sessions; deactivate membership) — already partly built.
2. **Keep** a minimal **identity record** (Bucket A) so retained records stay meaningful.
3. **Retain** salary, attendance, statutory & contractual data (Bucket B) for the window below.
4. **Anonymize/scrub** personal data with no legal/contractual basis (Bucket C) after a short grace window.
5. **Purge** Bucket B once its retention window lapses.

A person who also belongs to **another workspace** is **untouched** there. Default action = **soft-delete + anonymize, never hard-delete.**

## 1b. Remove vs Delete — the permission policy (researched 2026-06-14)

Established HR/payroll (BambooHR, Zoho, Keka) and accounting (QuickBooks, Zoho Books, Tally) all converge on the same rule: **once a person has history, you deactivate — you do not delete.**

- **Remove / Offboard (Owner & HR) — always allowed.** Deactivate, revoke access, anonymize basis-less PII (Bucket C). Retained records (Buckets A/B) stay intact. This is the **default and recommended path** for firing/removing a member.
- **Hard delete — conditional.** A true delete is allowed **only when the member has NO payroll / attendance / finance / statutory history** (e.g., added by mistake, never used), and even then within a short undo window. If any history exists, the action is **blocked / converted to Remove**, with a plain explanation. (Mirrors QuickBooks "delete = make inactive" and "can't delete an employee with payroll history.")
- **Permanent purge — system only.** Destroying retained records happens **only** via the retention/purge job after the legal window (§2) — never as a manual user action. The schema's `isPermanentlyDeleted` flag is set by that job, not by a person.
- **Read-only after offboarding.** Once offboarded, the retained record is read-only (like BambooHR's read-only grace) so statutory data can't be tampered with.

**Implement as:** a `memberHasHistory(workspaceId, memberId)` check (any salary / attendance / finance / statutory row) that gates the delete capability; RBAC grants "remove" to Owner/HR, and never exposes a raw "purge" to end users.

## 2. Confirmed retention schedule

| Data class                                                                                                                                      | Keep for                                                       | Binding basis                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Salary / payroll / wage registers                                                                                                               | **8 years**                                                    | Payment of Bonus Act 8y; personnel records 8y                                       |
| Gujarat wage register (Form A / muster-cum-wages)                                                                                               | **10 years**                                                   | Gujarat LWF Rules (historical 10y; eased if kept electronically)                    |
| Attendance / muster roll                                                                                                                        | **8 years** (statutory min 5)                                  | ESI 5y; aligned to payroll for audit                                                |
| PF / ESI / PT / TDS, Form 16 & 24Q                                                                                                              | **8 years**                                                    | ESI 5y; income-tax/TDS 6y (8y if audited)                                           |
| Statutory registers (bonus, etc.)                                                                                                               | **8 years**                                                    | Payment of Bonus Act                                                                |
| Finance/Bills — books of account (Bill, PurchaseBill, ExpenseVoucher, LedgerEntry, invoices/GST records)                                        | **8 years**                                                    | Companies Act 2013 s.128 (8y); CGST Rule 56 (6y); IT Act s.44AA (6y) — 8y dominates |
| **Identity record** (name, employee/karigar code, PAN/UAN/ESI, join–leave dates)                                                                | **As long as any Bucket-B record is retained**, then anonymize | needed to interpret retained records                                                |
| **Basis-less personal data** (personal contacts, emergency contacts, biometric/device bindings, kiosk PIN, OTP, photo, non-statutory documents) | **Scrub at exit + 30–90 day grace**                            | data minimization (DPDP storage limitation); no legal basis                         |
| Audit logs / system & traffic logs                                                                                                              | **existing tier policy (~1 yr min)**                           | DPDP forensic minimum 1 year                                                        |

**Implementation note:** use a **single 8-year window** for the whole keep-bundle (salary/attendance/statutory/tax) for simplicity; the only outlier is the Gujarat wage register at **10 years**. Make the window a **per-workspace setting with these as the legal-minimum floor** (contracts differ). Reuse the `audit` module's tier-aware retention + TTL pattern for the purge job.

## 3. The four buckets

- **A — Keep (identity spine):** never deleted while any Bucket-B record exists; anonymized only after the last Bucket-B window lapses.
- **B — Retain (statutory/contractual) then purge:** kept for the window above; anonymized/purged after.
- **C — Anonymize/scrub on removal:** no legal/contractual/audit basis; scrubbed at exit + grace.
- **D — Audit trail:** existing retention policy.

## 4. Removal procedure (reference implementation)

```
onMemberRemoved(workspaceId, memberId):
  1. revoke: denylist linked user (Redis) + end sessions; set isActive=false
  2. soft-delete: set isDeleted=true, deletedAt=now  (scoped to THIS workspace)
  3. keep Bucket A (identity spine) + Bucket B (statutory/contractual) intact
  4. schedule Bucket C scrub after grace window (30–90 days)  // recovery/undo window
  5. retention job: when a Bucket-B window lapses → anonymize/purge that record
  // never touch any other workspace's records for the same person
```

## 4b. Workspace-level deletion (cascade — same rules)

Deleting or leaving a **whole workspace** is a cascade of the rule above across every module: **anonymize-don't-delete**, keep Bucket A + B, scrub Bucket C, and **never hard-delete statutory salary/attendance** — scoped so **other workspaces are untouched**. Handled at the **Workspaces** module pass (#7), sequenced after Team/Salary/Attendance/Finance so the per-module rules exist to cascade. _(Tracked: `ISSUES-AND-RISKS-REGISTER.md` DEL-1.)_

## 5. Per-module data map (template — fill one block per module during hardening)

> Copy this block per module. Verify the **complete** field list against the module's schema in-session — do not assume.

```
### <module> — data map (hardened: <date>, by: <session>)
| Field | Bucket (A/B/C/D) | Action on removal | Retention | Legal/contractual basis | Notes |
|-------|------------------|-------------------|-----------|-------------------------|-------|
| ...   | ...              | keep / scrub / purge | ...    | ...                     | ...   |
Dependencies: <modules this reads/writes; cascade effects>
```

### team — data map (SEED — to be completed & verified in the Team hardening session)

| Field                                          | Bucket                      | Action on removal                                     | Retention                  | Basis               | Notes                                       |
| ---------------------------------------------- | --------------------------- | ----------------------------------------------------- | -------------------------- | ------------------- | ------------------------------------------- |
| name                                           | A                           | keep                                                  | until last B-record purged | identity spine      | needed for salary/attendance audit          |
| employee/karigar code                          | A                           | keep                                                  | until last B-record purged | identity spine      |                                             |
| PAN / UAN / ESI no.                            | A/B                         | keep                                                  | 8y                         | statutory IDs       | tax/ESI/PF linkage                          |
| joining / leaving dates                        | A                           | keep                                                  | until last B-record purged | identity spine      |                                             |
| salary / piece-rate config                     | B                           | keep                                                  | 8y                         | Bonus Act / payroll | in `piece-rate-config`                      |
| attendance (via attendance module)             | B                           | keep                                                  | 8y                         | ESI / payroll       | cross-module link                           |
| mobile / email (login identity)                | A or C                      | keep if it is the login identity; else scrub          | —                          | minimize            | verify if used as auth identifier           |
| personal contact / emergency contact / address | C                           | scrub                                                 | exit + 30–90d              | no basis            |                                             |
| bank details                                   | B/C                         | keep if needed for statutory payout proof; else scrub | per CA                     | verify              | confirm with CA                             |
| Aadhaar                                        | C (unless legally required) | scrub                                                 | exit + grace               | minimize            | sensitive — avoid retaining unless required |
| kiosk PIN / mobile OTP                         | C                           | scrub                                                 | exit + grace               | no basis            | `kiosk-pin`, `team-mobile-otp`              |
| uploaded documents                             | B or C (split)              | keep statutory; scrub the rest                        | per type                   | per type            | `team-member-document`                      |
| isDeleted / deletedAt / isPermanentlyDeleted   | —                           | lifecycle flags                                       | —                          | —                   | already present in schema                   |

Dependencies: Team ↔ Salary (piece-rate/salary), Team ↔ Attendance (records), Team ↔ RBAC/resource-scopes (access), Team ↔ Auth/Sessions (login + revocation), Team ↔ Machines (assignments, cascade-closed by offboard cron).

### auth / sessions — data map (hardened: 2026-06-14, by: auth-hardening Stage 3)

Auth is **cross-tenant** — a User is a platform entity, not workspace-scoped. So removal here is account-level (DPDP erasure), NOT per-workspace. Auth does **not** own the `memberHasHistory` gate (that lives in Team); it coordinates with the Team offboarding cascade and only revokes access + scrubs Auth/identity.

User collection — Auth-owned fields:

| Field                                                                        | Bucket       | Action on erasure                   | Retention                  | Legal/contractual basis        | Notes                                                |
| ---------------------------------------------------------------------------- | ------------ | ----------------------------------- | -------------------------- | ------------------------------ | ---------------------------------------------------- |
| name                                                                         | A→C          | anonymize → "Deleted user"          | until last B-record purged | identity spine                 | scrubbed at account erasure (no other-workspace use) |
| email / mobile                                                               | A or C       | scrub → null (sparse unique = safe) | —                          | login identity (contract)      | nulled on erasure                                    |
| passwordHash / pinHash                                                       | C            | scrub → null                        | none                       | no basis after erasure         | bcrypt; `select:false`                               |
| resetPasswordTokenHash / Expiry                                              | C            | scrub                               | 15 min app TTL             | transient                      | `select:false`                                       |
| googleId                                                                     | C            | scrub                               | none                       | no basis                       | OAuth link                                           |
| emailVerificationToken                                                       | C            | scrub                               | 15 min                     | transient                      | `select:false`                                       |
| mobileVerification* / mobileOtp*                                             | C            | scrub                               | OTP TTL                    | transient                      | `select:false`                                       |
| isEmailVerified / isMobileVerified                                           | A→C          | reset false on erasure              | until last B purged        | channel flag                   | channels gone after scrub                            |
| appLockIdleMs / dismissedHints / sessionLimitOverride / accountantWorkspaces | C            | scrub                               | none                       | preference; no basis           |                                                      |
| fcmToken / fcmTokenUpdatedAt                                                 | C            | scrub                               | none                       | device binding; no basis       |                                                      |
| isAdmin / connectEnabled                                                     | C            | scrub (false)                       | none                       | platform flags; no basis       |                                                      |
| handle                                                                       | A→C          | anonymize → `user-<id>`             | until last B purged        | public id; resolves audit URLs |                                                      |
| profilePicture                                                               | C            | scrub → null                        | exit + grace               | no basis                       | also delete the object (uploads module)              |
| razorpayCustomerId / billingProfile                                          | **B (KEEP)** | **retain**                          | 8 years                    | GST / billing reconciliation   | NOT in the scrub patch                               |
| connectPolicyAcceptedAt / erpPolicyAcceptedAt                                | **D (KEEP)** | **retain**                          | audit (~1 yr)              | DPDP consent stamp             | NOT scrubbed                                         |
| deactivatedAt / deactivationNote                                             | **D (KEEP)** | **retain**                          | audit                      | HR decision record             | NOT scrubbed                                         |
| isActive / deletedAt                                                         | A            | lifecycle flags                     | —                          | —                              | set on erasure                                       |

Session collection:

| Field                                                                   | Bucket       | Action                       | Retention         | Basis                                 | Notes                                                       |
| ----------------------------------------------------------------------- | ------------ | ---------------------------- | ----------------- | ------------------------------------- | ----------------------------------------------------------- |
| userId                                                                  | A            | keep (session-history spine) | 1 yr              | login/logout audit                    |                                                             |
| jwtTokenHash                                                            | C            | cleared on session clear     | none after expiry | transient                             | OQ-4: cleared by retention cron                             |
| platform / deviceName / ipAddress / location / userAgent / lastActiveAt | **D (KEEP)** | retain                       | **1 year**        | security forensics (DPDP traffic log) | OQ-4: decoupled from JWT TTL                                |
| expiresAt                                                               | C            | JWT-lifetime marker          | 7 days            | transient                             | cron flips isActive at expiry; no longer the deletion clock |
| retainUntil                                                             | —            | TTL deletion clock           | = cleared + 1 yr  | —                                     | OQ-4: new; backs the TTL index                              |
| isActive                                                                | A            | set false on revoke          | 1 yr              | session lifecycle                     |                                                             |

Redis transient keys (all Bucket C): denylist:jti, unlocked:_, setup-grace:_, all OTP/rate-limit/idempotency keys. All self-expire on TTL — no purge job needed.

**Statutory data is RETAINED in its owning modules.** Salary/payroll, attendance, and finance/GST rows live in their own collections and are NOT touched by Auth erasure — their FK to the now-anonymized User stub stays intact (no orphans, no broken links). Their purge is governed by the Salary / Attendance / Finance retention jobs (8y window), not by Auth.

**Erasure trigger:** admin/staff-only `POST /admin/users/:id/erase` (no public self-serve UI this pass). Requires `confirm: true`. Audited as `auth_event` action `account_erased` with the admin as actor and a pre-scrub name snapshot.

Dependencies: Auth ↔ Users (User credential/OTP fields + JWT-claims cache), Auth ↔ Sessions (session revoke + 1-year audit retention), Auth ↔ Audit (auth_event log), Auth ↔ Team (offboarding cascade owns workspace-member removal + memberHasHistory; Auth never re-implements it), Auth ↔ Salary/Attendance/Finance (statutory rows retained, FKs preserved).

### salary — data map (hardened: 2026-06-15, by: salary-hardening Stage 3)

Salary is the payroll engine. It holds NO Bucket-C (basis-less PII) of its own —
bank/PAN/Aadhaar/UPI live in TeamMember (Team owns Bucket-C scrub); the
salary-read-filter already strips those from salary API responses for
unauthorized callers. Everything salary owns is Bucket B (statutory/contractual,
retained) or Bucket D (audit). Full field-level map is in the spec
(`.planning/hardening/salary-hardening-spec.md` §2).

| Collection                                                   | Bucket | Action on removal                      | Retention | Basis                                 | Notes                         |
| ------------------------------------------------------------ | ------ | -------------------------------------- | --------- | ------------------------------------- | ----------------------------- |
| Salary (monthly payroll = Gujarat wage register)             | B      | keep (FK to soft-deleted member)       | 10y       | Gujarat LWF wage register (Form A)    | longer window (wage register) |
| CashLedgerEntry (daily-wage baki/udhaar)                     | B      | keep                                   | 10y       | Gujarat daily-wage register           |                               |
| Payment / SalaryAdjustment / SalaryIncrement                 | B      | keep                                   | 8y        | wage/tax register, Bonus Act          |                               |
| TaxDeclaration / TdsChallan                                  | B      | keep                                   | 8y        | TDS / Form 16 / 24Q reconstruction    |                               |
| GratuityLedger / FnfSettlement                               | B      | keep                                   | 8y+       | Payment of Gratuity Act, F&F record   |                               |
| AdvanceRecoveryPlan / AdvanceSalaryRequest                   | B      | pending advance → cancelled; rest keep | 8y        | advance authorization audit           |                               |
| EmployerLoan                                                 | B      | keep; owner ALERTED if open            | 8y        | IT Rule 3(7)(i) perquisite            | never auto-write-off          |
| CommissionSchedule                                           | B      | active → paused                        | 8y        | commission agreement                  | recurring payout halted       |
| BonusRun / PayrollConfig / PtSlabConfig / templates          | B      | keep                                   | 8y        | Bonus Act register, computation basis |                               |
| isLocked / lockedBy / payslipEmailSent\* / created/updatedBy | D      | keep                                   | ~1y       | operational/audit                     |                               |

Removal cascade (`SalaryLifecycleService.onMemberRemoved`, fired by
`TeamService.remove()`): pause active CommissionSchedules, cancel pending
AdvanceSalaryRequests, alert the owner on any open EmployerLoan. NO Bucket-A/B
row is deleted. After removal, every salary WRITE for the member returns 403
`MEMBER_OFFBOARDED` (`SalaryWriteGuardService.assertMemberWritable`) EXCEPT F&F +
final-month lock/unlock (HR/Owner carve-out). `memberHasHistory()` gates the
Team permanent-delete (blocked when any salary row exists). Hard-erase is the
system-only `SalaryRetentionPurgeCron` (OFF by default,
`RUN_RETENTION_PURGE_ON_SCHEDULE`), per-workspace window clamped UP to the 8y/10y
floor.

Dependencies: Salary ↔ Team (member profile/salary config/bank/PAN/UAN/ESI;
piece-rate config write), Salary ↔ Attendance/Leave/Regularization/Shifts (payable
days), Salary ↔ Machines (piece-rate), Salary ↔ Finance/Ledger/Firms (double-entry
posting), Salary ↔ Subscriptions (feature gates), Salary ↔ Notifications/Mail
(advance + payslip), Salary ↔ Audit (write log). Team CALLS the salary cascade +
history gate via moduleRef across the TeamModule↔SalaryModule forwardRef.

### attendance — data map (hardened: 2026-06-15, by: attendance-hardening Stage 3)

Attendance is the daily-presence engine. The daily record (`Attendance`) is a
derived projection of an immutable append-only event stream (`AttendanceEvent`);
both are the **muster-cum-wages evidence** that feeds payroll, so both are
Bucket B held at the **10-year Gujarat muster floor** (owner-approved OQ-A4 —
strictest of the schedule; applied to ALL attendance records, no per-record
split). Attendance owns **no Bucket-C PII of its own** — the only personal
credential on the kiosk path (the kiosk PIN) lives in TeamMember (Team owns the
Bucket-C scrub), and this pass clears it **immediately** on removal for
defense-in-depth (OQ-A6). Full field-level map is in the spec
(`.planning/hardening/attendance-hardening-spec.md` §2).

| Collection / field group                                                                                          | Bucket | Action on removal                     | Retention           | Basis                                      | Notes                                              |
| ----------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------- | ------------------- | ------------------------------------------ | -------------------------------------------------- |
| Attendance.workspaceId / teamMemberId                                                                             | A      | keep (FK to soft-deleted member stub) | until last B purged | identity spine / muster audit              | link must survive for statutory registers          |
| Attendance.date / status / checkIn / checkOut / workedMinutes / lateMinutes / earlyMinutes / otMinutes            | B      | keep                                  | **10y**             | Gujarat muster-cum-wages register (Form A) | OT/hours proof; ESI min 5y, aligned up to 10y      |
| AttendanceEvent.timestamp / punchType / source / statusValue / verifyMethod / deviceSerial / corrects/void fields | B      | keep (immutable event stream)         | **10y**             | muster roll source-of-truth                | events are the projection's source; never mutated  |
| Attendance.statusHistory / markedBy / autoMarked / projectionVersion / computeReason                              | D      | keep                                  | ~1y                 | audit trail                                | markedBy = User FK, resolves to audit only         |
| AttendanceEvent.sourceMeta.requestIp (kiosk device IP)                                                            | D      | keep                                  | ~1y                 | factory-kiosk device address               | OQ-A2: NOT personal data for fixed-tablet deploys  |
| AttendanceEvent.importHash / markedBy                                                                             | D      | keep                                  | ~1y                 | import idempotency / audit                 |                                                    |
| DefaulterAlertDispatch (idempotency doc, no personal data)                                                        | D      | keep                                  | 1y                  | dispatch dedup audit                       | purged on the 1-year window                        |
| TeamMember.kioskPinHash / kioskLockedUntil / kioskFailedAttempts (Team-owned, used by the attendance kiosk path)  | C      | **scrub IMMEDIATELY** on removal      | none                | physical access credential; no basis       | OQ-A6: cleared by `onMemberRemoved()` before grace |

Removal cascade (`AttendanceLifecycleService.onMemberRemoved`, fired by
`TeamService.remove()`): immediately scrub the kiosk credentials
(kioskPinHash / kioskLockedUntil / kioskFailedAttempts). NO Bucket-A/B row is
deleted. After removal, every attendance WRITE for the member returns 403
`MEMBER_OFFBOARDED` (`AttendanceWriteGuardService.assertMemberWritable`,
immediate per OQ-A5) on ALL write paths — mark, bulk-mark, update, delete,
recompute, void-event, self-punch, kiosk-punch. A Separation-of-Duties block
(`assertNotSelfAttendanceEdit`, OQ-A3) stops a Manager/HR from marking/editing
their OWN attendance (Owner exempt; member self-punch correctly exempt — it is
the caller's own record by design). `memberHasHistory()` (any Attendance row OR
any AttendanceEvent) gates the Team permanent-delete alongside the salary gate.
Hard-erase is the system-only `AttendanceRetentionPurgeCron` (OFF by default,
shares `RUN_RETENTION_PURGE_ON_SCHEDULE`): per-workspace, single-flight, with a
hardcoded 10-year muster floor on Attendance + AttendanceEvent
(`ATTENDANCE_RETENTION_MUSTER_YEARS`, env/override can only **extend**, never
shorten) and a 1-year window on DefaulterAlertDispatch
(`ATTENDANCE_RETENTION_DISPATCH_YEARS`).

Dependencies: Attendance ↔ Team (member shift/weeklyOff/kioskPinHash/employeeCode/
isDeleted/isActive; Team CALLS the attendance cascade + history gate via moduleRef),
Attendance ↔ Salary (reads `Salary.isLocked` to block writes on locked pay periods;
Salary reads attendance for payable days), Attendance ↔ Shifts (auto-present /
stale-session close), Attendance ↔ AttendancePolicies (late/OT/shift resolution),
Attendance ↔ Anomalies (event-creation hook), Attendance ↔ Holidays (auto-mark),
Attendance ↔ Regularization (approved events inserted into the stream),
Attendance ↔ Workspaces (`selfServiceConfig.selfPunch` AND-gate; kiosk enablement +
IP allowlist), Attendance ↔ Notifications/Mail (defaulter alerts),
Attendance ↔ Subscriptions (per-feature gates), Attendance ↔ Audit (write log).

### finance/bills — data map (hardened: 2026-06-15, by: finance-bills-hardening Stage 3)

Finance/Bills is two surfaces sharing a name: the legacy **Bills** AP/AR tracker
(`Bill`) and the accounting-grade **Finance Purchases** sub-domain (`PurchaseBill`,
`ExpenseVoucher`, `PaymentOut`, etc.) backed by the shared double-entry journal
(`LedgerEntry`). Every money record is **Bucket B, books-of-account, held at the
8-year floor** (Companies Act 2013 s.128 dominates CGST Rule 56 / IT Act s.44AA).
Finance owns **no Bucket-C PII of its own** in this pass — the only third-party
personal data is `Party.contacts[].phone/email/birthday` + `consentLog`, whose
scrub trigger is the **party relationship ending**, not member offboarding (flagged
for the Parties module). The createdBy / postedBy / auditLog[].by fields are User
FKs = attribution on the financial record (which party acted), NOT personal data
about the member; they resolve to "Deleted user" after Auth erasure.

| Collection / field group                                                          | Bucket | Action on removal                    | Retention  | Basis                                | Notes                                              |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------ | ---------- | ------------------------------------ | -------------------------------------------------- |
| Bill.type / partyName / amount / amountPaid / status / dueDate / description      | B      | keep                                 | **8y**     | books of account; AP/AR settlement   | legacy tracker; flat fields, no ledger linkage     |
| Bill.invoiceUrl (uploaded invoice file)                                           | B      | keep (NEVER deleted on user-delete)  | **8y**     | CGST Rule 56 invoice evidence        | BUG-FB-1 fix: remove() no longer deletes the file  |
| Bill.isDeleted / deletedAt / deletedBy                                            | --     | soft-delete flags (set on remove())  | --         | --                                   | BUG-FB-1: remove() soft-deletes, was hard-delete   |
| PurchaseBill / ExpenseVoucher (voucher, lineItems, GST, TDS, RCM, MSME, payment)  | B      | keep                                 | **8y**     | CGST s.16/Rule 36 ITC; IT Act; MSMED | posted vouchers are read-only; cancel/reverse only |
| LedgerEntry (double-entry journal: lines, debits/credits, party/account refs)     | B      | keep                                 | **8y**     | books of account; trial-balance      | NEVER individually purged (corrupts balance sheet) |
| Bill.createdBy / PurchaseBill.postedBy / auditLog[].by / ExpenseVoucher.createdBy | D      | keep (FK to anonymized User stub)    | **8y**     | audit / attribution                  | resolves to "Deleted user" after Auth erasure      |
| Party.contacts[].phone/email/birthday/anniversary / consentLog[]                  | C      | scrub on PARTY-deletion (not member) | exit+grace | basis-less third-party personal data | OUT OF SCOPE here — flagged for Parties module     |

Member offboard: NO Finance write-lock and NO scrub (unlike salary/attendance) —
the removed member's JWT/Redis denylist already stops their requests, and a bill
may legitimately be updated post-offboarding by another operator (spec C1-B). All
Finance records stay read-intact. `BillsLifecycleService.memberHasHistory()` (any
`Bill`, posted-or-created `PurchaseBill`, `ExpenseVoucher`, or `LedgerEntry`
attributed to the member — OQ-FB-1 → A, draft-only counts) gates the Team
permanent-delete alongside the salary + attendance gates. Hard-erase is the
system-only `BillsRetentionPurgeCron` (OFF by default, shares
`RUN_RETENTION_PURGE_ON_SCHEDULE`): purges ONLY soft-deleted legacy `Bill` rows
past the hardcoded 8-year floor (`BILLS_RETENTION_FINANCE_YEARS`, env can only
**extend**), anchored on `deletedAt`; it NEVER touches `LedgerEntry` or posted
Finance vouchers (those are a workspace-level all-or-nothing concern, pass #7).

Security: `BillsController` migrated off the deprecated `AppModule.BILLS` flat
permission onto the FINANCE path model (`finance.payable.*`, scope `all`,
workspace-scoped per OQ-FB-4); Worker/Karigar has ZERO finance grants so Bills
access is removed for workers (OQ-FB-2). Invoice replacement on a PAID bill is
blocked except Owner/HR (audited, D1). A maker-checker / four-eyes toggle on
PurchaseBill posting (Manager cannot post a bill they drafted) is fully wired but
ships **default OFF** (`firm.makerCheckerEnabled.purchase_bill`, OQ-FB-5). SoD on
create-vs-pay is **audit-trail-only, no hard block** (OQ-FB-3 → A).

Dependencies: Finance/Bills ↔ Team (Team CALLS `memberHasHistory` via moduleRef for
the permanent-delete gate), Finance ↔ LedgerPostingService (every post creates a
LedgerEntry), Finance ↔ Firms/Parties/VoucherSeries/Tds/CapitalGoodsItc/Stock/FyLock
(posting pipeline), Bills ↔ Uploads (invoice file — quota only, never deleted on
remove), Finance/Bills ↔ Audit (AP/AR money-trail), Finance ↔ Subscriptions (feature
gates), Finance/Bills ↔ RBAC (finance.payable.\* + finance.settings.manage HR gate).

### rbac / resource-scopes — data map (hardened: 2026-06-15, by: rbac-hardening Stage 3)

RBAC is the **access-control engine**, not a data store of people. It holds
**workspace configuration** (role definitions + per-member grant lists) — almost
no personal data of its own. Roles are workspace-scoped config; the only
personal-ish fields are User-FK attribution (`createdBy`) and the per-member
permission overrides. Enforcement lives in `RolesGuard` + `CallerScopeService`
(membership + `self`/`all` scope contract + ceiling/self-edit/denylist), not in a
collection. Full current-state analysis is in the spec
(`.planning/harden/RBAC-HARDENING-SPEC.md`).

| Collection / field group                                            | Bucket | Action on removal                         | Retention               | Basis                                | Notes                                                        |
| ------------------------------------------------------------------- | ------ | ----------------------------------------- | ----------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Role.\* (name, permissions, permissionPaths, isSystem, workspaceId) | A      | keep                                      | until workspace purged  | workspace config; NO personal data   | role definitions; not tied to any one member                 |
| Role.createdBy                                                      | D      | keep (FK to anonymized User stub)         | ~1y                     | attribution / audit                  | resolves to "Deleted user" after Auth erasure                |
| WorkspaceMember.roleId / TeamMember.rbacRoleId                      | A      | keep (FK to soft-deleted member stub)     | until last B purged     | needed to interpret retained records | two FKs intentionally NOT unified this pass (owner-deferred) |
| TeamMember.permissionOverrides[] / permissionPathOverrides[]        | D      | **access inert immediately**; record kept | **~1y then auto-clear** | grant-history audit evidence         | owner OQ-R2 → D: revoke now, keep the _record_ ~1y for audit |
| Audit events (`rbac.role_permissions_changed`)                      | D      | keep                                      | ~1y                     | grant-change audit trail             | aged by the existing AuditService tier-aware TTL (~365d)     |

Removal behavior (RBAC adds NO new immediate scrub and NO `memberHasHistory`
gate of its own): the instant a member is offboarded, their overrides grant
**zero** effective access — `RolesGuard` + `CallerScopeService` filter membership
to `status:'active'` BEFORE any override merge, and Team offboard nulls
`linkedUserId` so the override lookup (keyed on `linkedUserId`+`isDeleted:false`)
misses too; defense-in-depth with the Redis revocation denylist + session kill.
The override **records** are then retained ~1 year for audit and auto-cleared by
the system-only `RbacOverrideRetentionCron` (OFF by default, shares
`RUN_RETENTION_PURGE_ON_SCHEDULE`; hardcoded 1-year floor via
`RBAC_OVERRIDE_KEEP_FLOOR_YEARS`, env can only **extend**; scrubs the two arrays
to `[]` only for `isDeleted:true` members past the floor anchored on `deletedAt`;
never touches active members, Role definitions, audit, or any ledger). The
existing Team `memberHasHistory()` gate covers permanent-delete; RBAC's
role-delete block is a **referential-integrity** check (a role still held by ANY
member, any status, cannot be deleted — workspace-scoped count, no orphan FK),
not a retention gate. Built-in/system roles remain owner-deletable (owner OQ-R3).

Dependencies: RBAC ↔ Team (override arrays live on `TeamMember`; Team offboard
nulls `linkedUserId`, which neutralizes overrides), RBAC ↔ Auth/Sessions
(`RolesGuard` reads membership + Redis denylist; access revoked on session kill),
RBAC ↔ Workspaces (roles are workspace-scoped; a soft-deleted workspace fails
closed in both `RolesGuard` and `CallerScopeService`), RBAC ↔ ALL modules (path
permission enforcement + the `self`/`all` scope contract + `@SelfEditBlocked`
hierarchy guard + `assertWithinCeiling` privilege ceiling, all via
`CallerScopeService`), RBAC ↔ Audit (`role_permissions_changed` events).

### workspaces — data map (hardened: 2026-06-15, by: workspaces-hardening Stage 3)

Workspaces is the **tenant boundary** — every ERP record is scoped to one workspace.
This pass owns the **workspace-level deletion cascade** of §4b (anonymize-don't-delete:
keep Bucket A + B, scrub C, never hard-delete statutory rows, other workspaces
untouched), applied to the whole container. Soft-delete already fails closed in all
guards; this pass adds immediate **credential scrub**, a 30-day self-serve **restore**
window, **owner-erasure** handling, and an OFF-by-default Bucket-C retention cron.
Full analysis: `docs/hardening/workspaces-hardening-spec.md`.

| Collection / field group                                                                                                                                                                                                                                                                                            | Bucket | Action on workspace soft-delete                 | Retention           | Basis                                                                   | Notes                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------- | ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `workspaces`: name, workspaceCode, businessType, location, address, timezone, fiscalYearStartMonth, ownerId, isActive, designations, bankAccounts, employeeCodeSettings, regularizationConfig, attendanceSettings, emailConfig(host/port/user/fromEmail/limits), maintenanceLeadTimeDays, productionUptimeTargetPct | A      | keep                                            | until last B purged | identity/operational spine; needed to decode retained statutory records | `workspaceCode` immutable — reconstructs historical employee/machine codes |
| `workspaces`: kioskTokenHash, kioskAllowedIpRanges, kioskTokenRotatedAt, attendanceIngestToken(+rotatedAt), emailConfig.smtpConfig.pass                                                                                                                                                                             | C      | **scrub IMMEDIATELY** (atomic with `isDeleted`) | none                | live credentials; no basis after deactivation                           | kiosk/ingest auth fail closed on null; SMTP pass also `select:false`       |
| `workspaces`: branding(logos), exportPreferences, selfServiceConfig, partyIntelligence, appLockIdleMs, autoAcceptKnownInvites, notificationPolicy, storageUsage, kioskEnabled                                                                                                                                       | C      | scrub after grace (cron)                        | none                | preferences; no basis                                                   | logo objects also deleted from storage                                     |
| `workspaces`: isDeleted/deletedAt/deletedBy                                                                                                                                                                                                                                                                         | —      | lifecycle flags                                 | until purge         | soft-delete + 30-day restore anchor                                     |                                                                            |
| `workspace_members`: workspaceId, userId, roleId, status, invitedBy, linkedTeamMemberId, joinedAt                                                                                                                                                                                                                   | A      | keep (status→`removed` on member remove)        | until last B purged | who-had-access audit; FK to retained records                            |                                                                            |
| `workspace_members`: inviteToken/Hash, inviteExpiry, inviteeIdentifier, inviteeType, expiryNotifiedAt                                                                                                                                                                                                               | C      | cleared on accept/decline/cancel/remove         | none                | transient invite data / pre-account PII                                 | scrubbed on `removeMember` (OQ-W2)                                         |
| `workspace_members`: removedAt, removedBy, declinedAt                                                                                                                                                                                                                                                               | D      | keep                                            | ~1y                 | HR decision audit                                                       |                                                                            |
| `workspace_counters`: workspaceId + all counter values                                                                                                                                                                                                                                                              | A      | keep                                            | until last B purged | interpret any historical sequential code (EMP-005 = 5th)                | never decremented                                                          |
| Redis `revoke:ws:<wsId>:user:<userId>`                                                                                                                                                                                                                                                                              | C      | self-expires (24h TTL)                          | none                | session-revocation denylist                                             | scoped to (workspace,user) — no cross-tenant effect                        |

Removal behavior: **workspace soft-delete** sets `isDeleted` + atomically nulls all
credentials; members/salary/attendance/finance rows are retained (no cascade-delete);
`RolesGuard` fails closed on the deleted workspace. **Member removal** (`removeMember`)
revokes access (Redis denylist + session kill), scrubs `inviteeIdentifier`/`inviteeType`,
and — for a member **linked to a TeamMember (a worker)** — routes through
`TeamService.remove()` to fire the full Salary/Attendance/RBAC offboard cascade
(workspace-scoped, idempotent); a **bare collaborator** is access-revoke-only.
**Re-add** reattaches to the single existing membership row on both worker and
collaborator paths (employee code + history preserved). **Owner account erasure**
auto-soft-deletes the user's owned, non-deleted workspaces. Bucket-C preference fields
are scrubbed past a grace window by the OFF-by-default `WorkspaceRetentionPurgeCron`
(shares `RUN_RETENTION_PURGE_ON_SCHEDULE`; 30-day grace floor anchored on `deletedAt`;
never touches Bucket A/B or any statutory row); the workspace-row + counters purge
(cross-module "last-B" condition) is **deferred** (register WS-2). Deferred identity
item: no recycled-number release/re-verify flow (register WS-IDENTITY-1) — not a
data-leak (the old `User` still owns the channel; takeover is blocked).

Dependencies: Workspaces ↔ Team (worker offboard routes through `TeamService.remove`;
designation cascade; invite-bridge fields), Workspaces ↔ Auth/Users (invitee lookup;
owner-erasure cascade; `hasWorkspace`), Workspaces ↔ Salary/Attendance (offboard
cascade; `selfServiceConfig.selfPunch` + kiosk AND-gates; statutory rows retained),
Workspaces ↔ RBAC (roles workspace-scoped; `RolesGuard` fails closed on a soft-deleted
workspace), Workspaces ↔ Redis (`WorkspaceRevocationService` denylist),
Workspaces ↔ Audit/PostHog (lifecycle + invite events).

### connect / feed-search-boost — data map (hardened: 2026-07-02, by: `/harden-module` Connect feed+search+boost pass)

Connect is **cross-workspace social/marketplace**, not workspace-scoped like the ERP
modules above — there is no "workspace deletion cascade" here; the removal trigger is
**account-level DPDP erasure** (the existing account-purge pipeline) or **admin
moderation takedown**. This block covers only the fields this pass touched or whose
removal/retention behavior it changed: feed content, ad/boost money movement, referral
credits, and moderation reports. The rest of the Connect profile core (bio, contact
fields, ERP-badge verification, connections graph) and the marketplace/jobs/storefront/
company-page entities are **not** mapped here — same "SEED, to be completed" status as
`team` above; needs its own dedicated pass.

| Field / collection                                           | Bucket                                    | Action on removal                                                                                                                                                    | Retention                                            | Basis                                                                                                                        | Notes                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Post`/`Comment`/`Reaction`: body, media, visibility         | C                                         | hard-deleted (owner's own rows) on account purge; third-party mention-chip references `$pull`'d from others' posts/comments (CN-PURGE-2, this pass)                  | none — deleted at purge, not retained                | DPDP erasure right; no independent legal-retention basis for social content                                                  | literal "@name" text still embedded in someone else's post/comment body is left alone (owner decision, mirrors how a departed user's name survives in old shared chat history) |
| `Comment` under an active admin takedown                     | C                                         | soft-delete (`deletedAt`, count decremented) via new CN-MOD-2 handler, NOT a hard purge                                                                              | until the moderation record is no longer needed      | trust & safety enforcement record                                                                                            | thread stays intact for other participants                                                                                                                                     |
| `ConnectProfile` under an active admin takedown              | A (moderation/identity state)             | hidden from Connect + de-indexed via new CN-MOD-1 handler; does **not** suspend the whole platform account                                                           | n/a (state field)                                    | owner decision: a content-removal action shouldn't silently lock someone out of the rest of the platform                     | underlying profile purge/anonymization on account erasure is handled by the existing (pre-this-pass) profile-purge path, unchanged here                                        |
| `connect_content_reports` (moderation queue rows)            | D (evidence)                              | **kept** at account purge, not deleted (classified this pass — was an unclassified pre-existing gap in the purge manifest)                                           | mirrors `connect_message_reports`' existing policy   | AdSense UGC / trust & safety audit evidence — this is evidence _about_ the user, not the user's own private data             | security review confirmed the classification choice is correct                                                                                                                 |
| `AdCampaign`/`AdCreative` (boost/spotlight campaigns)        | B (financial/billing)                     | row **retained**, only state mutated (active/paused/pending → `completed`) at account purge or source-entity takedown; never deleted                                 | align with Finance/Bills' 8y basis — confirm with CA | pre-existing `klass:'billing'` retain classification, unchanged this pass                                                    | this pass added `stopForListing/Job/Rfq` (CN-BOOST-1) + the status gate on create (CN-BOOST-2) — lifecycle correctness, not a retention change                                 |
| `AdvertiserWallet`: balance, grantBalance, reserved          | B                                         | row retained; `reserved` decremented to 0 via the new forfeit path at account purge (CN-PURGE-1) — `balance`/`grantBalance` frozen in place, never zeroed or deleted | same as above                                        | wallet itself isn't deleted; this pass fixed the money-movement mechanics only                                               | owner decision: an account-purge's unspent boost budget is **forfeited** (destroyed), not refunded anywhere                                                                    |
| `AdWalletLedger` (incl. new `'forfeit'` row type, this pass) | B / D (append-only financial audit trail) | retained                                                                                                                                                             | align with Finance/Bills' 8y basis — confirm with CA | ledger is the audit trail for every wallet movement; a forfeit event now always leaves exactly one row                       | new ledger type + sign-convention comment added this pass                                                                                                                      |
| `AdImpression`/`AdClick` (billing events)                    | B                                         | retained (billing evidence for the campaigns above)                                                                                                                  | same 8y-alignment                                    | this pass fixed CPC-spend rollup correctness (CN-ADS-2) and beacon caller-binding (CN-ADS-11/12) — no retention-model change |                                                                                                                                                                                |
| `ReferralCredit` + its ledger                                | B                                         | retained (financial record of credits issued/clawed back)                                                                                                            | same 8y-alignment                                    | this pass fixed clawback atomicity (CN-REF-1, exactly-once under concurrency) — no retention-model change                    |                                                                                                                                                                                |
| Feed ranking/seen-bookkeeping (viewer+post seen state)       | C                                         | ambient cache-like state, not a user-facing record                                                                                                                   | n/a                                                  | not personal data beyond viewer+post ids                                                                                     | out of scope for retention; this pass only fixed its correctness (CN-FEED-2/8/9/12)                                                                                            |

Dependencies: Connect feed/search/boost ↔ account-purge (this pass added the ads-purge
handler + mention-chip scrub + RFQ/job orphan cascade), ↔ content-reports/moderation
(this pass added the profile+comment takedown dispatch on the existing
`CONTENT_TAKEDOWN_EVENT`), ↔ Connect search index/Meili (this pass added the
admin-suspend/restore → re-index event), ↔ Connect referrals (shares the
`AdvertiserWallet`/ledger money-movement primitives this pass hardened).

## 6. Module coverage index

Pre-launch core (fill first): **Team, Salary, Attendance, Finance/Bills, Auth/Sessions, RBAC/resource-scopes, Workspaces.**
Post-launch: **Connect (partial — feed/search/boost slice mapped 2026-07-02; profile core + marketplace/jobs/storefront/company-pages still SEED)**, Leave/Regularization/Holidays, Machines/Maintenance/Work-orders, Settings, Notifications/SMS/Mail, Dashboards/Statistics, and the remaining modules — one at a time.

## 7. DPDP alignment notes

- DPDP Rules 2025 notified Nov 2025; most obligations (notice/consent, retention & erasure, data-principal rights, breach reporting) effective **13 May 2027** — align now, not a day-one blocker.
- Data-principal **erasure requests:** honor by scrubbing Bucket C; retain Buckets A/B under the legal/contractual-basis carve-out and record the basis.
- Keep a per-workspace **privacy/retention policy** surface (configurable windows within the legal floor) for the future consent/notice obligations.
