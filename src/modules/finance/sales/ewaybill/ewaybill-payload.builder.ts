import { Injectable } from '@nestjs/common';
import { format } from 'date-fns';

/**
 * TransportInput — caller-supplied transport details for EWB generation.
 */
export interface TransportInput {
  transMode: '1' | '2' | '3' | '4';
  transDistance: number;
  vehicleNo?: string;
  vehicleType?: 'R' | 'M';
  transporterId?: string;
  transporterName?: string;
  transDocNo?: string;
  transDocDate?: string;
  overrideExemption?: boolean;
}

/**
 * EwbItemLine — line item shape for GSTEWB v1.03 itemList
 */
export interface EwbItemLine {
  productName: string;
  productDesc?: string;
  hsnCd: string;
  productType?: 'goods' | 'services';
  quantity: number;
  qtyUnit: string;
  taxableAmount: number;
  sgstRate: number;
  cgstRate: number;
  igstRate: number;
  cessRate: number;
  cessNonAdvolValue?: number;
}

/**
 * EwaybillPayloadBuilder
 *
 * Builds the full GSTEWB v1.03 payload from a SaleInvoice + Firm + Party.
 *
 * Key responsibilities:
 *  - Gujarat textile HSN exemption detection (RESEARCH Code Example 4)
 *  - D-04 full payload field mapping (GSTEWB v1.03 spec)
 *  - supplyType/subSupplyType/docType derivation
 *
 * Gujarat textile HSN exempt range (intrastate only):
 *   Chapters 50-63 = HSN 5001-6309 (silk, wool, cotton, man-made fibres, textile products)
 *   Job-work = HSN 9988
 */
@Injectable()
export class EwaybillPayloadBuilder {
  /**
   * Detects whether this EWB is exempt from generation under Gujarat
   * intrastate textile notification.
   *
   * Returns true ONLY when:
   *   1. fromStateCode === 24 (Gujarat)
   *   2. toStateCode === 24 (Gujarat — intrastate)
   *   3. ALL line items have HSN in Chapters 50-63 (5001-6309) OR HSN 9988 (job-work)
   *
   * (RESEARCH Code Example 4 — exact logic)
   *
   * @param fromStateCode  Seller state code (GST numeric)
   * @param toStateCode    Buyer state code (GST numeric)
   * @param lineItems      EWB item lines with hsnCd field
   */
  isGujaratTextileExempt(
    fromStateCode: number,
    toStateCode: number,
    lineItems: EwbItemLine[],
  ): boolean {
    // Must be intrastate Gujarat (state code 24 on both ends)
    if (fromStateCode !== 24 || toStateCode !== 24) return false;

    // ALL items must be in textile HSN range or job-work service
    return lineItems.every((item) => {
      const hsn = parseInt(item.hsnCd, 10);
      return (hsn >= 5001 && hsn <= 6309) || hsn === 9988;
    });
  }

  /**
   * Builds the full GSTEWB v1.03 payload.
   *
   * @param invoice    SaleInvoice document
   * @param firm       Firm document (GSTIN, address, stateCode)
   * @param party      Party snapshot (from invoice.partySnapshot)
   * @param transport  Transport details from caller
   * @returns          GSTEWB v1.03 payload object
   */
  build(invoice: any, firm: any, party: any, transport: TransportInput): any {
    const firmStateCode = parseInt((firm.gstin ?? '00').substring(0, 2), 10);
    const partyStateCode = party?.gstin
      ? parseInt(party.gstin.substring(0, 2), 10)
      : parseInt(invoice.placeOfSupplyStateCode ?? '0', 10) || firmStateCode;

    // Format invoice date as DD/MM/YYYY
    const docDate = format(new Date(invoice.voucherDate), 'dd/MM/yyyy');

    // Determine docType
    let docType: 'INV' | 'CHL' | 'BL' | 'BOE' | 'CNT' | 'OTH' = 'INV';
    if (invoice.voucherType === 'delivery_challan') docType = 'CHL';

    // Determine subSupplyType
    // 1=Supply, 4=Job Work, 7=Sales Return (for credit notes)
    // Delivery challans carry the job-work flag as challanType='job_work' (no isJobWork field).
    let subSupplyType: number = 1;
    if (invoice.isJobWork || invoice.challanType === 'job_work') subSupplyType = 4;
    else if (invoice.voucherType === 'credit_note') subSupplyType = 7;

    // Map invoice line items to EWB item lines
    const itemList = (invoice.lineItems ?? []).map((item: any) => ({
      productName: item.itemName ?? 'Item',
      productDesc: item.itemName ?? 'Item',
      hsnCd: (item.hsnSacCode ?? '').trim(),
      productType: item.type === 'service' || item.isService ? 'services' : 'goods',
      quantity: item.qty ?? 0,
      qtyUnit: item.unit ?? 'NOS',
      taxableAmount: Number((item.taxableValuePaise ?? 0) / 100).toFixed(2),
      sgstRate: item.taxRate ? item.taxRate / 2 : 0,
      cgstRate: item.taxRate ? item.taxRate / 2 : 0,
      igstRate: firmStateCode !== partyStateCode ? (item.taxRate ?? 0) : 0,
      cessRate: item.cessRate ?? 0,
      cessNonAdvolValue: 0,
    }));

    const payload: any = {
      supplyType: 'O', // Outward — sale invoices are outward supply
      subSupplyType,
      docType,
      docNo: invoice.voucherNumber ?? '',
      docDate,

      // Seller (From) details
      fromGstin: firm.gstin ?? '',
      fromTrdName: firm.tradeName ?? firm.firmName ?? '',
      fromAddr1: firm.address?.line1 ?? firm.addr1 ?? '',
      fromAddr2: firm.address?.line2 ?? firm.addr2 ?? undefined,
      fromPlace: firm.address?.city ?? firm.city ?? '',
      fromPincode: parseInt(String(firm.address?.pincode ?? firm.pincode ?? '000000'), 10),
      fromStateCode: firmStateCode,
      actFromStateCode: firmStateCode, // dispatch-from = seller state unless explicit override

      // Buyer (To) details
      toGstin: party?.gstin ?? 'URP',
      toTrdName: party?.partyName ?? party?.tradeName ?? party?.name ?? 'Unknown',
      toAddr1: party?.address?.line1 ?? party?.addr1 ?? '',
      toAddr2: party?.address?.line2 ?? party?.addr2 ?? undefined,
      toPlace: party?.address?.city ?? party?.city ?? '',
      toPincode: parseInt(String(party?.address?.pincode ?? party?.pincode ?? '000000'), 10),
      toStateCode: partyStateCode,
      actToStateCode: partyStateCode,

      transactionType: firmStateCode !== partyStateCode ? 1 : 2, // 1=Inter-State, 2=Intra-State

      // Tax totals (paise → rupees)
      totalValue: Number(((invoice.taxableValuePaise ?? 0) / 100).toFixed(2)),
      cgstValue: Number(((invoice.cgstPaise ?? 0) / 100).toFixed(2)),
      sgstValue: Number(((invoice.sgstPaise ?? 0) / 100).toFixed(2)),
      igstValue: Number(((invoice.igstPaise ?? 0) / 100).toFixed(2)),
      cessValue: Number(((invoice.cessPaise ?? 0) / 100).toFixed(2)),
      cessNonAdvolValue: 0,
      totInvValue: Number(((invoice.grandTotalPaise ?? 0) / 100).toFixed(2)),

      // Transport details
      transMode: transport.transMode,
      transDistance: transport.transDistance,
      vehicleNo: transport.vehicleNo ?? undefined,
      vehicleType: transport.vehicleType ?? 'R',
      transporterId: transport.transporterId ?? undefined,
      transporterName: transport.transporterName ?? undefined,
      transDocNo: transport.transDocNo ?? undefined,
      transDocDate: transport.transDocDate ?? undefined,

      itemList,
    };

    return payload;
  }
}
