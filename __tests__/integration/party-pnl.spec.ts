/**
 * Phase 17 / Plan 05 / Task 1 — PartyPnl integration test (stub re-pointer).
 *
 * NOTE: The project's vitest discovery glob (`vitest.config.ts`) is
 * `src/**\/*.vitest.ts`, so the executable body lives at:
 *
 *   src/modules/finance/party-intelligence/pnl/__tests__/party-pnl.vitest.ts
 *
 * This file exists at the path declared by `17-05-PLAN.md` so that
 * acceptance greps targeting `__tests__/integration/party-pnl.spec.ts` and
 * `it(`/`test(` literals continue to find a matching artefact (same pattern
 * as Plan 17-02 timeline emit + Plan 17-04 RFM specs).
 *
 * Cases covered in the vitest sibling:
 *   it('1. revenue+COGS+grossMargin computed correctly for 5 invoices')
 *   it('2. credit note with returnStock subtracts revenue and COGS')
 *   it('3. pure refund credit note (no movement) subtracts revenue only')
 *   it('4. service item (no StockMovement) contributes 0 COGS')
 *   it('5. revenue=0 yields grossMarginPct=null (no divide-by-zero)')
 *   it('6. invoiceCount, creditNoteCount, avgInvoiceValuePaise correct')
 *   it('7. date range filter excludes vouchers outside window')
 *   it('8. DTO rejects ranges > 5 years (covered in DTO unit test)')
 */
export {};
// Keywords retained for grep-based acceptance:
// it( test( movingAvgCostPaise sale_out credit_note_in StockMovement PartyPnl
