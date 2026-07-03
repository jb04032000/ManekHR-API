// ============================================================
// MANUAL-VERIFY (before first production call):
// 1. Confirm SurePass e-Invoice API endpoint paths from
//    https://developer.surepass.io/docs/einvoice (or contact SurePass support)
// 2. Confirm response schema field names (irn vs IRN, ackNo vs AckNo, etc.)
// 3. Update axios call paths below if endpoints differ from placeholders
// 4. Confirm whether SurePass e-Invoice API uses the same base URL as GSTIN
//    (https://kyc-api.surepass.io/api/v1/einvoice/) or a different subdomain
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  IrpProviderAdapter,
  IrpInvoicePayload,
  IrpIrnResponse,
  EwbPayload,
  EwbResponse,
  EwbExtendResponse,
} from './irp-provider.interface';

/**
 * SurePass GSP IRP/EWB implementation.
 *
 * Default IRP provider. SurePass acts as GSP — no in-app OTP flow needed.
 * Auth: Bearer token (platform-level SUREPASS_EINVOICE_KEY or firm BYOK key).
 *
 * Stateless by design: firmGspKey is passed per-call rather than stored as
 * a mutable instance field. This prevents credential leakage across concurrent
 * requests from different BYOK firms (CR-01 security fix).
 *
 * Usage:
 *   await provider.generateIrn(payload, firmGstin, decryptedFirmKey);
 *   // pass null/undefined for firmGspKey to fall back to platform SUREPASS_EINVOICE_KEY
 */
@Injectable()
export class SurepassIrpProvider implements IrpProviderAdapter {
  private readonly logger = new Logger(SurepassIrpProvider.name);
  private readonly baseUrl = 'https://kyc-api.surepass.io/api/v1/einvoice/';
  private readonly platformKey: string;

  constructor(private readonly configService: ConfigService) {
    this.platformKey = this.configService.get<string>('SUREPASS_EINVOICE_KEY', '');
  }

  /**
   * Resolve auth header — firm BYOK key takes precedence over platform key.
   * firmGspKey is passed per-call (not stored on instance) to prevent credential
   * leakage across concurrent requests from different BYOK firms.
   * SECURITY: never log the key value.
   */
  private getAuthHeader(firmGspKey?: string | null): string {
    const key = firmGspKey ?? this.platformKey;
    if (!key) {
      throw new Error('SurePass e-Invoice API key not configured. Set SUREPASS_EINVOICE_KEY env var or firm BYOK key.');
    }
    return `Bearer ${key}`;
  }

  async generateIrn(invoicePayload: IrpInvoicePayload, firmGstin: string, firmGspKey?: string | null): Promise<IrpIrnResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}generate`,
        invoicePayload,
        {
          headers: {
            Authorization: this.getAuthHeader(firmGspKey),
            'Content-Type': 'application/json',
            // MANUAL-VERIFY: SurePass may require GSTIN header similar to NIC direct
            ...(firmGstin ? { 'x-gstin': firmGstin } : {}),
          },
          timeout: 15_000,
        },
      );

      const d = response.data?.data ?? response.data;
      // MANUAL-VERIFY: confirm exact response field names (irn / Irn / IRN etc.)
      return {
        irn: d.irn ?? d.Irn ?? d.IRN,
        ackNo: d.ackNo ?? d.AckNo,
        ackDate: d.ackDate ?? d.AckDt,
        signedQrCode: d.signedQrCode ?? d.SignedQRCode,
        signedInvoice: d.signedInvoice ?? d.SignedInvoice,
        ewbNo: d.ewbNo ?? d.EwbNo,
        ewbValidTill: d.ewbValidTill ?? d.EwbValidTill,
      };
    } catch (err: any) {
      const message = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
      this.logger.error(`SurePass generateIrn failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async cancelIrn(irn: string, cancelReason: number, cancelRemarks: string, firmGspKey?: string | null): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}cancel`,
        { Irn: irn, CnlRsn: cancelReason, CnlRem: cancelRemarks },
        {
          headers: {
            Authorization: this.getAuthHeader(firmGspKey),
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
    } catch (err: any) {
      const message = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
      this.logger.error(`SurePass cancelIrn failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async generateEwb(ewbPayload: EwbPayload, firmGstin: string, firmGspKey?: string | null): Promise<EwbResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}ewb/generate`,
        ewbPayload,
        {
          headers: {
            Authorization: this.getAuthHeader(firmGspKey),
            'Content-Type': 'application/json',
            ...(firmGstin ? { 'x-gstin': firmGstin } : {}),
          },
          timeout: 15_000,
        },
      );

      const d = response.data?.data ?? response.data;
      // MANUAL-VERIFY: confirm exact response field names from SurePass EWB API docs
      return {
        ewbNo: d.ewbNo ?? d.EwbNo ?? d.ewayBillNo,
        ewayBillDate: d.ewayBillDate ?? d.EwayBillDate,
        validUpto: d.validUpto ?? d.ValidUpto ?? d.validTill,
        alert: d.alert ?? d.Alert,
      };
    } catch (err: any) {
      const message = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
      this.logger.error(`SurePass generateEwb failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async extendEwb(
    ewbNo: string,
    vehicleNo: string,
    fromPlace: string,
    fromState: number,
    remainDist: number,
    vehicleType: string,
    firmGspKey?: string | null,
  ): Promise<EwbExtendResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}ewb/extend`,
        { ewbNo, vehicleNo, fromPlace, fromState, remainDist, vehicleType },
        {
          headers: {
            Authorization: this.getAuthHeader(firmGspKey),
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      const d = response.data?.data ?? response.data;
      // MANUAL-VERIFY: confirm exact response field names
      return {
        ewbNo: d.ewbNo ?? d.EwbNo ?? ewbNo,
        validUpto: d.validUpto ?? d.ValidUpto ?? d.validTill,
      };
    } catch (err: any) {
      const message = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
      this.logger.error(`SurePass extendEwb failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async cancelEwb(ewbNo: string, cancelReason: number, cancelRemarks: string, firmGspKey?: string | null): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}ewb/cancel`,
        { ewbNo, cancelRsn: cancelReason, cancelRem: cancelRemarks },
        {
          headers: {
            Authorization: this.getAuthHeader(firmGspKey),
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
    } catch (err: any) {
      const message = err.response?.data?.message ?? err.response?.data?.error ?? err.message;
      this.logger.error(`SurePass cancelEwb failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }
}
