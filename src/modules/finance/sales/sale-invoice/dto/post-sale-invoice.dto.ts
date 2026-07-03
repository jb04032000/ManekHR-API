/**
 * PostSaleInvoiceDto — empty body.
 * The idempotency key is passed via X-Idempotency-Key request header.
 * The controller (F-02-05) extracts it and passes to SaleInvoiceService.postInvoice().
 */
export class PostSaleInvoiceDto {}
