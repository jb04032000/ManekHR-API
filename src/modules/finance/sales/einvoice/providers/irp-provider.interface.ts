/**
 * IRP Provider Adapter interface — Wave 2 (GST Compliance Suite)
 *
 * Mirrors the GstinProviderAdapter pattern from
 * src/modules/finance/gstin/gstin-provider.interface.ts.
 *
 * Two implementations:
 *   SurepassIrpProvider  — default, zero-MFA (GSP handles auth)
 *   NicDirectProvider    — BYOK fallback, requires in-app OTP flow
 *
 * Wave 3 payload builders call adapter methods without knowing
 * which backend handles the request.
 */

/**
 * Full IRP invoice payload — NIC IRP schema version '1.1'.
 * SellerDtls / BuyerDtls / ItemList etc. typed as `any` here;
 * Wave 3 EinvoicePayloadBuilder will narrow these to precise shapes.
 */
export interface IrpInvoicePayload {
  Version: '1.1';
  TranDtls: { TaxSch: 'GST'; SupTyp: string; RegRev: 'N' | 'Y'; IgstOnIntra: 'N' | 'Y' };
  DocDtls: { Typ: 'INV' | 'CRN' | 'DBN'; No: string; Dt: string };
  SellerDtls: any; // structure populated by Wave 3 payload builder
  BuyerDtls: any;
  DispDtls?: any;
  ShipDtls?: any;
  ItemList: any[];
  ValDtls: any;
  PayDtls?: any;
  RefDtls?: any;
  AddlDocDtls?: any;
  ExpDtls?: any;
  EwbDtls?: any;
  /** Preceding document details - REQUIRED by IRP for credit/debit notes (CRN/DBN):
   *  the original invoice the note adjusts. Populated by the payload builder from the
   *  credit note's sourceInvoiceNumber + sourceInvoiceDate. */
  PrecDocDtls?: Array<{ InvNo: string; InvDt: string }>;
}

/**
 * Response from IRP on successful IRN generation.
 * Raw date strings from IRP — EInvoiceService converts to Date.
 */
export interface IrpIrnResponse {
  irn: string;
  ackNo: string;
  ackDate: string; // raw IRP-format date — service converts to Date
  signedQrCode: string;
  signedInvoice?: string;
  ewbNo?: string; // when EwbDtls supplied
  ewbValidTill?: string;
}

/**
 * e-Way Bill payload — GSTEWB v1.03 shape (built by Wave 3).
 * Index signature allows full EWB payload fields.
 */
export interface EwbPayload {
  [key: string]: any;
}

/** Response from IRP/EWB API on successful EWB generation. */
export interface EwbResponse {
  ewbNo: string;
  ewayBillDate: string;
  validUpto: string;
  alert?: string;
}

/** Response from IRP/EWB API on successful EWB validity extension. */
export interface EwbExtendResponse {
  ewbNo: string;
  validUpto: string;
}

/**
 * IRP Provider Adapter — 5 methods covering all IRN and EWB operations.
 *
 * Implementations: SurepassIrpProvider (default), NicDirectProvider (BYOK fallback).
 * EInvoiceService selects the correct implementation via resolveIrpProvider(firm).
 */
export interface IrpProviderAdapter {
  generateIrn(invoicePayload: IrpInvoicePayload, firmGstin: string): Promise<IrpIrnResponse>;
  cancelIrn(irn: string, cancelReason: number, cancelRemarks: string): Promise<void>;
  generateEwb(ewbPayload: EwbPayload, firmGstin: string): Promise<EwbResponse>;
  extendEwb(
    ewbNo: string,
    vehicleNo: string,
    fromPlace: string,
    fromState: number,
    remainDist: number,
    vehicleType: string,
  ): Promise<EwbExtendResponse>;
  cancelEwb(ewbNo: string, cancelReason: number, cancelRemarks: string): Promise<void>;
}
