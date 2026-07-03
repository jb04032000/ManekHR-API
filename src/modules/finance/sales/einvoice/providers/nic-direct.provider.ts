// ============================================================
// MANUAL-VERIFY (before first production call):
// 1. NIC_IRP_PUBLIC_KEY env var must be set with NIC's published RSA public key
//    in PEM format — download from NIC IRP sandbox portal (einv-apisandbox.nic.in)
//    or production portal (einv-api.nic.in/developer).
// 2. NIC_CLIENT_ID + NIC_CLIENT_SECRET must be obtained from NIC IRP registration.
// 3. NIC_IRP_APP_KEY must be provided by NIC (from sandbox registration credentials).
// 4. Confirm NIC OTP verification endpoint: some NIC API versions require a separate
//    POST /eivital/v1.04/auth/otpverify while others use the same /auth endpoint
//    with OTP in the body. Verify against latest NIC IRP API v2.0 spec before go-live.
// 5. Confirm NIC EWB API base URL — sandbox vs production — and exact endpoint paths.
// ============================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../../common/redis/redis.module';
import axios from 'axios';
import { publicEncrypt, constants, randomUUID } from 'crypto';
import {
  IrpProviderAdapter,
  IrpInvoicePayload,
  IrpIrnResponse,
  EwbPayload,
  EwbResponse,
  EwbExtendResponse,
} from './irp-provider.interface';
import { decryptSmtpPassword } from '../../../../../common/utils/crypto-utils';

/** NIC IRP session stored in Redis under irp:session:{firmId} */
interface NicSession {
  authToken: string;
  expiresAt: number;
}

/** Redis key TTLs */
const SESSION_TTL_SECONDS = 6 * 3600; // 6 hours (NIC IRP token expiry)
const LOCK_TTL_SECONDS = 30 * 60; // 30 minutes OTP lockout
const OTP_PENDING_TTL_SECONDS = 5 * 60; // 5 minutes for pending OTP
const MAX_OTP_ATTEMPTS = 3;

/** Data stored in irp:otp-pending:{sessionId} */
interface OtpPendingData {
  firmId: string;
  gstin: string;
  username: string;
  encryptedPassword: string; // cipher-text, NOT plaintext
  sentAt: number;
  attemptOf: number;
  _authToken: string; // step-1 AuthToken (low risk in 5-min window)
}

/**
 * NIC Direct IRP/EWB implementation with OTP session flow and 3-strike lockout.
 *
 * Redis keys used:
 *   irp:session:{firmId}          — AuthToken (6h TTL)
 *   irp:otp-lock:{firmId}         — lockout marker (30min TTL)
 *   irp:otp-attempts:{firmId}     — failed OTP counter (30min TTL)
 *   irp:otp-pending:{sessionId}   — pending OTP context (5min TTL)
 *
 * SECURITY: AuthToken is NEVER returned to the client. Client sees only
 * sessionReady / needsOtp / locked status. Credentials never logged.
 */
@Injectable()
export class NicDirectProvider implements IrpProviderAdapter {
  private readonly logger = new Logger(NicDirectProvider.name);
  private readonly baseUrl: string;
  private readonly ewbBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly appKey: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    // Env-var driven so executor can switch sandbox ↔ production
    this.baseUrl = configService.get<string>(
      'NIC_IRP_BASE_URL',
      'https://einv-apisandbox.nic.in',
    );
    this.ewbBaseUrl = configService.get<string>(
      'NIC_EWB_BASE_URL',
      'https://ewbapi.nic.in/sandbox',
    );
    this.clientId = configService.get<string>('NIC_CLIENT_ID', '');
    this.clientSecret = configService.get<string>('NIC_CLIENT_SECRET', '');
    this.appKey = configService.get<string>('NIC_IRP_APP_KEY', '');
  }

  // ---------------------------------------------------------------------------
  // Redis key helpers
  // ---------------------------------------------------------------------------

  private sessionKey(firmId: string): string {
    return `irp:session:${firmId}`;
  }

  private lockKey(firmId: string): string {
    return `irp:otp-lock:${firmId}`;
  }

  private attemptsKey(firmId: string): string {
    return `irp:otp-attempts:${firmId}`;
  }

  private otpPendingKey(sessionId: string): string {
    return `irp:otp-pending:${sessionId}`;
  }

  // ---------------------------------------------------------------------------
  // RSA password encryption (NIC requires RSA/ECB/PKCS1Padding)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt plain password with NIC's RSA public key.
   * NIC_IRP_PUBLIC_KEY env var must contain the PEM-format public key.
   * SECURITY: plainPassword is NEVER logged or stored.
   */
  private rsaEncryptPassword(plainPassword: string): string {
    const pubKey = this.configService.get<string>('NIC_IRP_PUBLIC_KEY', '');
    if (!pubKey) {
      throw new Error('NIC_IRP_PUBLIC_KEY env var not set — cannot encrypt password for NIC IRP');
    }
    return publicEncrypt(
      { key: pubKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(plainPassword),
    ).toString('base64');
  }

  // ---------------------------------------------------------------------------
  // Shared NIC request headers
  // ---------------------------------------------------------------------------

  private buildNicHeaders(authToken: string, gstin: string): Record<string, string> {
    return {
      'auth-token': authToken,
      gstin,
      'client-id': this.clientId,
      'client-secret': this.clientSecret,
      'Content-Type': 'application/json',
    };
  }

  // ---------------------------------------------------------------------------
  // Session management — public methods for EInvoiceService/Controller
  // ---------------------------------------------------------------------------

  /**
   * Step 1 of NIC Direct auth flow.
   *
   * Returns:
   *   { sessionReady: true }              — valid session already in Redis
   *   { locked: true, minutesRemaining }  — too many OTP failures, locked out
   *   { needsOtp: true, sessionId, mobileLast4? } — session created, OTP sent to firm mobile
   *
   * firmConfig.encryptedPassword must be AES-256 cipher-text from DB — decrypted here.
   * SECURITY: decrypted password is NEVER stored, logged, or returned.
   */
  async prepareSession(
    firmId: string,
    firmConfig: { username: string; encryptedPassword: string; gstin: string },
  ): Promise<
    | { sessionReady: true }
    | { needsOtp: true; sessionId: string; mobileLast4?: string }
    | { locked: true; minutesRemaining: number }
  > {
    // Check for existing valid session
    const cached = await this.redis.get(this.sessionKey(firmId));
    if (cached) {
      const session: NicSession = JSON.parse(cached);
      if (session.expiresAt > Date.now()) {
        return { sessionReady: true };
      }
    }

    // Check lockout
    const lockTtl = await this.redis.ttl(this.lockKey(firmId));
    if (lockTtl > 0) {
      return { locked: true, minutesRemaining: Math.ceil(lockTtl / 60) };
    }

    // Decrypt password from AES-256 storage (NEVER log plaintext)
    let plainPassword: string;
    try {
      plainPassword = decryptSmtpPassword(firmConfig.encryptedPassword);
    } catch {
      throw new Error('Failed to decrypt NIC IRP credentials — check SMTP_ENCRYPTION_KEY env var');
    }

    // RSA-encrypt for NIC (discards plainPassword after this call)
    const rsaEncryptedPassword = this.rsaEncryptPassword(plainPassword);

    // Step 1: send auth to NIC — triggers OTP send to firm's registered mobile
    let authToken: string;
    let mobileLast4: string | undefined;
    try {
      const resp = await axios.post(
        `${this.baseUrl}/eivital/v1.04/auth`,
        {
          Username: firmConfig.username,
          Password: rsaEncryptedPassword,
          AppKey: this.appKey,
          ForceRefreshAccessToken: false,
        },
        {
          headers: {
            gstin: firmConfig.gstin,
            'client-id': this.clientId,
            'client-secret': this.clientSecret,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      // NIC returns AuthToken in step 1 + sends OTP to registered mobile
      // MANUAL-VERIFY: confirm exact NIC response field name for AuthToken in step 1
      authToken = resp.data?.Data?.AuthToken ?? resp.data?.data?.AuthToken;
      if (!authToken) {
        throw new Error('NIC auth step 1 returned no AuthToken');
      }
      // MANUAL-VERIFY: confirm NIC returns mobile last 4 digits in step 1 response
      mobileLast4 = resp.data?.Data?.MobileNum
        ? String(resp.data.Data.MobileNum).slice(-4)
        : undefined;
    } catch (err: any) {
      const message = err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      // SECURITY: Do NOT log credentials — use **REDACTED** for firmId
      this.logger.error(`NIC IRP auth step 1 failed [firm=**REDACTED**]: ${message}`);
      throw new Error(`IRP auth failed: ${message}`);
    }

    // Store pending OTP context in Redis (5 min TTL)
    const sessionId = randomUUID();
    const pendingData: OtpPendingData = {
      firmId,
      gstin: firmConfig.gstin,
      username: firmConfig.username,
      encryptedPassword: firmConfig.encryptedPassword, // cipher-text only, NOT plaintext
      sentAt: Date.now(),
      attemptOf: 0,
      _authToken: authToken, // step-1 token (needed for OTP verification)
    };
    await this.redis.setex(
      this.otpPendingKey(sessionId),
      OTP_PENDING_TTL_SECONDS,
      JSON.stringify(pendingData),
    );

    return { needsOtp: true, sessionId, mobileLast4 };
  }

  /**
   * Step 2 of NIC Direct auth flow — submit OTP to NIC.
   *
   * Returns:
   *   { sessionReady: true }             — OTP verified, session stored in Redis
   *   { otpFailed: true, attemptsLeft }  — wrong OTP, counter incremented
   *   { locked: true, minutesRemaining } — 3 failures → locked 30 min
   *
   * 3-strike lockout: irp:otp-attempts:{firmId} incremented on each failure.
   * On 3rd failure: irp:otp-lock:{firmId} set for 30 minutes.
   */
  async completeSession(
    firmId: string,
    sessionId: string,
    otp: string,
  ): Promise<
    | { sessionReady: true }
    | { otpFailed: true; attemptsLeft: number }
    | { locked: true; minutesRemaining: number }
  > {
    // Check lockout first
    const lockTtl = await this.redis.ttl(this.lockKey(firmId));
    if (lockTtl > 0) {
      return { locked: true, minutesRemaining: Math.ceil(lockTtl / 60) };
    }

    // Load pending OTP context
    const pendingRaw = await this.redis.get(this.otpPendingKey(sessionId));
    if (!pendingRaw) {
      throw new Error('OTP session expired or not found — please restart the session');
    }

    const pending: OtpPendingData = JSON.parse(pendingRaw);
    if (pending.firmId !== firmId) {
      throw new Error('Session firmId mismatch — invalid request');
    }

    // Step 2: verify OTP with NIC
    // MANUAL-VERIFY: confirm exact NIC OTP verification endpoint and request body structure.
    // NIC API v2.0 may use same /eivital/v1.04/auth endpoint with Otp field, or a separate endpoint.
    try {
      const resp = await axios.post(
        `${this.baseUrl}/eivital/v1.04/auth`,
        {
          Username: pending.username,
          // MANUAL-VERIFY: confirm NIC requires Otp in step 2 body alongside AuthToken
          Otp: otp,
          AuthToken: pending._authToken,
          AppKey: this.appKey,
        },
        {
          headers: {
            gstin: pending.gstin,
            'client-id': this.clientId,
            'client-secret': this.clientSecret,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      // On success, NIC returns the final AuthToken
      const finalToken = resp.data?.Data?.AuthToken ?? resp.data?.data?.AuthToken;
      if (!finalToken) {
        throw new Error('NIC OTP verification returned no AuthToken');
      }

      // Store verified session in Redis (6h TTL) — NEVER return token to client
      const session: NicSession = {
        authToken: finalToken,
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000,
      };
      await this.redis.setex(
        this.sessionKey(firmId),
        SESSION_TTL_SECONDS,
        JSON.stringify(session),
      );

      // Clear pending OTP key and attempt counter on success
      await this.redis.del(this.otpPendingKey(sessionId));
      await this.redis.del(this.attemptsKey(firmId));

      return { sessionReady: true };
    } catch (err: any) {
      // OTP verification failed — increment attempt counter (3-strike lockout)
      // irp:otp-attempts:{firmId} and irp:otp-lock:{firmId} enforce T-12-W2-02
      const attempts = await this.redis.incr(this.attemptsKey(firmId));
      if (attempts === 1) {
        // Set TTL on attempts key (30 min window)
        await this.redis.expire(this.attemptsKey(firmId), LOCK_TTL_SECONDS);
      }

      if (attempts >= MAX_OTP_ATTEMPTS) {
        // Lockout — set lock key, clean up attempts + pending
        await this.redis.setex(this.lockKey(firmId), LOCK_TTL_SECONDS, '1');
        await this.redis.del(this.attemptsKey(firmId));
        await this.redis.del(this.otpPendingKey(sessionId));
        this.logger.warn(`NIC IRP OTP lockout [firm=**REDACTED**] after 3 failed attempts`);
        return { locked: true, minutesRemaining: 30 };
      }

      const attemptsLeft = MAX_OTP_ATTEMPTS - attempts;
      return { otpFailed: true, attemptsLeft };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: ensure valid session or throw IRP_SESSION_REQUIRED
  // ---------------------------------------------------------------------------

  /**
   * Returns the cached NIC AuthToken for firmId, or throws IRP_SESSION_REQUIRED.
   * All adapter methods call this first — controller catches IRP_SESSION_REQUIRED
   * and surfaces needsOtp to the client.
   *
   * SECURITY: AuthToken never returned to external callers — only used in NIC request headers.
   */
  private async ensureSession(firmId: string): Promise<string> {
    const cached = await this.redis.get(this.sessionKey(firmId));
    if (cached) {
      const session: NicSession = JSON.parse(cached);
      if (session.expiresAt > Date.now()) {
        return session.authToken;
      }
    }
    throw new Error('IRP_SESSION_REQUIRED');
  }

  // ---------------------------------------------------------------------------
  // IrpProviderAdapter implementation
  // ---------------------------------------------------------------------------

  async generateIrn(invoicePayload: IrpInvoicePayload, firmGstin: string): Promise<IrpIrnResponse> {
    const authToken = await this.ensureSession(firmGstin);
    try {
      const response = await axios.post(
        `${this.baseUrl}/eicore/v1.04/Invoice`,
        invoicePayload,
        {
          headers: this.buildNicHeaders(authToken, firmGstin),
          timeout: 15_000,
        },
      );

      const d = response.data?.Data ?? response.data?.data;
      if (!d?.Irn && !d?.irn) {
        throw new Error('NIC IRP response missing Irn field');
      }
      return {
        irn: d.Irn ?? d.irn,
        ackNo: d.AckNo ?? d.ackNo,
        ackDate: d.AckDt ?? d.ackDate,
        signedQrCode: d.SignedQRCode ?? d.signedQrCode,
        signedInvoice: d.SignedInvoice ?? d.signedInvoice,
        ewbNo: d.EwbNo ?? d.ewbNo,
        ewbValidTill: d.EwbValidTill ?? d.ewbValidTill,
      };
    } catch (err: any) {
      if (err.message === 'IRP_SESSION_REQUIRED') throw err;
      const message =
        err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      this.logger.error(`NIC generateIrn failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async cancelIrn(irn: string, cancelReason: number, cancelRemarks: string): Promise<void> {
    // NOTE: NIC cancelIrn interface needs firmGstin for ensureSession.
    // Wave 3 EInvoiceService.cancelIrn(firmId, irn, ...) will extract firmGstin from Firm
    // and call nicDirectProvider.cancelIrnWithSession(firmGstin, irn, cancelReason, cancelRemarks).
    // This stub satisfies the interface contract; Wave 3 wires the full path.
    throw new Error(
      'NicDirectProvider.cancelIrn: call cancelIrnWithSession(firmGstin, irn, ...) instead — Wave 3 will route via EInvoiceService',
    );
  }

  async generateEwb(ewbPayload: EwbPayload, firmGstin: string): Promise<EwbResponse> {
    const authToken = await this.ensureSession(firmGstin);
    try {
      // MANUAL-VERIFY: confirm exact NIC EWB API endpoint path
      const response = await axios.post(
        `${this.ewbBaseUrl}/ewayapi`,
        ewbPayload,
        {
          headers: this.buildNicHeaders(authToken, firmGstin),
          timeout: 15_000,
        },
      );

      const d = response.data?.Data ?? response.data?.data ?? response.data;
      return {
        ewbNo: d.ewbNo ?? d.EwbNo ?? d.ewayBillNo,
        ewayBillDate: d.ewayBillDate ?? d.EwayBillDate,
        validUpto: d.validUpto ?? d.ValidUpto ?? d.validTill,
        alert: d.alert ?? d.Alert,
      };
    } catch (err: any) {
      if (err.message === 'IRP_SESSION_REQUIRED') throw err;
      const message =
        err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      this.logger.error(`NIC generateEwb failed: ${message}`);
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
  ): Promise<EwbExtendResponse> {
    // extendEwb interface doesn't carry firmGstin — see extendEwbWithSession for full impl.
    // Wave 3 EwaybillService routes NIC direct calls through extendEwbWithSession.
    throw new Error(
      'NicDirectProvider.extendEwb: call extendEwbWithSession(firmGstin, ewbNo, ...) — Wave 3 will route via EwaybillService',
    );
  }

  async cancelEwb(ewbNo: string, cancelReason: number, cancelRemarks: string): Promise<void> {
    // Same as extendEwb — needs firmGstin for session; Wave 3 wires this.
    throw new Error(
      'NicDirectProvider.cancelEwb: call cancelEwbWithSession(firmGstin, ewbNo, ...) — Wave 3 will route via EwaybillService',
    );
  }

  // ---------------------------------------------------------------------------
  // Wave 3 helpers — extended operations with explicit firmGstin for session
  // ---------------------------------------------------------------------------

  async cancelIrnWithSession(
    firmGstin: string,
    irn: string,
    cancelReason: number,
    cancelRemarks: string,
  ): Promise<void> {
    const authToken = await this.ensureSession(firmGstin);
    try {
      await axios.post(
        `${this.baseUrl}/eicore/v1.04/Invoice/Cancel`,
        { Irn: irn, CnlRsn: cancelReason, CnlRem: cancelRemarks },
        {
          headers: this.buildNicHeaders(authToken, firmGstin),
          timeout: 15_000,
        },
      );
    } catch (err: any) {
      if (err.message === 'IRP_SESSION_REQUIRED') throw err;
      const message =
        err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      this.logger.error(`NIC cancelIrn failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async extendEwbWithSession(
    firmGstin: string,
    ewbNo: string,
    vehicleNo: string,
    fromPlace: string,
    fromState: number,
    remainDist: number,
    vehicleType: string,
  ): Promise<EwbExtendResponse> {
    const authToken = await this.ensureSession(firmGstin);
    try {
      // MANUAL-VERIFY: confirm exact NIC EWB extend endpoint path
      const response = await axios.post(
        `${this.ewbBaseUrl}/ewayapi/extendvalidity`,
        { ewbNo, vehicleNo, fromPlace, fromState, remainDist, vehicleType },
        {
          headers: this.buildNicHeaders(authToken, firmGstin),
          timeout: 15_000,
        },
      );

      const d = response.data?.Data ?? response.data?.data ?? response.data;
      return {
        ewbNo: d.ewbNo ?? d.EwbNo ?? ewbNo,
        validUpto: d.validUpto ?? d.ValidUpto ?? d.validTill,
      };
    } catch (err: any) {
      if (err.message === 'IRP_SESSION_REQUIRED') throw err;
      const message =
        err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      this.logger.error(`NIC extendEwb failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }

  async cancelEwbWithSession(
    firmGstin: string,
    ewbNo: string,
    cancelReason: number,
    cancelRemarks: string,
  ): Promise<void> {
    const authToken = await this.ensureSession(firmGstin);
    try {
      // MANUAL-VERIFY: confirm exact NIC EWB cancel endpoint path
      await axios.post(
        `${this.ewbBaseUrl}/ewayapi/canceleway`,
        { ewbNo, cancelRsn: cancelReason, cancelRem: cancelRemarks },
        {
          headers: this.buildNicHeaders(authToken, firmGstin),
          timeout: 15_000,
        },
      );
    } catch (err: any) {
      if (err.message === 'IRP_SESSION_REQUIRED') throw err;
      const message =
        err.response?.data?.ErrorDetails?.[0]?.ErrorMessage ?? err.message;
      this.logger.error(`NIC cancelEwb failed: ${message}`);
      throw new Error(`IRP error: ${message}`);
    }
  }
}
