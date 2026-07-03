import { Injectable } from '@nestjs/common';
import { format } from 'date-fns';
import { IrpInvoicePayload } from './providers/irp-provider.interface';

// ─── UQC (Unit Quantity Code) mapping per NIC IRP spec ────────────────────────
const UQC_MAP: Record<string, string> = {
  pcs: 'PCS',
  piece: 'PCS',
  pieces: 'PCS',
  pc: 'PCS',
  mtr: 'MTR',
  metre: 'MTR',
  meter: 'MTR',
  m: 'MTR',
  cm: 'CMS',
  kg: 'KGS',
  kgs: 'KGS',
  kilogram: 'KGS',
  gm: 'GMS',
  gram: 'GMS',
  nos: 'NOS',
  no: 'NOS',
  number: 'NOS',
  ltr: 'LTR',
  litre: 'LTR',
  liter: 'LTR',
  l: 'LTR',
  ml: 'MLT',
  box: 'BOX',
  set: 'SET',
  pair: 'PRS',
  prs: 'PRS',
  sqmt: 'SQM',
  sqft: 'SQF',
  sqyd: 'SQY',
  mtr2: 'SQM',
  unit: 'UNT',
  roll: 'ROL',
  pack: 'PAC',
  bag: 'BAG',
  bale: 'BAL',
  drum: 'DRM',
  can: 'CAN',
  bottle: 'BTL',
  tube: 'TUB',
  dozen: 'DOZ',
  gross: 'GRS',
  hour: 'HRS',
  hrs: 'HRS',
  day: 'DAY',
  month: 'MON',
  year: 'YRS',
  job: 'JOB',
  lump: 'LSM',
  ls: 'LSM',
};

function toUQC(unit: string): string {
  return UQC_MAP[unit.toLowerCase()] ?? 'NOS';
}

/** Format monetary paise to rupees with 2 decimal places (IRP hard requirement — RESEARCH Pitfall 5) */
const fmt2 = (paise: number): number => Number((paise / 100).toFixed(2));

/** Format quantity/unit price with 3 decimal places */
const fmt3 = (qty: number): number => Number(qty.toFixed(3));

/** GSTIN regex — 15-digit format per NIC spec */
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Invoice number valid character set per IRP spec (≤16 chars) */
const VOUCHER_NO_REGEX = /^[A-Za-z0-9/\-.]+$/;

/**
 * EinvoicePayloadBuilder
 *
 * Builds the full NIC IRP v2.0 (schema Version '1.1') invoice payload
 * from a SaleInvoice + Firm + Party (from partySnapshot).
 *
 * Validates all mandatory IRP fields before returning the payload.
 * Throws descriptive errors on validation failures so IRP rejection is caught
 * before the API call, not after (T-12-W3-01 — prevents silent monetary drift).
 */
@Injectable()
export class EinvoicePayloadBuilder {
  /**
   * Builds the full IRP v2.0 payload.
   *
   * @param invoice  SaleInvoice document (with lineItems, partySnapshot, totals)
   * @param firm     Firm document (GSTIN, address, stateCode, aato)
   * @param party    Party snapshot object (from invoice.partySnapshot)
   * @returns        IrpInvoicePayload ready to send to IRP
   * @throws         Error with error code prefix (IRP_*) on validation failure
   */
  build(invoice: any, firm: any, party: any): IrpInvoicePayload {
    // ─── Step 1: Pre-flight validation ──────────────────────────────────────

    // 2f multi-GSTIN: the seller GSTIN is the supplying branch's registration
    // (invoice.sellerGstin), falling back to the firm's primary gstin.
    const sellerGstin: string = invoice.sellerGstin || firm.gstin;

    // Validate seller GSTIN
    if (!sellerGstin || !GSTIN_REGEX.test(sellerGstin)) {
      throw new Error(
        `IRP_INVALID_GSTIN: Seller GSTIN '${sellerGstin}' is invalid. Expected 15-digit format.`,
      );
    }

    // Validate buyer GSTIN when it's a B2B/registered party
    if (party?.gstin && !GSTIN_REGEX.test(party.gstin)) {
      throw new Error(
        `IRP_INVALID_GSTIN: Party GSTIN '${party.gstin}' is invalid. Expected 15-digit format.`,
      );
    }

    // Validate invoice number
    const voucherNo: string = invoice.voucherNumber ?? '';
    if (!voucherNo || voucherNo.length > 16) {
      throw new Error(
        `IRP_INVOICE_NUMBER_LENGTH: Invoice number '${voucherNo}' exceeds 16 characters (length: ${voucherNo.length}). IRP maximum is 16 chars.`,
      );
    }
    if (!VOUCHER_NO_REGEX.test(voucherNo)) {
      throw new Error(
        `IRP_INVOICE_NUMBER_CHARS: Invoice number '${voucherNo}' contains invalid characters. Allowed: A-Z, a-z, 0-9, /, -, .`,
      );
    }

    // Validate HSN codes — minimum 4 digits; 6 digits when AATO > 5 Cr (RESEARCH Pitfall 9)
    const minHsnLength = (firm.aato ?? 0) > 5 ? 6 : 4;
    const lineItems: any[] = invoice.lineItems ?? [];
    for (const item of lineItems) {
      const hsn: string = (item.hsnSacCode ?? '').trim();
      if (hsn.length < minHsnLength) {
        throw new Error(
          `IRP_HSN_TOO_SHORT: Item '${item.itemName}' has HSN '${hsn}' with ${hsn.length} digits. ` +
            `IRP requires minimum ${minHsnLength} digits (AATO > 5 Cr requires 6-digit HSN per RESEARCH Pitfall 9).`,
        );
      }
    }

    // Validate non-zero invoice total
    if ((invoice.grandTotalPaise ?? 0) === 0) {
      throw new Error(
        `IRP_TOTAL_ZERO: Invoice '${voucherNo}' has zero grand total. IRP does not accept zero-value invoices.`,
      );
    }

    // ─── Step 2: Determine supply type ──────────────────────────────────────

    const firmStateCode = parseInt(sellerGstin.substring(0, 2), 10);
    const partyStateCode = party?.gstin
      ? parseInt(party.gstin.substring(0, 2), 10)
      : parseInt(invoice.placeOfSupplyStateCode ?? '0', 10);
    const isInterState = firmStateCode !== partyStateCode;

    let supTyp: string;
    let igstOnIntra: 'N' | 'Y' = 'N';

    if (invoice.exportType === 'EXPWP') {
      supTyp = 'EXPWP';
    } else if (invoice.exportType === 'EXPWOP') {
      supTyp = 'EXPWOP';
    } else if (invoice.exportType === 'DEXP') {
      supTyp = 'DEXP';
    } else if (invoice.sezType === 'SEZWP') {
      supTyp = 'SEZWP';
    } else if (invoice.sezType === 'SEZWOP') {
      supTyp = 'SEZWOP';
    } else if (party?.gstin) {
      // Registered party — B2B
      supTyp = 'B2B';
      if (!isInterState && (invoice.igstPaise ?? 0) > 0) {
        igstOnIntra = 'Y'; // IGST charged on intra-state (special cases)
      }
    } else {
      // Unregistered party
      const grandTotal = invoice.grandTotalPaise ?? 0;
      if (isInterState && grandTotal > 25_000_000) {
        // > ₹2.5L interstate B2C → B2CL
        supTyp = 'B2CL';
      } else {
        supTyp = 'B2CS';
      }
    }

    // ─── Step 3: Format date (IST DD/MM/YYYY) ───────────────────────────────

    const docDate = format(new Date(invoice.voucherDate), 'dd/MM/yyyy');

    // ─── Step 4: Determine document type ────────────────────────────────────

    let docTyp: 'INV' | 'CRN' | 'DBN' = 'INV';
    if (invoice.voucherType === 'credit_note') docTyp = 'CRN';
    else if (invoice.voucherType === 'debit_note') docTyp = 'DBN';

    // ─── Step 5: Build ItemList ──────────────────────────────────────────────

    const itemList = lineItems.map((item: any, idx: number) => {
      const isServc: 'Y' | 'N' = item.type === 'service' || item.isService ? 'Y' : 'N';
      const qty = fmt3(item.qty ?? 0);
      const unitPrice = fmt2(item.ratePaise ?? 0);
      const totAmt = fmt2((item.ratePaise ?? 0) * (item.qty ?? 0));
      const discount = fmt2(item.discountFlatPaise ?? 0);
      const preTaxVal = fmt2(item.taxableValuePaise ?? 0);
      const assAmt = preTaxVal;
      const gstRt = item.taxRate ?? 0;
      const igstAmt = fmt2(item.igstPaise ?? 0);
      const cgstAmt = fmt2(item.cgstPaise ?? 0);
      const sgstAmt = fmt2(item.sgstPaise ?? 0);
      const cesRt = item.cessRate ?? 0;
      const cesAmt = fmt2(item.cessPaise ?? 0);
      const totItemVal = fmt2(item.lineTotalPaise ?? 0);

      const lineObj: any = {
        SlNo: String(idx + 1),
        PrdDesc: item.itemName ?? 'Item',
        IsServc: isServc,
        HsnCd: (item.hsnSacCode ?? '').trim(),
        Qty: qty,
        Unit: toUQC(item.unit ?? ''),
        UnitPrice: unitPrice,
        TotAmt: totAmt,
        Discount: discount,
        PreTaxVal: preTaxVal,
        AssAmt: assAmt,
        GstRt: gstRt,
        IgstAmt: igstAmt,
        CgstAmt: cgstAmt,
        SgstAmt: sgstAmt,
        TotItemVal: totItemVal,
      };

      if (cesRt > 0) {
        lineObj.CesRt = cesRt;
        lineObj.CesAmt = cesAmt;
      }

      return lineObj;
    });

    // ─── Step 6: Build ValDtls ───────────────────────────────────────────────

    const valDtls: any = {
      AssVal: fmt2(invoice.taxableValuePaise ?? 0),
      CgstVal: fmt2(invoice.cgstPaise ?? 0),
      SgstVal: fmt2(invoice.sgstPaise ?? 0),
      IgstVal: fmt2(invoice.igstPaise ?? 0),
      CesVal: fmt2(invoice.cessPaise ?? 0),
      Discount: fmt2(invoice.totalDiscountPaise ?? 0),
      OthChrg: fmt2(
        (invoice.additionalCharges ?? []).reduce(
          (sum: number, c: any) => sum + (c.amountPaise ?? 0),
          0,
        ),
      ),
      RndOffAmt: fmt2(invoice.roundOffPaise ?? 0),
      TotInvVal: fmt2(invoice.grandTotalPaise ?? 0),
    };

    // ─── Step 7: Build SellerDtls ────────────────────────────────────────────

    const sellerDtls: any = {
      Gstin: sellerGstin,
      LglNm: firm.firmName ?? firm.legalName ?? firm.firmName,
      TrdNm: firm.tradeName ?? firm.firmName,
      Addr1: firm.address?.line1 ?? firm.addr1 ?? '',
      Addr2: firm.address?.line2 ?? firm.addr2 ?? undefined,
      Loc: firm.address?.city ?? firm.city ?? '',
      Pin: parseInt(String(firm.address?.pincode ?? firm.pincode ?? '000000'), 10),
      Stcd: String(firmStateCode),
    };

    // ─── Step 8: Build BuyerDtls ────────────────────────────────────────────

    const buyerStateCode = partyStateCode || firmStateCode;
    const buyerDtls: any = {
      Gstin: party?.gstin ?? 'URP',
      LglNm: party?.partyName ?? party?.name ?? 'Unknown',
      TrdNm: party?.tradeName ?? party?.partyName ?? party?.name ?? 'Unknown',
      Addr1: party?.address?.line1 ?? party?.addr1 ?? '',
      Addr2: party?.address?.line2 ?? party?.addr2 ?? undefined,
      Loc: party?.address?.city ?? party?.city ?? '',
      Pin: parseInt(String(party?.address?.pincode ?? party?.pincode ?? '000000'), 10),
      Stcd: String(buyerStateCode),
      Pos: invoice.placeOfSupplyStateCode ?? String(buyerStateCode),
      Ph: party?.phone ?? undefined,
      Em: party?.email ?? undefined,
    };

    // ─── Step 9: Assemble final payload ─────────────────────────────────────

    const payload: IrpInvoicePayload = {
      Version: '1.1',
      TranDtls: {
        TaxSch: 'GST',
        SupTyp: supTyp,
        RegRev: invoice.isReverseCharge ? 'Y' : 'N',
        IgstOnIntra: igstOnIntra,
      },
      DocDtls: {
        Typ: docTyp,
        No: voucherNo,
        Dt: docDate,
      },
      SellerDtls: sellerDtls,
      BuyerDtls: buyerDtls,
      ItemList: itemList,
      ValDtls: valDtls,
    };

    // Preceding-document details: IRP REQUIRES these for credit/debit notes (CRN/DBN) - the
    // original invoice the note adjusts. Sourced from the credit note's sourceInvoiceNumber +
    // sourceInvoiceDate (credit-note.schema). Without this the IRP rejects the CRN payload.
    if ((docTyp === 'CRN' || docTyp === 'DBN') && invoice.sourceInvoiceNumber) {
      payload.PrecDocDtls = [
        {
          InvNo: invoice.sourceInvoiceNumber,
          InvDt: format(new Date(invoice.sourceInvoiceDate ?? invoice.voucherDate), 'dd/MM/yyyy'),
        },
      ];
    }

    // Optional: EwbDtls when caller passes EWB info (combined IRN+EWB call)
    if (invoice._ewbDtls) {
      payload.EwbDtls = invoice._ewbDtls;
    }

    return payload;
  }
}
