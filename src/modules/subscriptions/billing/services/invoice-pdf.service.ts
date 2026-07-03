import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as PDFDocument from 'pdfkit';
import { SubscriptionPayment } from '../schemas/subscription-payment.schema';
import { Plan } from '../../schemas/plan.schema';

interface PlatformLegalEntity {
  name: string;
  gstin: string;
  pan: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  email: string;
  phone: string;
  invoiceNumberPrefix: string;
}

/**
 * Typed empty fallback for the platform legal entity. ConfigService.get is
 * typed `T | undefined`; in practice env.ts always returns a populated object,
 * so this only guards the impossible-undefined case while keeping the field
 * derefs in `render()` type-safe. All string fields fall back to '' (env.ts
 * gives most fields the same '' default; invoiceNumberPrefix is unused here, it
 * lives in invoice.service, so '' is fine for this renderer's fallback).
 */
const EMPTY_PLATFORM_LEGAL_ENTITY: PlatformLegalEntity = {
  name: '',
  gstin: '',
  pan: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  stateCode: '',
  pincode: '',
  email: '',
  phone: '',
  invoiceNumberPrefix: '',
};

interface RenderArgs {
  payment: SubscriptionPayment;
  plan: Plan;
  invoiceNumber: string;
  invoiceDate: Date;
}

interface TaxBreakdown {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** Whether this is an inter-state supply (IGST) or intra-state (CGST+SGST). */
  isInterState: boolean;
}

/**
 * GST B2B invoice PDF renderer (D1f).
 *
 * Produces a single-page A4 invoice meeting Indian GST tax-invoice
 * requirements:
 *   - Title "TAX INVOICE", invoice number + date.
 *   - Supplier (platform legal entity) block — name, GSTIN, PAN, addr.
 *   - Recipient block — from `payment.billingSnapshot` (B2B if GSTIN
 *     supplied, else B2C).
 *   - Place of supply line (recipient state name + state code).
 *   - Line items table — description, HSN/SAC, qty, rate, amount.
 *   - Tax breakdown — CGST+SGST when supplier-state == place-of-supply,
 *     else IGST. Each shown as percentage + amount.
 *   - Total invoice amount + amount in words (legal requirement).
 *   - "Reverse Charge: No", footer note about computer-generated
 *     invoice (no signature required per Rule 46).
 */
@Injectable()
export class InvoicePdfService {
  constructor(private readonly configService: ConfigService) {}

  async render(args: RenderArgs): Promise<Buffer> {
    // ConfigService.get is typed `T | undefined`, but app.platformLegalEntity
    // always resolves to an object (env.ts supplies '' defaults for every
    // field). Fall back to an empty-string entity so the immediate field
    // derefs below stay type-safe without a non-null assertion.
    const supplier =
      this.configService.get<PlatformLegalEntity>('app.platformLegalEntity') ??
      EMPTY_PLATFORM_LEGAL_ENTITY;
    const breakdown = this.computeTaxBreakdown(args.payment, supplier);

    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Tax Invoice ${args.invoiceNumber}`,
        Author: supplier.name,
        Subject: 'GST Tax Invoice',
        Producer: 'ManekHR Billing',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const headerLogo = await this.fetchBrandLogo();
    this.drawHeader(doc, supplier, args, headerLogo);
    this.drawParties(doc, supplier, args.payment);
    this.drawPlaceOfSupply(doc, supplier, args.payment, breakdown);
    this.drawLineItems(doc, args, breakdown);
    this.drawTotals(doc, args.payment, breakdown);
    this.drawAmountInWords(doc, args.payment.totalPaise);
    this.drawFooter(doc, supplier);

    doc.end();

    return new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
  }

  // ── tax breakdown ───────────────────────────────────────────────────

  /**
   * Decide CGST+SGST (intra-state) vs IGST (inter-state) per the GST
   * Place of Supply rule. Place of supply = recipient's state. If the
   * recipient state code matches the supplier's, the supply is
   * intra-state and CGST + SGST apply (each 50% of the GST). Otherwise
   * IGST applies (full GST as IGST).
   *
   * Falls back to IGST when recipient state is unknown — safer for
   * tax compliance to over-collect IGST and let the customer reclaim
   * than to under-collect CGST+SGST and owe the state.
   */
  private computeTaxBreakdown(
    payment: SubscriptionPayment,
    supplier: PlatformLegalEntity,
  ): TaxBreakdown {
    const supplierStateCode = supplier.stateCode?.trim();
    const recipientStateCode =
      payment.billingSnapshot?.stateCode?.trim() || payment.billingSnapshot?.gstin?.slice(0, 2);

    const isInterState =
      !supplierStateCode || !recipientStateCode || supplierStateCode !== recipientStateCode;

    const totalGst = payment.gstPaise ?? 0;
    if (isInterState) {
      return {
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: totalGst,
        isInterState: true,
      };
    }
    const half = Math.floor(totalGst / 2);
    return {
      cgstPaise: half,
      sgstPaise: totalGst - half, // absorb any rounding remainder into SGST
      igstPaise: 0,
      isInterState: false,
    };
  }

  // ── layout ──────────────────────────────────────────────────────────

  /**
   * Fetch the configured invoice-header brand image. Returns null if not
   * configured or unreachable — caller falls back to text-only header.
   */
  private async fetchBrandLogo(): Promise<Buffer | null> {
    const url = this.configService.get<string>('branding.invoiceHeader');
    if (!url) return null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    } catch {
      return null;
    }
  }

  private drawHeader(
    doc: PDFKit.PDFDocument,
    supplier: PlatformLegalEntity,
    args: RenderArgs,
    logoBuffer: Buffer | null,
  ) {
    if (logoBuffer) {
      const pageWidth = doc.page.width - 80; // 40pt margin each side
      const maxLogoH = 80;
      const startY = doc.y;
      doc.image(logoBuffer, 40, startY, { fit: [pageWidth, maxLogoH], align: 'center' });
      doc.y = startY + maxLogoH + 12;
    }

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111');
    doc.text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text('Original copy for recipient · GST Tax Invoice (Section 31, CGST Act 2017)', {
      align: 'center',
    });
    doc.moveDown(1);

    // Invoice meta strip — number + date + place of supply (later block).
    const startY = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111');
    doc.text('Invoice #', 40, startY);
    doc.text('Invoice Date', 220, startY);
    doc.text('Reverse Charge', 400, startY);

    doc.font('Helvetica').fontSize(11).fillColor('#000');
    doc.text(args.invoiceNumber, 40, startY + 14);
    doc.text(this.formatDate(args.invoiceDate), 220, startY + 14);
    doc.text('No', 400, startY + 14);

    doc
      .moveTo(40, startY + 36)
      .lineTo(555, startY + 36)
      .strokeColor('#dddddd')
      .stroke();
    doc.y = startY + 46;
  }

  private drawParties(
    doc: PDFKit.PDFDocument,
    supplier: PlatformLegalEntity,
    payment: SubscriptionPayment,
  ) {
    const startY = doc.y;
    const colWidth = 250;

    // Supplier block (left).
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#666666');
    doc.text('SUPPLIER', 40, startY);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111');
    doc.text(supplier.name, 40, startY + 14, { width: colWidth });
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    let supplierY = doc.y;
    if (supplier.addressLine1) {
      doc.text(supplier.addressLine1, 40, supplierY, { width: colWidth });
      supplierY = doc.y;
    }
    if (supplier.addressLine2) {
      doc.text(supplier.addressLine2, 40, supplierY, { width: colWidth });
      supplierY = doc.y;
    }
    if (supplier.city || supplier.state || supplier.pincode) {
      const cityLine = [supplier.city, supplier.state, supplier.pincode].filter(Boolean).join(', ');
      doc.text(cityLine, 40, supplierY, { width: colWidth });
      supplierY = doc.y;
    }
    if (supplier.email) doc.text(`Email: ${supplier.email}`, 40, supplierY, { width: colWidth });
    if (supplier.phone) doc.text(`Phone: ${supplier.phone}`, 40, doc.y, { width: colWidth });
    doc.font('Helvetica-Bold').fontSize(9);
    if (supplier.gstin) doc.text(`GSTIN: ${supplier.gstin}`, 40, doc.y, { width: colWidth });
    if (supplier.pan) doc.text(`PAN: ${supplier.pan}`, 40, doc.y, { width: colWidth });
    if (supplier.stateCode)
      doc.text(`State Code: ${supplier.stateCode}`, 40, doc.y, { width: colWidth });
    const supplierEndY = doc.y;

    // Recipient block (right).
    const snap = payment.billingSnapshot ?? {};
    const recipientName = snap.businessName || snap.recipientName || 'Customer';
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#666666');
    doc.text('BILL TO', 310, startY);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111');
    doc.text(recipientName, 310, startY + 14, { width: colWidth });
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    let rY = doc.y;
    if (snap.addressLine1) {
      doc.text(snap.addressLine1, 310, rY, { width: colWidth });
      rY = doc.y;
    }
    if (snap.addressLine2) {
      doc.text(snap.addressLine2, 310, rY, { width: colWidth });
      rY = doc.y;
    }
    if (snap.city || snap.state || snap.pincode) {
      const cityLine = [snap.city, snap.state, snap.pincode].filter(Boolean).join(', ');
      doc.text(cityLine, 310, rY, { width: colWidth });
      rY = doc.y;
    }
    if (snap.recipientEmail)
      doc.text(`Email: ${snap.recipientEmail}`, 310, rY, { width: colWidth });
    if (snap.recipientContact)
      doc.text(`Phone: ${snap.recipientContact}`, 310, doc.y, { width: colWidth });
    doc.font('Helvetica-Bold').fontSize(9);
    if (snap.gstin) doc.text(`GSTIN: ${snap.gstin}`, 310, doc.y, { width: colWidth });
    if (snap.stateCode) doc.text(`State Code: ${snap.stateCode}`, 310, doc.y, { width: colWidth });
    const recipientEndY = doc.y;

    doc.y = Math.max(supplierEndY, recipientEndY) + 16;
  }

  private drawPlaceOfSupply(
    doc: PDFKit.PDFDocument,
    supplier: PlatformLegalEntity,
    payment: SubscriptionPayment,
    breakdown: TaxBreakdown,
  ) {
    const snap = payment.billingSnapshot ?? {};
    const stateCode = snap.stateCode || snap.gstin?.slice(0, 2) || '—';
    const stateName = snap.state || 'Not specified';
    // Task 3 — when this payment carries no GST (gstEnabled false ⇒ persisted
    // gstPaise 0), don't print a "Tax: CGST+SGST / IGST" descriptor; the
    // invoice has no tax component to describe.
    const hasGst = (payment.gstPaise ?? 0) > 0;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666');
    doc.text('Place of Supply:', 40, doc.y, { continued: true });
    doc.font('Helvetica').fillColor('#000');
    const taxSuffix = hasGst
      ? ` · Tax: ${breakdown.isInterState ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'}`
      : '';
    doc.text(` ${stateName} (${stateCode})${taxSuffix}`);
    doc.moveDown(0.8);
  }

  // `_breakdown` is unused (line items don't depend on the CGST/SGST split) —
  // underscore-prefixed to satisfy lint no-unused-vars; kept for call-site symmetry.
  private drawLineItems(doc: PDFKit.PDFDocument, args: RenderArgs, _breakdown: TaxBreakdown) {
    const tableTop = doc.y;
    const cols = {
      desc: 40,
      hsn: 280,
      qty: 340,
      rate: 380,
      amount: 480,
    };

    doc.rect(40, tableTop, 515, 22).fillColor('#f4f4f5').fill().fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111');
    doc.text('DESCRIPTION', cols.desc + 6, tableTop + 7);
    doc.text('HSN/SAC', cols.hsn, tableTop + 7);
    doc.text('QTY', cols.qty, tableTop + 7);
    doc.text('RATE', cols.rate, tableTop + 7, { width: 90, align: 'right' });
    doc.text('AMOUNT', cols.amount, tableTop + 7, { width: 75, align: 'right' });

    let rowY = tableTop + 28;
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    const desc = `${args.plan.name} subscription · ${this.cycleLabel(args.payment.billingCycle)}`;
    const sac = args.plan.sacCode || '998314';
    const taxableBase = (args.payment.planPricePaise ?? 0) - (args.payment.discountPaise ?? 0);

    doc.text(desc, cols.desc + 6, rowY, { width: 230 });
    doc.text(sac, cols.hsn, rowY);
    doc.text('1', cols.qty, rowY);
    doc.text(this.formatPaise(taxableBase), cols.rate, rowY, { width: 90, align: 'right' });
    doc.text(this.formatPaise(taxableBase), cols.amount, rowY, { width: 75, align: 'right' });
    rowY = doc.y + 8;

    if ((args.payment.discountPaise ?? 0) > 0) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666');
      const couponLabel = args.payment.appliedCouponCode
        ? `Coupon ${args.payment.appliedCouponCode}`
        : 'Discount';
      doc.text(`${couponLabel} (already applied)`, cols.desc + 6, rowY, { width: 400 });
      doc.text(`−${this.formatPaise(args.payment.discountPaise)}`, cols.amount, rowY, {
        width: 75,
        align: 'right',
      });
      rowY = doc.y + 8;
    }

    doc.moveTo(40, rowY).lineTo(555, rowY).strokeColor('#dddddd').stroke();
    doc.y = rowY + 8;
  }

  private drawTotals(
    doc: PDFKit.PDFDocument,
    payment: SubscriptionPayment,
    breakdown: TaxBreakdown,
  ) {
    const labelX = 350;
    const amountX = 480;
    const amountW = 75;
    const taxableBase = (payment.planPricePaise ?? 0) - (payment.discountPaise ?? 0);

    // Task 3 — optional/configurable subscription-plan GST. When the payment
    // carries no GST (gstEnabled false ⇒ persisted gstPaise 0), suppress the
    // IGST / CGST+SGST rows entirely (no "@ 0%" lines). The grand total below
    // then equals the taxable base, so the math stays correct (total == base).
    const hasGst = (payment.gstPaise ?? 0) > 0;

    doc.font('Helvetica').fontSize(10).fillColor('#111');
    doc.text(hasGst ? 'Taxable Value' : 'Amount', labelX, doc.y, { continued: false });
    doc.text(this.formatPaise(taxableBase), amountX, doc.y - 12, {
      width: amountW,
      align: 'right',
    });
    doc.moveDown(0.4);

    if (hasGst) {
      if (breakdown.isInterState) {
        doc.text(`IGST @ ${payment.gstRatePercent}%`, labelX, doc.y);
        doc.text(this.formatPaise(breakdown.igstPaise), amountX, doc.y - 12, {
          width: amountW,
          align: 'right',
        });
        doc.moveDown(0.4);
      } else {
        const halfRate = Number(payment.gstRatePercent ?? 0) / 2;
        doc.text(`CGST @ ${halfRate}%`, labelX, doc.y);
        doc.text(this.formatPaise(breakdown.cgstPaise), amountX, doc.y - 12, {
          width: amountW,
          align: 'right',
        });
        doc.moveDown(0.4);
        doc.text(`SGST @ ${halfRate}%`, labelX, doc.y);
        doc.text(this.formatPaise(breakdown.sgstPaise), amountX, doc.y - 12, {
          width: amountW,
          align: 'right',
        });
        doc.moveDown(0.4);
      }
    }

    doc.moveTo(labelX, doc.y).lineTo(555, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000');
    doc.text('Total', labelX, doc.y);
    doc.text(this.formatPaise(payment.totalPaise), amountX, doc.y - 14, {
      width: amountW,
      align: 'right',
    });
    doc.moveDown(1);
  }

  private drawAmountInWords(doc: PDFKit.PDFDocument, totalPaise: number) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666');
    doc.text('Amount in Words:', 40, doc.y, { continued: true });
    doc.font('Helvetica').fillColor('#000');
    doc.text(` ${this.numberToIndianWords(totalPaise)}`);
    doc.moveDown(1.5);
  }

  private drawFooter(doc: PDFKit.PDFDocument, supplier: PlatformLegalEntity) {
    doc.font('Helvetica').fontSize(8).fillColor('#888');
    doc.text(
      'This is a computer-generated invoice and does not require a signature (Rule 46, CGST Rules 2017).',
      40,
      doc.y,
      { width: 515, align: 'center' },
    );
    doc.moveDown(0.3);
    doc.text(`For queries, contact ${supplier.email || 'support'} · ${supplier.name}`, 40, doc.y, {
      width: 515,
      align: 'center',
    });
  }

  // ── formatting helpers ──────────────────────────────────────────────

  private formatPaise(paise: number): string {
    const rupees = (paise / 100).toFixed(2);
    return `₹${this.formatIndianNumber(rupees)}`;
  }

  /** Indian number system grouping: 1,23,45,678.90 (lakh / crore). */
  private formatIndianNumber(numStr: string): string {
    const [intPart, decPart] = numStr.split('.');
    const lastThree = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    const formatted = rest
      ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
      : lastThree;
    return decPart ? `${formatted}.${decPart}` : formatted;
  }

  private formatDate(d: Date): string {
    return d.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  }

  private cycleLabel(cycle: string): string {
    if (cycle === 'monthly') return 'Monthly billing';
    if (cycle === 'yearly') return 'Annual billing';
    if (cycle === 'lifetime') return 'Lifetime access';
    return cycle;
  }

  /** Convert paise → "Rupees X and Paise Y Only" Indian-English form. */
  private numberToIndianWords(paise: number): string {
    const rupees = Math.floor(paise / 100);
    const paisePart = paise % 100;
    const rupeesWords = this.indianNumberToWords(rupees);
    if (paisePart === 0) return `Rupees ${rupeesWords} Only`;
    return `Rupees ${rupeesWords} and Paise ${this.indianNumberToWords(paisePart)} Only`;
  }

  private indianNumberToWords(n: number): string {
    if (n === 0) return 'Zero';
    const ones = [
      '',
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
      'Six',
      'Seven',
      'Eight',
      'Nine',
      'Ten',
      'Eleven',
      'Twelve',
      'Thirteen',
      'Fourteen',
      'Fifteen',
      'Sixteen',
      'Seventeen',
      'Eighteen',
      'Nineteen',
    ];
    const tens = [
      '',
      '',
      'Twenty',
      'Thirty',
      'Forty',
      'Fifty',
      'Sixty',
      'Seventy',
      'Eighty',
      'Ninety',
    ];

    const twoDigits = (x: number): string => {
      if (x < 20) return ones[x];
      const t = Math.floor(x / 10);
      const o = x % 10;
      return tens[t] + (o ? ' ' + ones[o] : '');
    };
    const threeDigits = (x: number): string => {
      const h = Math.floor(x / 100);
      const r = x % 100;
      return [h ? ones[h] + ' Hundred' : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
    };

    let words = '';
    const crore = Math.floor(n / 10000000);
    n %= 10000000;
    const lakh = Math.floor(n / 100000);
    n %= 100000;
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    const remainder = n;

    if (crore) words += `${twoDigits(crore)} Crore `;
    if (lakh) words += `${twoDigits(lakh)} Lakh `;
    if (thousand) words += `${twoDigits(thousand)} Thousand `;
    if (remainder) words += threeDigits(remainder);

    return words.trim().replace(/\s+/g, ' ');
  }
}
