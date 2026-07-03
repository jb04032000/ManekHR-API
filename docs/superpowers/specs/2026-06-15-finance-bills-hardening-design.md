# Finance / Bills — Module Hardening Spec

**Date:** 2026-06-15
**By:** Stage 1 (Spec), pipeline session
**Status:** AWAITING HUMAN GATE — open questions below must be answered before coding begins.

---

## A. Module Map

### A1. What "Finance/Bills" actually means — two distinct surfaces

Reading the codebase reveals that "Finance/Bills" is **two separate systems** that share a name but are architecturally unrelated:

**Surface 1: Legacy `BillsModule`** (`crewroster-backend/src/modules/bills/`)

- A simple payable/receivable tracker with flat fields: `partyName`, `amount`, `dueDate`, `status`, `invoiceUrl`, `amountPaid`, `createdBy`.
- No double-entry posting, no GST, no ledger entries. It is a lightweight data-entry surface.
- `AppModule.BILLS` is already marked `@deprecated` in `modules.enum.ts`: "Use FINANCE module — bill capture moved to Finance.purchases."
- The web surface is `crewroster-web/app/dashboard/bills/page.tsx` — a client-side only page using `useEffect` + direct `axios` calls (no React Query), fetching the full list on every render.
- **Critical finding:** `BillsService.remove()` calls `findOneAndDelete` — this is a **hard delete** of a financial record. For any posted/paid bill, this destroys an AP/AR record permanently. There is no `isDeleted` soft-delete flag on the `Bill` schema.

**Surface 2: Finance `PurchaseBillModule`** and its sibling `Finance` sub-modules

- Path: `crewroster-backend/src/modules/finance/purchases/purchase-bill/`
- A full accounting-grade AP bill with double-entry via `LedgerPostingService`, TDS-194Q computation, RCM self-invoice, capital-goods ITC schedules, stock inward, fiscal-year locking, idempotency, and soft-delete (`isDeleted` / `deletedAt` already present).
- Sister modules that form the purchases sub-domain: `ExpenseVoucher`, `PurchaseOrder`, `GoodsReceiptNote`, `PaymentOut`, `TdsTracker`, `CapitalGoodsItcSchedule`.
- A shared `LedgerEntry` collection stores the double-entry journal and is the **financial source of truth** for every posted voucher across the entire Finance domain.
- The web surface is `crewroster-web/app/dashboard/finance/firms/[firmId]/purchases/` — i18n-wired, uses server actions from `finance-purchases.actions.ts`.

**Scope decision for this pass:** Both surfaces are in scope. The legacy Bills surface is the **higher-risk target** — it has a hard-delete bug and no retention model. Finance/PurchaseBills is more mature but needs retention, member-offboard guard, and SoD hardening.

---

### A2. Controllers and Routes

| Surface          | Controller                | Base Route                                                        | Methods                                                                                      |
| ---------------- | ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Legacy Bills     | `BillsController`         | `workspaces/:workspaceId/bills`                                   | GET (list), POST (create), GET :billId, PATCH :billId, DELETE :billId, POST :billId/payments |
| Purchase Bills   | `PurchaseBillController`  | `workspaces/:wsId/finance/firms/:firmId/purchases/bills`          | GET (list), POST (create), GET :id, PATCH :id, POST :id/post, POST :id/cancel, DELETE :id    |
| Expense Vouchers | `ExpensesController`      | `workspaces/:wsId/finance/firms/:firmId/expenses`                 | GET (list), POST (create), GET :id, PATCH :id, POST :id/post, POST :id/cancel                |
| Payment Out      | `PaymentOutController`    | `workspaces/:wsId/finance/firms/:firmId/purchases/payment-out`    | CRUD + post + cancel                                                                         |
| GRN              | `GrnController`           | `workspaces/:wsId/finance/firms/:firmId/purchases/grn`            | CRUD + confirm                                                                               |
| Purchase Order   | `PurchaseOrderController` | `workspaces/:wsId/finance/firms/:firmId/purchases/purchase-order` | CRUD + confirm + cancel                                                                      |

### A3. Services and Key Dependencies

- `BillsService` depends on: `BillModel`, `UploadsService`
- `PurchaseBillService` depends on: `PurchaseBillModel`, `LedgerPostingService`, `TdsService`, `CapitalGoodsItcService`, `VoucherSeriesService`, `FirmsService`, `PartiesService`, `StockMovementsService`, `LotsService`, `FyLockService`, `IdempotencyService`, `PostHogService`
- `ExpensesService` depends on: `ExpenseVoucherModel`, `AccountModel`, `LedgerPostingService`, `TdsService`, `CashRegistersService`, `FirmsService`, `VoucherSeriesService`, `PostHogService`
- `LedgerEntry` (shared across all Finance write paths): the double-entry journal; every `post` creates an immutable ledger entry linked by `sourceVoucherId` + `sourceVoucherType`

### A4. Collections Owned

| Collection                     | Module                 | Notes                                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `bills`                        | Legacy Bills           | Flat AP/AR tracker; no soft-delete                                 |
| `purchasebills`                | Finance Purchases      | Full AP bill with double-entry; has `isDeleted`                    |
| `expensevouchers`              | Finance Expenses       | GST-aware expense with double-entry; no soft-delete flag currently |
| `goodsreceiptnotes`            | Finance Purchases      | GRN; has `isDeleted`                                               |
| `purchaseorders`               | Finance Purchases      | PO; has `isDeleted`                                                |
| `paymentouts`                  | Finance Purchases      | Payment-out; check for `isDeleted`                                 |
| `ledgerentries`                | Finance Sales/Ledger   | Double-entry journal; shared across all Finance                    |
| `cheques`                      | Finance Cheques        | Cheque lifecycle; has `isDeleted`                                  |
| `cashregisters`                | Finance Cash Registers | Cash drawer tracking                                               |
| `tds194qtrackers`              | Finance Purchases/TDS  | Vendor cumulative TDS-194Q tracking                                |
| `capitalgoodsitcschedules`     | Finance CapitalGoods   | ITC amortization schedules from PurchaseBill                       |
| `parties`                      | Finance Parties        | Vendor/Customer master; has `isDeleted`                            |
| `accounts` (Chart of Accounts) | Finance Ledger         | CoA; has `isDeleted`                                               |

### A5. Web Surfaces

| Page                   | Path                                                                          | Data source                                     | React Query?                    |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| Legacy Bills list/CRUD | `app/dashboard/bills/page.tsx`                                                | `useEffect` + `listBills` server action         | No — manual `useState` + reload |
| Purchase Bills list    | `app/dashboard/finance/firms/[firmId]/purchases/purchase-bills/page.tsx`      | `useEffect` + `listPurchaseBills` server action | No — manual `useState`          |
| Purchase Bill detail   | `app/dashboard/finance/firms/[firmId]/purchases/purchase-bills/[id]/page.tsx` | Server action                                   | Needs checking                  |
| Purchase Bill new      | `app/dashboard/finance/firms/[firmId]/purchases/purchase-bills/new/page.tsx`  | Form submission                                 | -                               |
| Purchases hub          | `app/dashboard/finance/firms/[firmId]/purchases/page.tsx`                     | -                                               | -                               |

---

## B. Data Bucket Map

### B1. Legacy Bills (`Bill` collection)

| Field                           | Bucket | Action on member removal          | Action on member hard-delete      | Action on workspace delete | Retention           | Legal/contractual basis                 | Notes                                                                        |
| ------------------------------- | ------ | --------------------------------- | --------------------------------- | -------------------------- | ------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `workspaceId`                   | A      | keep (FK)                         | keep (FK, member removed from WS) | cascade-anonymize          | until last B purged | WS identity                             |                                                                              |
| `type` (payable/receivable)     | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | AP/AR classification                                                         |
| `partyName`                     | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | Third-party business name, not a data principal                              |
| `amount`                        | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account, Income Tax Act s.44AA | Monetary record                                                              |
| `amountPaid`                    | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | Payment evidence                                                             |
| `status`                        | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | AR/AP operational state                                                      |
| `dueDate`                       | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | Contractual term                                                             |
| `description`                   | B      | keep                              | keep                              | keep then purge            | 8y                  | books-of-account                        | Narration                                                                    |
| `invoiceUrl` (uploaded invoice) | B      | keep                              | keep                              | keep then purge            | 8y                  | GST Rule 56 / books-of-account          | Physical invoice evidence; must NOT be deleted while within retention window |
| `createdBy` (User FK)           | D      | keep (FK to anonymized user stub) | keep (stub survives)              | keep                       | 8y                  | audit trail, attribution                | Who created the record; resolves to "Deleted user" after erasure             |
| `_id`, `createdAt`, `updatedAt` | D      | keep                              | keep                              | keep                       | 8y                  | audit                                   | Mongoose timestamps                                                          |

**memberHasHistory (Legacy Bills):** TRUE when any `Bill` row exists for the workspace. Any bill — paid, pending, or overdue — is a financial obligation/settlement record. Block hard-delete.

### B2. Purchase Bill (`PurchaseBill` collection)

| Field                                                                         | Bucket | Action on member removal          | Action on member hard-delete | Action on workspace delete | Retention           | Legal/contractual basis                   | Notes                                                                                                                  |
| ----------------------------------------------------------------------------- | ------ | --------------------------------- | ---------------------------- | -------------------------- | ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`, `firmId`                                                       | A      | keep (FK)                         | keep                         | cascade                    | until last B purged | WS/firm identity                          |                                                                                                                        |
| `voucherNumber`, `voucherDate`, `financialYear`                               | B      | keep                              | keep                         | keep then purge            | 8y                  | Income Tax Act s.44AA; CGST Rule 56       | GST invoice retention: 6y from FY end (CGST Rule 56); aligned to 8y                                                    |
| `state` (draft/posted/cancelled)                                              | B      | keep                              | keep                         | keep then purge            | 8y                  | audit                                     |                                                                                                                        |
| `partyId`, `partySnapshot`                                                    | B      | keep                              | keep                         | keep then purge            | 8y                  | GSTR-2A reconciliation; CGST Rule 36      | partySnapshot contains: name, GSTIN, PAN, MSME status — all business entity data, not personal PII of a data principal |
| `vendorBillNumber`, `vendorBillDate`                                          | B      | keep                              | keep                         | keep then purge            | 8y                  | GSTR-2A reconciliation                    |                                                                                                                        |
| `lineItems` (HSN, qty, rate, GST)                                             | B      | keep                              | keep                         | keep then purge            | 8y                  | CGST s.16 / Rule 36 ITC claim basis       | ITC claim requires original invoice data                                                                               |
| `taxableValuePaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `grandTotalPaise` | B      | keep                              | keep                         | keep then purge            | 8y                  | CGST s.16; GSTR-3B/2A                     | Computed GST amounts                                                                                                   |
| `tds194Q` (TDS deduction details)                                             | B      | keep                              | keep                         | keep then purge            | 8y                  | TDS s.194Q; Form 26Q / 16A reconstruction |                                                                                                                        |
| `rcmSelfInvoice`                                                              | B      | keep                              | keep                         | keep then purge            | 8y                  | CGST Rule 47A; Sec 9(4) RCM               | Self-invoice for reverse charge                                                                                        |
| `msmeApplicable`, `msmePaymentDeadline`                                       | B      | keep                              | keep                         | keep then purge            | 8y                  | MSMED Act Sec 43B(h)                      | Compliance evidence                                                                                                    |
| `amountPaidPaise`, `amountDuePaise`, `paymentStatus`                          | B      | keep                              | keep                         | keep then purge            | 8y                  | books-of-account                          | Payment settlement state                                                                                               |
| `netPayableToCreditorsAfterTdsPaise`                                          | B      | keep                              | keep                         | keep then purge            | 8y                  | books-of-account                          | Creditor liability                                                                                                     |
| `ocrSourceFileUrl`, `ocrConfidence`, `ocrStatus`                              | B      | keep                              | keep                         | keep then purge            | 8y                  | original invoice; CGST Rule 56            | OCR scan of vendor invoice; same retention as the invoice                                                              |
| `sourcePoId`, `sourcePoNumber`, `sourceGrnId`, `sourceGrnNumber`              | B      | keep                              | keep                         | keep then purge            | 8y                  | procurement audit trail                   | Source document chain                                                                                                  |
| `postedBy`, `postedAt`                                                        | D      | keep (FK to anonymized user stub) | keep                         | keep                       | 8y                  | audit                                     |                                                                                                                        |
| `auditLog[]` (by, at, action, reason)                                         | D      | keep (FK to stub)                 | keep                         | keep                       | 8y / ~1y            | audit trail                               | Keep for the bill's retention lifetime; the `by` field resolves to "Deleted user" after erasure                        |
| `isDeleted`, `deletedAt`                                                      | --     | lifecycle flag                    | lifecycle flag               | lifecycle flag             | --                  | --                                        | Soft-delete flags (already present)                                                                                    |
| `idempotencyKey`                                                              | D      | keep                              | keep                         | keep                       | 8y                  | duplicate-post guard                      |                                                                                                                        |
| `postingStatus` (needs_attention)                                             | D      | keep                              | keep                         | keep                       | 8y                  | system audit                              | Quarantine flag                                                                                                        |

**memberHasHistory (PurchaseBill):** TRUE when any `PurchaseBill` row with `state = 'posted'` exists where `auditLog[].by === memberId` (i.e., member acted as poster or creator). Draft bills created-only by the member (never posted) are borderline — see OPEN QUESTION OQ-FB-1.

### B3. Expense Voucher (`ExpenseVoucher` collection)

| Field                                                                        | Bucket | Action on member removal | Retention           | Legal/contractual basis                | Notes                                 |
| ---------------------------------------------------------------------------- | ------ | ------------------------ | ------------------- | -------------------------------------- | ------------------------------------- |
| `workspaceId`, `firmId`                                                      | A      | keep                     | until last B purged | WS identity                            |                                       |
| `voucherNumber`, `voucherDate`, `financialYear`, `state`                     | B      | keep                     | 8y                  | Income Tax Act s.44AA; CGST Rule 56    |                                       |
| `partyId`, `partySnapshot`                                                   | B      | keep                     | 8y                  | books-of-account                       | Third-party entity data               |
| `lineItems[]` (amounts, GST, ITC eligibility)                                | B      | keep                     | 8y                  | CGST s.17(5) ITC blocking; GST Rule 56 | ITC claims require original line data |
| `taxableValuePaise`, `totalGstPaise`, `grandTotalPaise`, `netPayablePaise`   | B      | keep                     | 8y                  | CGST; books-of-account                 |                                       |
| `tdsApplied`                                                                 | B      | keep                     | 8y                  | TDS s.194C/H/J; Form 16A               |                                       |
| `paymentMode`, `cashRegisterId`, `bankAccountId`, `chequeId`, `utrReference` | B      | keep                     | 8y                  | payment evidence                       |                                       |
| `narration`, `isIntraState`, `placeOfSupplyStateCode`                        | B      | keep                     | 8y                  | GST place-of-supply compliance         |                                       |
| `createdBy`                                                                  | D      | keep (FK to stub)        | 8y                  | audit                                  |                                       |
| `auditLog[]`                                                                 | D      | keep                     | 8y                  | audit trail                            |                                       |

### B4. LedgerEntry (shared journal)

| Field                                                                      | Bucket | Action on member removal | Retention | Legal/contractual basis             | Notes                                         |
| -------------------------------------------------------------------------- | ------ | ------------------------ | --------- | ----------------------------------- | --------------------------------------------- |
| `workspaceId`, `firmId`, `financialYear`, `entryDate`                      | B      | keep                     | 8y        | Income Tax Act s.44AA; CGST Rule 56 | Core journal — most critical statutory record |
| `entryType`, `sourceVoucherId`, `sourceVoucherType`, `sourceVoucherNumber` | B      | keep                     | 8y        | audit; books-of-account             | Voucher chain integrity                       |
| `lines[]` (accountId, accountCode, accountName, debit, credit, partyId)    | B      | keep                     | 8y        | double-entry books; CGST; IT audit  | The accounting record itself                  |
| `narration`                                                                | B      | keep                     | 8y        | books-of-account                    |                                               |
| `isReversed`, `reversedBy`, `reversedAt`                                   | B      | keep                     | 8y        | reversal audit                      |                                               |
| `postedBy`, `postedAt`                                                     | D      | keep (FK to stub)        | 8y        | audit                               |                                               |
| `auditLog[]`                                                               | D      | keep                     | 8y        | audit trail                         |                                               |
| `clearedInReconciliation`, `clearedInSessionId`, `clearedAt`               | B      | keep                     | 8y        | bank reconciliation evidence        |                                               |

### B5. Other Finance Collections (abbreviated)

| Collection                       | Bucket      | Retention              | Notes                                                                                                                  |
| -------------------------------- | ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GoodsReceiptNote`               | B           | 8y                     | Goods-receipt evidence; linked to PurchaseBill                                                                         |
| `PurchaseOrder`                  | B           | 8y                     | Procurement contract; source of GRN/PurchaseBill chain                                                                 |
| `PaymentOut`                     | B           | 8y                     | Creditor payment evidence; allocations link to PurchaseBill                                                            |
| `Cheque`                         | B           | 8y                     | PDC/cheque instrument; linked to payment-out and ledger entries                                                        |
| `TdsTracker` (194Q)              | B           | 8y                     | Cumulative TDS tracking per vendor per FY; needed for Form 26Q                                                         |
| `CapitalGoodsItcSchedule`        | B           | 8y                     | Capital ITC amortization; CGST Rule 43 compliance                                                                      |
| `Party` (vendor/customer master) | B+C (split) | 8y (B); exit+grace (C) | B: name, GSTIN, PAN, MSME; C: contacts[].phone/email, birthday, anniversary, consentLog (basis-less personal contacts) |
| `Account` (Chart of Accounts)    | B           | 8y                     | CoA; firm-level config; retained for financial-statement reconstruction                                                |
| `CashRegister`                   | B           | 8y                     | Cash flow record                                                                                                       |

**memberHasHistory (combined Finance gate):** A member blocks hard-delete when ANY of the following exist for that workspace, attributed to that member: any `Bill`, any `PurchaseBill` (posted), any `ExpenseVoucher` (posted), any `PaymentOut` (posted), or any `LedgerEntry` where `postedBy === memberId`. `createdBy` on draft records is borderline (see OQ-FB-1).

---

## C. Four-Pillar Hardening Plan

### Pillar 1 — Data Lifecycle

#### C1-A. Legacy `BillsModule` — convert hard-delete to soft-delete

**Problem (BUG-FB-1, Severity: High):** `BillsService.remove()` calls `findOneAndDelete` — permanent hard-delete of an AP/AR financial record. There is no `isDeleted` flag on the `Bill` schema.

**Fix:**

1. Add `isDeleted: boolean` (default `false`) and `deletedAt?: Date` and `deletedBy?: Types.ObjectId` to `bill.schema.ts`.
2. Change `BillsService.remove()` to a soft-delete: `findOneAndUpdate({ isDeleted: true, deletedAt: new Date(), deletedBy: userId })`. Note: the `userId` is not currently passed to `remove()` in the controller — add it.
3. Change `findAll()` and `findById()` to add `isDeleted: false` to the filter (exclude soft-deleted bills from all reads).
4. Add an `isDeleted: false` partial filter to any unique-index on bills if applicable (currently none).
5. **Do NOT delete the `invoiceUrl` file** on soft-delete. The invoice PDF is statutory evidence and must be retained for 8 years. Remove the `uploadsService.deleteFile(currentBill.invoiceUrl, workspaceId)` call from `remove()`. Only delete the physical file once the retention window lapses (system purge job).
6. For `update()` (which deletes the old invoice URL when replaced): this is permitted for draft/pending bills where the document has not yet been formally submitted or relied upon. For `status = 'paid'` bills, block invoice replacement (a paid bill's invoice is evidence). Add a guard.

Pattern to copy: `PurchaseBill.softDelete()` and `PurchaseBillSchema.isDeleted` are the canonical reference.

#### C1-B. Member-offboard cascade for Finance/Bills

Finance vouchers are NOT owned by members the way salary records are. The key FK pattern differs:

- `LedgerEntry.postedBy`, `PurchaseBill.postedBy`, `PurchaseBill.auditLog[].by`, `ExpenseVoucher.createdBy`, `Bill.createdBy` are **User FKs on financial records** (which party was acting), not personal data about the member.
- When a member is offboarded, these FKs must continue to resolve for audit integrity. The FK points to the `User` document, which is soft-deleted with name anonymized to "Deleted user" at account erasure — this is already handled by the Auth erasure path (per `DATA-MAP-AND-RETENTION.md §auth` section).

**Immediate cascade on member removal (scoped to workspace):**

1. All `Bill` / `PurchaseBill` / `ExpenseVoucher` financial records created or posted by the member STAY INTACT. No scrub. No status change. No lock.
2. **No write-block needed** for finance (unlike salary). A removed member cannot create new bills (their JWT is revoked) — no additional finance-specific block is needed because finance endpoints enforce `RolesGuard` (workspace membership check) and the member's Redis denylist + session revocation already stops their requests.
3. The `createdBy` and `postedBy` FKs retain their ObjectId value. They resolve to "Deleted user" after Auth account erasure — this is the correct behavior per the data-map.

**No `MEMBER_OFFBOARDED` write-block for Finance:** Unlike salary (where a payroll write for an offboarded member is operationally wrong), a bill could legitimately be updated post-offboarding by another operator. The offboarding mechanism (Redis denylist + session kill) is sufficient. Do NOT add a `MEMBER_OFFBOARDED` gate to Finance write paths.

#### C1-C. memberHasHistory gate (for Team hard-delete)

Add `FinanceBillsHistoryService.memberHasHistory(workspaceId: string, userId: string): Promise<boolean>` that checks:

1. Any `Bill` where `createdBy === userId` and `workspaceId === workspaceId`
2. Any `PurchaseBill` where `workspaceId === workspaceId` and (`postedBy === userId` OR `auditLog[0].by === userId`)
3. Any `ExpenseVoucher` where `workspaceId === workspaceId` and `createdBy === userId`
4. Any `LedgerEntry` where `workspaceId === workspaceId` and `postedBy === userId`

Return TRUE if any match. This is then OR'd with the Salary and Attendance `memberHasHistory` checks in `TeamService` (same pattern as the salary and attendance lifecycle services).

Export from a `BillsLifecycleModule` that `TeamModule` imports via `forwardRef` (mirroring the `SalaryLifecycleService` / `AttendanceLifecycleService` pattern).

#### C1-D. Retention purge cron (OFF by default)

Add `BillsRetentionPurgeCron` (same shape as `SalaryRetentionPurgeCron` and `AttendanceRetentionPurgeCron`):

- Runs only when `RUN_RETENTION_PURGE_ON_SCHEDULE=true` (env, default false).
- Statutory floor: 8 years for all Finance/Bills data (`STATUTORY_FINANCE_FLOOR_YEARS=8`, hardcoded). Per-workspace override can only EXTEND, never shorten below 8y.
- Scope: only hard-purge `Bill` and (draft-only, never posted) `PurchaseBill` rows where the workspace retention window has lapsed AND `workspaceId` is the targeted workspace.
- **NEVER hard-purge `LedgerEntry`, `PurchaseBill` (posted), `ExpenseVoucher` (posted), `PaymentOut` (posted), `TdsTracker`, `CapitalGoodsItcSchedule`** — these are double-entry accounting records that cannot be individually purged without destroying the trial balance integrity. Purging the entire workspace's finance data after the retention window is an all-or-nothing operation (workspace-level purge, not member-level). This is a separate concern for the Workspaces hardening pass (#7).
- Single-flight: use the existing Redis-lock pattern (mirrors `SalaryRetentionPurgeCron`).
- Comment every delete call with: `// Bucket B — soft-deleted Finance/Bill record past retention window; no statutory value remaining; CGST Rule 56 / IT Act s.44AA floor = 8y`

#### C1-E. Party contacts — Bucket C scrub

The `Party` collection has `contacts[].phone`, `contacts[].email`, `contacts[].birthday`, `contacts[].anniversary` and `consentLog[]` — personal data of individual contacts at vendor/customer companies. These are personal data of third-party individuals (not workspace members or system users). They are Bucket C if the relationship ends, but the scrub trigger is the **party relationship ending** (party marked deleted), not the member offboarding. This is outside the member-offboarding lifecycle. Flag for the Parties module hardening.

---

### Pillar 2 — Tenant + Role Security

#### C2-A. Legacy BillsModule — security gaps (CRITICAL)

**Gap 1: `resource-scope.guard.ts` fail-open (SEC-3, tracked in register).**
The legacy `BillsController` uses `RolesGuard` (which resolves workspaceId from route params) — this is correct. However, the service-level queries all scope by `{ workspaceId }`, so tenant isolation exists at the service level. Verify the guard does not fail-open by confirming the route param `workspaceId` is always present (it is — it's in the base route `@Controller('workspaces/:workspaceId/bills')`).

**Gap 2: No scope enforcement (self vs all).**
`BillsController` uses the legacy `@RequirePermissions(AppModule.BILLS, ModuleAction.VIEW)` decorator with no scope parameter. `AppModule.BILLS` is deprecated. A Worker/Karigar can currently list ALL bills in a workspace if they have the BILLS VIEW permission — there is no `self` filter. Fix: in the hardening pass, either (a) restrict BILLS VIEW to Owner/HR/Manager preset only (no self-scope for this module — it is an AP/AR tracking surface, not self-service) or (b) migrate to `AppModule.FINANCE` with the correct path model. See OQ-FB-2.

**Gap 3: No role preset for BILLS — deprecated module.**
Since `AppModule.BILLS` is deprecated, the correct fix is to migrate the legacy Bills surface to use `AppModule.FINANCE` permissions. This requires a migration for any existing role grants on `AppModule.BILLS`. The web page at `app/dashboard/bills/` should eventually be redirected to or merged with the Finance Purchases surface. For this hardening pass, keep the BILLS controller functional but tighten permissions.

**Gap 4: SoD — bill creation vs bill payment.**
In the legacy Bills surface, the same permission (`BILLS.EDIT`) allows both creating a bill AND recording payment against it. Best practice (AP internal controls, per ICAI guidelines and enterprise accounting software like Tally/QuickBooks): the person who records a bill payable should not be the same person who records the payment. However, in a small-business ERP (the target market here), this SoD rule is commonly relaxed with an audit trail substituting for process segregation. Decision: see OQ-FB-3.

**Gap 5: No `actorId` passed to `BillsService.remove()`.**
The controller `remove()` handler does not inject `@Req() req` and therefore passes no `userId` to the service. After adding soft-delete, the `deletedBy` field requires the actor. Fix: add `@Req() req` and pass `req.user.sub`.

#### C2-B. Finance PurchaseBill — security status

`PurchaseBillController` correctly uses `@RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE/VIEW/EDIT/DELETE)` + `SubscriptionGuard`. Both `workspaceId` (`:wsId`) and `firmId` (`:firmId`) are route params, and the service queries filter on both (`{ workspaceId, firmId, isDeleted: false }`). Tenant isolation is solid.

**Remaining gaps:**

1. No `scope` parameter on any `@RequirePermissions` call. A `self`-scope user can list/view purchase bills they did not create (because the service does not filter by `createdBy`). This is correct for Finance (bill viewing is an operational function, not self-service) but should be documented. Decision: see OQ-FB-4.
2. The `cancel()` endpoint (`POST :id/cancel`) only cancels **draft** bills (the service checks `state !== 'posted'` and throws). A posted bill should go through a reversal (debit note). This is correctly enforced. Document the SoD implication: the poster and the canceller could be the same person — see OQ-FB-5.
3. No `@RequirePermission` on the `DELETE` endpoint uses the path model — it uses the legacy flat `ModuleAction.DELETE`. Migrate to path `finance.purchaseBill.delete` once the purchase-bill sub-feature is added to `permission-registry.ts`.

#### C2-C. Expense Voucher — security status

`ExpensesController` uses `@RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE/VIEW/EDIT)` and `SubscriptionGuard`. Route scopes both `wsId` and `firmId` correctly.

**Gap:** `post()` (which posts a draft to the ledger — a ledger-affecting action) uses `ModuleAction.CREATE`, the same permission as creating a draft. This means the same role that can draft can also post — no maker-checker enforcement. See OQ-FB-5 (SoD for posting).

#### C2-D. Worker/Karigar scope

Finance/Bills is NOT a self-service module for Workers. A Karigar should have NO access to bills, purchase bills, expenses, or payments — these are AP/AR management surfaces. Verify the seeded role presets for Karigar do NOT grant any `finance.*` permissions. If they do, remove them.

---

### Pillar 3 — Frontend Sync

#### C3-A. Legacy Bills page (critical issues)

1. **`BillsService.remove()` will become soft-delete.** The web page calls `deleteBill()` and then calls `load()` to refresh the list. After the soft-delete change, the refresh will fetch `{ isDeleted: false }` bills and the deleted bill will disappear correctly. No frontend change needed for the delete behavior.

2. **`invoiceUrl` file deletion removed from server.** The backend currently deletes the file on update (if replaced). After the hardening change, replacing the invoice URL on a paid bill will be blocked. The frontend `UpdateBillDto` does not block this — a PATCH to a paid bill currently updates fine. Add a guard in `BillsService.update()`: if `status === 'paid'`, reject `invoiceUrl` updates.

3. **No loading/empty/error states (Pillar 4 issue — see below).** The page uses `loading` state but has no error state UI — a network failure leaves the list silently empty. Add an error state display.

4. **i18n: the Bills page is NOT i18n-wired.** The page uses hardcoded English strings (`'Payable'`, `'Receivable'`, `'Delete this bill?'`, etc.). It does not use `useTranslations`. Add `finance.bills.*` i18n keys across all 4 locales.

#### C3-B. Purchase Bills page (minor issues)

1. The list page uses `useEffect` + manual `setState` instead of React Query. This means stale data is not automatically invalidated when bills are created/posted/cancelled in another tab. While not a blocking issue, this is a Pillar 4 efficiency gap.

2. The `needsAttention` quarantine filter re-fetches on every toggle — correct behavior, but the `useEffect` dependency array is correct.

3. No loading skeleton: the page shows a loading spinner but does not have a `loading.tsx` co-located file (binding rule: every data-fetching route needs one). Add `app/dashboard/finance/firms/[firmId]/purchases/purchase-bills/loading.tsx`.

4. The detail page and `new` page need audit for missing `loading.tsx` files.

#### C3-C. Post-hardening endpoint changes requiring FE sync

| Backend change                                                    | FE impact                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `DELETE /bills/:id` now soft-deletes (no 404 for already-deleted) | No change needed; response is still success                     |
| `PATCH /bills/:id` blocks `invoiceUrl` update on paid bill        | FE should disable invoice upload field when `status === 'paid'` |
| New `isDeleted` field in Bill response                            | FE filter already only shows active records (no change needed)  |
| New `deletedBy` field in Bill response                            | Not rendered; no change                                         |

---

### Pillar 4 — Frontend Efficiency

#### C4-A. Legacy Bills page — major issues

1. **No React Query — manual `useEffect` + `useState` pattern.** The page calls `load()` in a `useEffect` and also manually calls `load()` after every create/update/delete/payment. This causes at least 2 API calls on first render (mount + re-render from state changes) and is not cache-aware.

   **Fix:** Migrate to `useQuery(['bills', workspaceId, tab], () => listBills(workspaceId, { type: tab }))` with `staleTime: 30_000`. After mutations, call `queryClient.invalidateQueries(['bills', workspaceId])`. This eliminates the manual reload pattern and prevents N+1 fetches.

2. **Fetches ALL bills (no pagination).** `listBills` fetches all bills for the workspace and filters client-side by `type`. For large workspaces, this is a full-collection scan. The service already has `query.type` filtering — use it to fetch only the current tab's bills. Or add server-side pagination.

3. **Re-renders on tab change.** The `tab` state change triggers a re-render but the full bill list is already loaded — filtering is client-side (no API call). This is acceptable IF the data is paginated. With current full-list fetch, tab switching is efficient but the initial load is expensive.

4. **No Zustand selector narrowing.** `useWorkspaceStore` is used to get `currentWorkspaceId`. Verify it uses a narrow selector `(s) => s.currentWorkspaceId` rather than subscribing to the whole store. Current code: `const { currentWorkspaceId } = useWorkspaceStore()` — this subscribes to the full store and re-renders on any store change. Fix: `const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId)`.

5. **No empty state.** When `bills` is empty, the table shows the Ant Design empty state but there is no contextual empty CTA ("Add your first bill"). Add an empty state with a prompt.

#### C4-B. Purchase Bills page — issues

1. Same `useEffect` + manual `useState` pattern (same fix as above — migrate to React Query with `queryKey: ['purchaseBills', wsId, firmId, needsAttention]`).

2. `useWorkspaceStore` narrowing: `const wsId = useWorkspaceStore((s) => s.currentWorkspace?._id ?? '')` — this is correctly narrowed.

3. Missing `loading.tsx` (Pillar 3 cross-issue): add it.

4. No error state: a failed `listPurchaseBills` call sets `bills` to `[]` silently. Add an error display.

---

## D. SoD / Business-Logic Rules (decided after research)

**D1. Invoice replacement on paid bills — BLOCK.** Once a Bill has `status === 'paid'`, its `invoiceUrl` is statutory evidence of the settled obligation. Replacing it could constitute document tampering. Block `invoiceUrl` updates on paid bills. Exception: Owner/HR can replace a mis-uploaded document (with audit log entry). Implement as a guard in `BillsService.update()`.

**D2. SoD on legacy Bill payments — AUDIT-TRAIL-ONLY (no hard block).** For the small-business textile target market, a hard SoD block (no self-approval of bills) is operationally impractical. The correct posture (per ICAI small-business guidance and how Keka/Zoho handle this) is: allow the same user to create and pay a bill, but log both actions with actor attribution in the audit log. Hard SoD blocks are reserved for organizations with accounting staff (typically HR/Finance roles), not sole-operator operations. This is a policy decision — see OQ-FB-3 for owner input on whether to add the hard SoD block.

**D3. SoD on PurchaseBill posting — same-user block for Manager role.** The Finance `PurchaseBillController.post()` endpoint is a ledger-affecting action. Best practice (per ICAI, Tally's internal controls, and enterprise AP process): the person who CREATES a purchase bill draft should not be the same person who POSTS it to the ledger, unless they are Owner/HR. Implement as `@SodOwnerOnlyOnSelf` logic: if the caller is a Manager, block posting a bill they drafted (where `auditLog[0].by === caller.userId`). Owner and HR are exempt. This mirrors the salary SoD pattern. See OQ-FB-5.

**D4. Statutory retention floor — 8 years.** Confirmed per:

- CGST Rule 56: every registered person must keep accounts and records for 72 months (6 years) from the due date of filing the annual return for that year. Aligned to 8y for safety margin and consistency with the wider retention schedule.
- Income Tax Act s.44AA: books of account to be kept for 6 years; aligned to 8y for safety.
- Companies Act 2013 s.128: financial statements and books of account kept for 8 years — this is the binding floor for company entities.
- Hardcode `STATUTORY_FINANCE_FLOOR_YEARS=8` in the purge cron; env/workspace override can only extend.

**D5. LedgerEntry is NEVER individually purged.** Double-entry ledger entries form the audit chain for the trial balance. Individual entry deletion would corrupt the balance sheet. The only valid purge is workspace-level deletion after the retention window (covered in the Workspaces hardening pass #7). The Bills retention cron must NEVER touch `LedgerEntry`.

**D6. Posted financial vouchers are READ-ONLY after posting.** `PurchaseBill` in `posted` state: only `cancel` is allowed (and only if the FY is still open). This is already enforced in `PurchaseBillService.updateDraft()` (`state !== 'draft'` guard). Confirm this is consistent across all Finance sub-modules (ExpenseVoucher, PaymentOut, GRN).

**D7. Party contacts are Bucket C but the purge trigger is party-deletion, not member-offboarding.** The `Party.contacts[].phone/email/birthday` and `consentLog[]` are personal data of third-party individuals. Flag for Parties module hardening; out of scope for member offboarding cascade.

---

## E. Acceptance Criteria

### Pillar 1 (Lifecycle)

- AC-1.1: Calling `DELETE /workspaces/:wsId/bills/:id` sets `isDeleted: true` on the Bill document and returns HTTP 200. The Bill is NOT removed from MongoDB.
- AC-1.2: After soft-delete, `GET /workspaces/:wsId/bills` does NOT return the deleted Bill.
- AC-1.3: The invoice PDF file on storage is NOT deleted when a Bill is soft-deleted. The file URL is retained for 8 years.
- AC-1.4: `BillsRetentionPurgeCron` does NOT run when `RUN_RETENTION_PURGE_ON_SCHEDULE` is unset or `false`.
- AC-1.5: `FinanceBillsHistoryService.memberHasHistory(wsId, userId)` returns TRUE when the member has any `Bill`, posted `PurchaseBill`, posted `ExpenseVoucher`, or `LedgerEntry` attributed to them in that workspace.
- AC-1.6: `memberHasHistory` returning TRUE blocks the `team.member.delete_permanent` endpoint (403 with code `MEMBER_HAS_HISTORY`) — mirrors the Salary and Attendance pattern.
- AC-1.7: Attempting to update `invoiceUrl` on a Bill with `status === 'paid'` returns 400 with code `BILL_PAID_NO_DOC_REPLACE`.
- AC-1.8: A vitest for `BillsRetentionPurgeCron` pins: `STATUTORY_FINANCE_FLOOR_YEARS=8`; setting `retentionYears=1` in the workspace config still clamps to 8 years.

### Pillar 2 (Security)

- AC-2.1: A user from workspace B cannot read, update, or delete a Bill belonging to workspace A (403 or 404).
- AC-2.2: `GET /workspaces/:wsId/bills` with a valid JWT but no membership in `wsId` returns 403.
- AC-2.3: A Worker/Karigar role has no `finance.*` grants and no `bills.*` grants — `GET /workspaces/:wsId/bills` returns 403 for a Karigar.
- AC-2.4: `DELETE /workspaces/:wsId/bills/:id` now passes `req.user.sub` as `deletedBy` to the service (confirmed by a unit test checking `bill.deletedBy === userId` after soft-delete).
- AC-2.5: A PurchaseBill in `posted` state cannot be updated via `PATCH :id` (400 with message "Only draft vouchers can be updated").
- AC-2.6: Cross-workspace PurchaseBill read — `GET /workspaces/WS_A/finance/firms/F_A/purchases/bills/BILL_B` (where BILL_B belongs to WS_B) returns 404.

### Pillar 3 (Frontend Sync)

- AC-3.1: After the soft-delete backend change, the Bills page list refresh after delete shows the bill removed from the UI without errors.
- AC-3.2: The Bills page displays an error state (not a silent empty list) when the API call fails.
- AC-3.3: `finance.bills.*` i18n keys exist in all 4 locales (`en`, `gu`, `gu-en`, `hi-en`) and `check:i18n` passes.
- AC-3.4: The purchase bills list page has a co-located `loading.tsx` that mirrors the page's section structure.
- AC-3.5: The invoice upload field on the Bills edit modal is disabled (and shows a tooltip explanation) when `bill.status === 'paid'`.

### Pillar 4 (Efficiency)

- AC-4.1: `useWorkspaceStore` in both `bills/page.tsx` and `purchase-bills/page.tsx` uses a narrow selector (not a full-store subscription).
- AC-4.2: The Bills page uses `useQuery(['bills', workspaceId], ...)` with `staleTime: 30_000`; after a mutation, `invalidateQueries(['bills', workspaceId])` is called instead of manual `load()`.
- AC-4.3: The purchase bills list page uses `useQuery(['purchaseBills', wsId, firmId, needsAttention], ...)`.
- AC-4.4: No duplicate network calls on the Bills page initial load (verified via Network tab: exactly 1 GET request on mount).
- AC-4.5: Both list pages have non-empty empty-state UIs when the list is empty.

---

## F. Dependencies

| Direction          | Module                                 | Description                                                                         |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Bills WRITES TO    | `LedgerPostingService`                 | Every `post()` call on PurchaseBill/ExpenseVoucher/PaymentOut creates a LedgerEntry |
| Bills READS FROM   | `FirmsService`                         | To get firm config (fyStartMonth, stateCode, aato)                                  |
| Bills READS FROM   | `PartiesService`                       | To get party details for PurchaseBill posting                                       |
| Bills READS FROM   | `VoucherSeriesService`                 | To assign voucherNumbers                                                            |
| Bills READS FROM   | `TdsService`                           | TDS-194Q and TDS-194C/H/J computation at post time                                  |
| Bills WRITES TO    | `StockMovementsService`, `LotsService` | PurchaseBill post creates stock inward + lots                                       |
| Bills READS FROM   | `CashRegistersService`                 | ExpenseVoucher post debits the cash register                                        |
| Bills READS FROM   | `CapitalGoodsItcService`               | PurchaseBill post creates capital-goods ITC schedules                               |
| Bills READS FROM   | `FyLockService`                        | FY-lock guard on create/update/post                                                 |
| Bills READS FROM   | `IdempotencyService`                   | Concurrent-post guard on PurchaseBill                                               |
| Bills READS/WRITES | `UploadsService`                       | Legacy Bills: invoice file management                                               |
| Team CALLS Finance | `FinanceBillsHistoryService`           | memberHasHistory gate (new, needed for Team hard-delete)                            |
| Finance READS      | `TeamModule`                           | (indirect) actorId resolves to team member for audit display                        |
| Finance READS      | `SubscriptionsModule`                  | Feature gates on all Finance endpoints                                              |
| Finance READS      | `WorkspacesModule`                     | Workspace validation in guards                                                      |

**Cascade effects:**

- Adding `FinanceBillsHistoryService` to the `memberHasHistory` check in `TeamService` means that ANY workspace member who has ever posted/created a financial document is permanently non-hard-deletable until the retention window lapses (8 years). This is correct and expected behavior for any production financial system.
- The Bills purge cron shares the `RUN_RETENTION_PURGE_ON_SCHEDULE` env flag with the Salary and Attendance purge crons. All three are OFF by default.

**NOT in this pass (flag for later hardening):**

- `LedgerEntry` workspace-level purge (Workspaces pass #7)
- `Party.contacts` Bucket C scrub (Parties module)
- `ExpenseVoucher` SoD posting block (low priority — same-user draft+post is common in small business)
- Finance report caching and cache invalidation hardening
- Bank reconciliation (`ReconciliationSession`) lifecycle
- Fixed assets and depreciation runs lifecycle
- Sales invoice and credit/debit notes lifecycle (separate Finance Sales hardening pass)

---

## G. OPEN QUESTIONS — Human Gate Required

The following require a business or product decision that cannot be resolved by research. **Do not begin coding until these are answered.**

---

**OQ-FB-1: memberHasHistory — include draft-only bills?**

Context: A member who created a draft `PurchaseBill` but never posted it (so no ledger entry was created) still has a DB record attributed to them via `auditLog[0].by`. Should their membership be blocked from hard-delete?

Option A: Yes — any bill record (draft or posted) blocks hard-delete. Safest; consistent with the salary/attendance approach.
Option B: Only posted bills block hard-delete. Draft bills can be deleted (they have no ledger impact). Less restrictive; a "test draft" creator is not permanently locked.

**Recommendation: Option A** — keeping the rule simple (any record = locked) avoids edge cases and matches BambooHR/QuickBooks "never delete once any activity exists" philosophy. But this is a product decision.

---

**OQ-FB-2: Legacy Bills permissions — restrict to Owner/HR/Manager only, or keep current?**

Context: `AppModule.BILLS` is deprecated. The legacy Bills surface is AP/AR tracking — not appropriate for Karigar/Workers. Options:

Option A: Restrict immediately — no Karigar access; require at minimum Manager role for all Bills endpoints. Migrate legacy `BILLS.*` grants to `FINANCE.payable.view` etc.
Option B: Leave as-is for backward compat; migrate the web surface to Finance Purchases instead (longer-term plan).

**Recommendation: Option A** — remove Karigar access now; keep the endpoint for Manager/HR/Owner; flag the full migration to Finance Purchases as a separate task. This needs owner sign-off because it changes role grants.

---

**OQ-FB-3: SoD hard block on legacy Bill payment recording?**

Context: Should the same person who creates a payable Bill be blocked from recording payment against it? AP best practice says yes; small-business reality says no (often one person handles everything).

Option A: No hard block — maintain current behavior; rely on audit trail.
Option B: Block — Manager and below cannot record payment on a bill they created. Owner/HR exempt.

**Recommendation: Option A** for this market (textile SME, often 1-2 finance staff). If the owner wants Option B, it can be added as a flag. This is a product policy call.

---

**OQ-FB-4: Finance Purchase Bills — should `view` be scoped (self vs all)?**

Context: Currently, any user with `FINANCE.VIEW` can list ALL purchase bills in the workspace (no self filter). Is this the intended behavior, or should a Manager-equivalent only see bills they created?

Option A: All users with `finance.invoice.view` can see all bills (workspace-level, unscoped). Finance data is organizational, not personal — this matches Keka/Tally behavior.
Option B: A non-HR/Owner user can only see bills they created (`scope=self`).

**Recommendation: Option A** — Finance is an organizational module; scoping to self makes no operational sense for AP/AR management. But this should be confirmed since it affects the RBAC registry.

---

**OQ-FB-5: SoD block on PurchaseBill posting — maker-checker?**

Context: Should a Manager be blocked from posting a PurchaseBill that they themselves drafted? This is internal control best practice (four-eyes principle for AP). Options:

Option A: No hard block — audit trail only. Manager can draft and post the same bill.
Option B: Hard block — Manager cannot post a bill they created. HR/Owner or a different Manager must post. This requires that the `postedBy` !== `auditLog[0].by` check is enforced at service level.

**Recommendation: Option B for large orgs, Option A for small SME.** Since this is a textile SME product, recommend Option A with a workspace-policy toggle that larger orgs can enable. **This is a product policy call** and requires owner decision before coding the SoD guard.

---

**OQ-FB-6: Invoice file retention on legacy Bills soft-delete — should the file be immediately moved to cold storage?**

Context: After removing `uploadsService.deleteFile()` from the soft-delete path, the invoice PDF stays in the active R2 bucket for up to 8 years. For cost management, should it be moved to R2's cheaper storage tier on soft-delete?

Option A: Keep in active storage — simpler; R2 costs are low.
Option B: Move to cold/archive storage tier on soft-delete — cost optimization.

**Recommendation: Option A** for now (R2 pricing at scale makes this negligible for SME volumes). Revisit if storage costs become significant. Not blocking.

---

End of spec.
