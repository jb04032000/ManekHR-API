/**
 * Single source of truth for environment variables.
 *
 * Every other file in the BE codebase MUST import from here — never read
 * `process.env.X` directly. The lint rule `no-restricted-syntax` (in
 * eslint.config.mjs) is activated after the Phase 0.6 migration completes
 * and will block direct `process.env` access outside this file + main.ts.
 *
 * Defaults below preserve the exact behavior that existed before centralization.
 * If a var had no fallback, the field is typed `string | undefined`.
 *
 * IMPORTANT: `import 'dotenv/config'` runs FIRST so the `process.env.X`
 * reads below resolve correctly during module-load. NestJS ConfigModule
 * also calls dotenv internally (no-op if already loaded), so both paths
 * stay consistent. In production, host-supplied env vars are present
 * before the process starts and dotenv silently no-ops if .env is absent.
 */

import 'dotenv/config';
import { Logger } from '@nestjs/common';
// Pure helper (no IO / no env reads of its own) — safe to import after
// dotenv/config; used below to turn LOG_LEVELS + NODE_ENV into a Nest LogLevel[].
import { resolveLogLevels } from '../common/logging/log-levels';

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const float = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
};

const csv = (v: string | undefined, fallback: string[] = []): string[] => {
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Resolve the auth refresh-token cookie config (OQ-1) with one safety override
 * (AUTH-H3): a `SameSite=None` cookie MUST also be `Secure`, or every modern
 * browser silently drops it (refresh breaks with no error). So when
 * AUTH_COOKIE_SAMESITE=none, we force `secure: true` regardless of
 * AUTH_COOKIE_SECURE and warn the operator that we overrode their setting. The
 * safe defaults (`lax` + secure-in-prod) are unchanged.
 *
 * Exported for unit testing; the loader calls it once below.
 */
export const resolveAuthCookie = (
  rawSecure: string | undefined,
  rawSameSite: string | undefined,
  nodeEnv: string | undefined,
): { secure: boolean; sameSite: 'lax' | 'strict' | 'none'; domain: string | undefined } => {
  const sameSite = (['lax', 'strict', 'none'].includes(rawSameSite || '') ? rawSameSite : 'lax') as
    | 'lax'
    | 'strict'
    | 'none';
  let secure = bool(rawSecure, nodeEnv === 'production');
  if (sameSite === 'none' && !secure) {
    // Browsers reject SameSite=None without Secure — force Secure so the cookie
    // actually persists. Logger (not console.*) per repo convention.
    new Logger('env').warn(
      'AUTH_COOKIE_SAMESITE=none requires Secure cookies; forcing AUTH_COOKIE_SECURE=true ' +
        '(SameSite=None without Secure is dropped by browsers).',
    );
    secure = true;
  }
  return {
    secure,
    sameSite,
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  };
};

export const env = {
  // ---------- Core ----------
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Process role selector for the web / worker split (scheduler-contract ADR).
  // `web`    — serves HTTP only; all scheduled jobs are stopped at boot.
  // `worker` — runs scheduled jobs + queue consumers.
  // `all`    — both (the local-dev default so one process runs everything).
  // Single-fire across N workers is guaranteed by the Redis single-flight lock,
  // not by this role alone.
  processRole: (['web', 'worker', 'all'].includes(process.env.PROCESS_ROLE || '')
    ? process.env.PROCESS_ROLE
    : 'all') as 'web' | 'worker' | 'all',
  webAppUrl: process.env.WEB_APP_URL || 'http://localhost:3001',
  publicWebUrl: (process.env.PUBLIC_WEB_URL || '').replace(/\/$/, ''),
  nextPublicAppUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001',
  inviteTokenExpiryDays: num(process.env.INVITE_TOKEN_EXPIRY_DAYS, 7),
  adminSetupSecret: process.env.ADMIN_SETUP_SECRET,
  paginationThreshold: num(process.env.PAGINATION_THRESHOLD, 200),
  systemUserId: process.env.SYSTEM_USER_ID || '000000000000000000000000',

  // ---------- Firebase ----------
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
  },

  // ---------- MSG91 (SMS) ----------
  msg91: {
    authKey: process.env.MSG91_AUTH_KEY,
    senderId: process.env.MSG91_SENDER_ID,
    paymentReminderTemplateId: process.env.MSG91_PAYMENT_REMINDER_TEMPLATE_ID,
    costGsm7SegPaise: num(process.env.MSG91_COST_GSM7_SEG_PAISE, 1500),
    costUcs2SegPaise: num(process.env.MSG91_COST_UCS2_SEG_PAISE, 1500),
    preflightSafetyMultiplier: float(process.env.MSG91_PREFLIGHT_SAFETY_MULTIPLIER, 1.5),
    // Auth SMS-OTP — separate template + workspace from payment reminders so
    // pricing/audit reports cleanly split transactional from auth traffic.
    authOtpTemplateId: process.env.MSG91_AUTH_OTP_TEMPLATE_ID,
    authOtpWorkspaceId: process.env.AUTH_OTP_WORKSPACE_ID,
    // OTP Widget (2026-07) — separate MSG91 product from the DLT SMS API
    // above. widgetId + authKey (reused from this same block) are enough
    // for server-side verifyAccessToken; the client-side tokenAuth lives on
    // the web side as a NEXT_PUBLIC_ var (it's meant to be public).
    widgetId: process.env.MSG91_WIDGET_ID,
  },

  // ---------- Auth SMS-OTP (login/register/forgot/verify) ----------
  // mockEnabled bypasses MSG91 dispatch and accepts the fixed code "123456".
  // Triple-locked against accidental production enablement in main.ts.
  authOtp: {
    mockEnabled: bool(process.env.AUTH_OTP_MOCK, false),
    mockAllowInProd: bool(process.env.ALLOW_AUTH_OTP_MOCK_IN_PROD, false),
    // Which product actually sends/verifies the SMS. 'widget' (default) uses
    // MSG91's OTP Widget (no DLT sender-ID needed — unblocks OTP today).
    // 'dlt' is the original raw-SMS path via sendDltSms, kept as a fallback
    // for when the DLT sender ID clears. See docs/superpowers/specs/
    // 2026-07-03-msg91-widget-otp-design.md.
    channel: (process.env.AUTH_OTP_CHANNEL === 'dlt' ? 'dlt' : 'widget') as 'dlt' | 'widget',
    expiryMs: num(process.env.AUTH_OTP_EXPIRY_MS, 600_000), // 10 min
    resendCooldownSec: num(process.env.AUTH_OTP_RESEND_COOLDOWN_SEC, 30),
    maxVerifyAttempts: num(process.env.AUTH_OTP_MAX_VERIFY_ATTEMPTS, 5),
    lockoutMinutes: num(process.env.AUTH_OTP_LOCKOUT_MINUTES, 30),
    rateLimitHourly: num(process.env.AUTH_OTP_RATE_LIMIT_HOURLY, 5),
    rateLimitDaily: num(process.env.AUTH_OTP_RATE_LIMIT_DAILY, 10),
    perIpDaily: num(process.env.AUTH_OTP_PER_IP_DAILY, 20),
    circuitBreakerThreshold: num(process.env.AUTH_OTP_CIRCUIT_BREAKER_THRESHOLD, 25),
    circuitBreakerWindowSec: num(process.env.AUTH_OTP_CIRCUIT_BREAKER_WINDOW_SEC, 300),
  },

  // ---------- Signup hygiene ----------
  signup: {
    // Reject signups using known disposable / throwaway email providers
    // (yopmail, mailinator, temp-mail, etc.). Enforced in
    // AuthService.sendEmailRegistrationOtp (primary, blocks before we send an
    // OTP) and AuthService.register (backstop). Default ON; set
    // SIGNUP_BLOCK_DISPOSABLE_EMAIL=false to disable instantly with no deploy.
    // See src/modules/auth/utils/disposable-email.ts for the blocklist.
    blockDisposableEmail: bool(process.env.SIGNUP_BLOCK_DISPOSABLE_EMAIL, true),
  },

  // ---------- DPDP self-serve account deletion ----------
  accountDeletion: {
    // Published contact / grievance channel shown to a user whose account is
    // scheduled for deletion (recovery is admin-mediated — no self-cancel; the
    // user contacts Zari to recover within the 30-day window). This is the DPDP
    // grievance-officer / DPO surface (ACCOUNT-DELETION-AND-DPDP-PLAN.md §8 / §12,
    // DPDP Rule 13/14).
    //
    // NO email is hardcoded here: it defaults to the on-site /grievance page,
    // which shows the actual grievance mailbox (sourced from the web
    // NEXT_PUBLIC_GRIEVANCE_EMAIL env var). Set ACCOUNT_DELETION_CONTACT_URL to
    // override with a direct mailto: or a different URL. The value is interpolated
    // into plain-text login/signup messages ("Contact us at {contactUrl} to
    // recover it").
    contactUrl:
      process.env.ACCOUNT_DELETION_CONTACT_URL ||
      `${process.env.WEB_APP_URL || 'http://localhost:3001'}/grievance`,
  },

  // ---------- AISENSY (WhatsApp) ----------
  aisensy: {
    apiKey: process.env.AISENSY_API_KEY,
    paymentReminderCampaign:
      process.env.AISENSY_PAYMENT_REMINDER_CAMPAIGN || 'payment_reminder_overdue',
    costPerConversationPaise: num(process.env.AISENSY_COST_PER_CONVERSATION_PAISE, 4000),
  },

  // ---------- Razorpay (platform billing) ----------
  razorpay: {
    keyId: process.env.RAZORPAY_PLATFORM_KEY_ID,
    keySecret: process.env.RAZORPAY_PLATFORM_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET,
  },

  // ---------- Platform legal entity (issues SaaS GST invoices) ----------
  platformLegal: {
    name: process.env.PLATFORM_LEGAL_NAME || 'ManekHR',
    gstin: process.env.PLATFORM_LEGAL_GSTIN || '',
    pan: process.env.PLATFORM_LEGAL_PAN || '',
    addressLine1: process.env.PLATFORM_LEGAL_ADDRESS_LINE1 || '',
    addressLine2: process.env.PLATFORM_LEGAL_ADDRESS_LINE2 || '',
    city: process.env.PLATFORM_LEGAL_CITY || '',
    state: process.env.PLATFORM_LEGAL_STATE || '',
    stateCode: process.env.PLATFORM_LEGAL_STATE_CODE || '',
    pincode: process.env.PLATFORM_LEGAL_PINCODE || '',
    email: process.env.PLATFORM_LEGAL_EMAIL || '',
    phone: process.env.PLATFORM_LEGAL_PHONE || '',
    invoiceNumberPrefix: process.env.PLATFORM_INVOICE_PREFIX || 'ZAR',
  },

  // ---------- Branding asset URLs ----------
  branding: {
    r2PublicUrl: process.env.R2_PUBLIC_URL || '',
    emailHeaderUrl: process.env.BRAND_EMAIL_HEADER_URL,
    emailSignatureUrl: process.env.BRAND_EMAIL_SIGNATURE_URL,
    invoiceHeaderUrl: process.env.BRAND_INVOICE_HEADER_URL,
    watermarkUrl: process.env.BRAND_WATERMARK_URL,
    letterheadUrl: process.env.BRAND_LETTERHEAD_URL,
    taglineInlineUrl: process.env.BRAND_TAGLINE_INLINE_URL,
    taglineStackedUrl: process.env.BRAND_TAGLINE_STACKED_URL,
    taglineEditorialUrl: process.env.BRAND_TAGLINE_EDITORIAL_URL,
  },

  // ---------- Google OAuth ----------
  googleOAuth: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },

  // ---------- JWT ----------
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  // ---------- Auth refresh-token cookie (OQ-1, auth-hardening) ----------
  // The web client's refresh token now lives in an httpOnly, Secure, SameSite
  // cookie instead of localStorage — XSS can no longer read it. The BE sets it
  // on login/register/google/refresh and clears it on logout; the refresh
  // endpoint reads it back from the cookie (falling back to the body for the
  // mobile client, which keeps body-based tokens).
  //   secure   — Secure flag. Defaults to true in production, false otherwise
  //              (so http://localhost dev still works). Override with
  //              AUTH_COOKIE_SECURE.
  //   sameSite — 'lax' default. Web + API are same-site (proxied under one
  //              origin) so 'lax' is correct and survives top-level navigations;
  //              set 'none' (requires secure) only for a truly cross-site SPA.
  //   domain   — optional explicit cookie domain (e.g. ".manekhr.in") so the
  //              cookie is shared across api/app subdomains. Unset = host-only.
  // AUTH-H3: resolveAuthCookie forces secure:true whenever sameSite==='none'
  // (browsers drop SameSite=None without Secure) and warns on the override.
  authCookie: resolveAuthCookie(
    process.env.AUTH_COOKIE_SECURE,
    process.env.AUTH_COOKIE_SAMESITE,
    process.env.NODE_ENV,
  ),

  // ---------- App lock (Quick PIN gate) ----------
  // idleMs   — TTL of the `unlocked:{fam|jti}:*` Redis key written by /auth/pin-verify
  //            (family-keyed `unlocked:fam:*`; `unlocked:jti:*` for legacy tokens).
  //            Web client mirrors this for its idle timer.
  // graceMs  — TTL of the `setup-grace:{fam|jti}:*` Redis key written on every login
  //            for users who have not yet set a PIN. Window for the user to
  //            land on the setup screen and submit before the next API call
  //            423-locks them.
  // resetTokenExpiry — JWT expiry for the short-lived pinResetToken minted by
  //            /auth/forgot-pin-credential-verify, consumed by
  //            /auth/forgot-pin-reset. Mirrors the OTP-in-JWT pattern used by
  //            email verification.
  appLock: {
    idleMs: num(process.env.APP_LOCK_IDLE_MS, 300_000),
    graceMs: num(process.env.APP_LOCK_SETUP_GRACE_MS, 300_000),
    resetTokenExpiry: process.env.APP_LOCK_RESET_TOKEN_EXPIRY || '5m',
    maxFailedAttempts: num(process.env.APP_LOCK_MAX_FAILED_ATTEMPTS, 5),
  },

  // ---------- Storage (R2 / S3 / local) ----------
  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local',
    maxFileSize: num(process.env.UPLOAD_MAX_FILE_SIZE, 5_242_880),
    allowedTypesRaw:
      process.env.UPLOAD_ALLOWED_TYPES || 'image/jpeg,image/png,image/webp,application/pdf',
    uploadsDir: process.env.UPLOADS_DIR || './uploads',
    // Private (signed-URL) media — chat attachments + job-application files.
    // Dir is deliberately OUTSIDE the public `uploadsDir` (which ServeStatic
    // exposes at /uploads) so a dev private file is never statically served;
    // it is reachable only through the token-checked dev route.
    privateUploadsDir: process.env.UPLOADS_PRIVATE_DIR || './uploads-private',
    // HMAC secret for the LOCAL-DEV signed-URL route. Production uses R2
    // presigned URLs and never touches this. Has a dev fallback so the app
    // runs out of the box without R2.
    privateUrlDevSecret: process.env.UPLOADS_PRIVATE_DEV_SECRET || 'dev-private-media-secret',
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      bucket: process.env.R2_BUCKET_NAME || '',
      // Second, NON-public bucket for private media (chat + job-application
      // files). Reuses the same account + credentials as the public bucket;
      // only the bucket name differs. Empty => a private upload fails loudly
      // (no silent fallback to the public bucket). Owner must create the bucket
      // and set R2_PRIVATE_BUCKET_NAME before private uploads work in prod.
      privateBucket: process.env.R2_PRIVATE_BUCKET_NAME || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      publicUrl: process.env.R2_PUBLIC_URL || '',
    },
  },

  // ---------- Crypto / encryption keys ----------
  crypto: {
    smtpEncryptionKey: process.env.SMTP_ENCRYPTION_KEY || '',
    fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY,
  },

  // ---------- Trial credits ----------
  trial: {
    smsCredits: num(process.env.TRIAL_SMS_CREDITS, 10),
    whatsappCredits: num(process.env.TRIAL_WHATSAPP_CREDITS, 5),
  },

  // ---------- Ops alerts ----------
  ops: {
    msg91AlertEmail: process.env.OPS_MSG91_ALERT_EMAIL,
    msg91AlertSmsMobile: process.env.OPS_MSG91_ALERT_SMS_MOBILE,
    msg91AlertDltTemplateId: process.env.OPS_MSG91_ALERT_DLT_TEMPLATE_ID,
    alertThrottleDays: num(process.env.OPS_ALERT_THROTTLE_DAYS, 7),
    alertWorkspaceId: process.env.OPS_ALERT_WORKSPACE_ID,
  },

  // ---------- Surepass (GSTIN verification + filing status) ----------
  // Live getters (not snapshot values): the SurePass key can be rotated / a deploy can refresh
  // the secret after boot, and the SUREPASS_FILING_STUB flag must be honoured whenever it is set
  // (the provider checks `filingStub` first, before the key). Reading process.env on access keeps
  // these centralized in the loader (lint rule) while reflecting the current environment.
  surepass: {
    get apiKey() {
      return process.env.SUREPASS_API_KEY;
    },
    get filingApiKey() {
      return process.env.SUREPASS_FILING_API_KEY;
    },
    get filingStub() {
      return bool(process.env.SUREPASS_FILING_STUB);
    },
  },

  // ---------- Google Document AI (OCR) ----------
  googleDocumentAi: {
    processorId: process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
  },

  // ---------- Seed scripts (developer-only paths) ----------
  seed: {
    mobileAppDir: process.env.MOBILE_APP_DIR,
    webAppDir: process.env.WEB_APP_DIR,
    mobileTranslationsDir: process.env.MOBILE_TRANSLATIONS_DIR,
    webTranslationsDir: process.env.WEB_TRANSLATIONS_DIR,
  },

  // ---------- Sentry (Phase 0.9 wiring; launch hardening — Workstream F) ----------
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
    org: process.env.SENTRY_ORG || '',
    project: process.env.SENTRY_PROJECT || '',
    authToken: process.env.SENTRY_AUTH_TOKEN || '',
    // Deterministic release tag. SENTRY_RELEASE (set this to the git SHA / image
    // tag in the deploy pipeline) wins, then npm_package_version (only populated
    // when launched via an npm script — a bare `node dist/main` would otherwise
    // be untagged). Empty -> Sentry omits the release. Enables release-health /
    // regression tracking so an error spike maps to the exact build.
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version || '',
    // Trace sample rate override (was hardcoded by NODE_ENV). Lower it as traffic
    // ramps. Default 0.1 in production, 1.0 elsewhere.
    tracesSampleRate: float(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      (process.env.NODE_ENV || 'development') === 'production' ? 0.1 : 1.0,
    ),
  },

  // ---------- PostHog server SDK (Phase 4 wiring) ----------
  posthog: {
    apiKey: process.env.POSTHOG_KEY || '',
    host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  },

  // ---------- Structured request logging (Connect startup audit — Finding 2) ----------
  // Output format for the per-request structured logger
  // (`common/interceptors/logging.interceptor.ts` + `common/filters/http-exception.filter.ts`,
  // shared helper `common/logging/request-log.ts`).
  //   json   — one machine-parseable JSON object per line (log aggregators).
  //   pretty — a compact, human-readable single line (local dev).
  // Defaults to `json` in production and `pretty` elsewhere; override explicitly
  // with LOG_FORMAT=json|pretty. NOTE: this governs FORMAT only, never the log
  // LEVEL — level/boot-chatter work is a separate later audit item (Finding 1).
  logging: {
    format: ((): 'json' | 'pretty' => {
      const raw = process.env.LOG_FORMAT;
      if (raw === 'json' || raw === 'pretty') return raw;
      return (process.env.NODE_ENV || 'development') === 'production' ? 'json' : 'pretty';
    })(),
    // Which Nest log levels are emitted (Connect startup audit — Finding 1).
    // Fed to NestFactory.create({ logger }) in main.ts. Production defaults to
    // warn+error+fatal, which drops the ~1,300+ `log`-level boot lines
    // (InstanceLoader + route-map chatter) AND keeps per-request SUCCESS lines
    // (emitted at `log` by the Finding 2 logger) out of the prod stream, while
    // still surfacing the structured failed-request warn/error lines. Dev keeps
    // every level for full visibility. Override with LOG_LEVELS=csv
    // (e.g. LOG_LEVELS=log,warn,error,fatal to re-enable info logs in prod).
    levels: resolveLogLevels(process.env.LOG_LEVELS, process.env.NODE_ENV || 'development'),
  },

  // ---------- Migration runner (ADR-0001 — migration ledger) ----------
  // Opt-in: run the ledgered migration runner ONCE at boot, for fresh local/dev
  // DBs only. Default false — in production migrations run via the explicit
  // `npm run migrate` CLI / CI-CD step, never inside HTTP-server boot. Honoured
  // only on the worker/all process roles (a `web` instance never mutates data at
  // boot). See docs/architecture/adr/0001-migration-ledger.md.
  migrations: {
    runOnBoot: bool(process.env.RUN_MIGRATIONS_ON_BOOT, false),
  },

  // ---------- Salary retention purge (Workstream G hardening, OQ-S4) ----------
  // Hard-erase of salary/payroll/statutory rows whose retention window has
  // lapsed. DEFAULT OFF in every environment so prod never auto-purges until the
  // owner + CA explicitly enable it. Windows are the statutory FLOOR (a workspace
  // may extend via PayrollConfig.retention but never go below these):
  //   - payrollYears: 8  (Payment of Bonus Act / personnel / PF/ESI/PT/TDS)
  //   - wageLedgerYears: 10 (Gujarat wage register + daily-wage cash ledger)
  // See docs/compliance/DATA-MAP-AND-RETENTION.md §2.
  salaryRetention: {
    enabled: bool(process.env.RUN_RETENTION_PURGE_ON_SCHEDULE, false),
    payrollYears: num(process.env.SALARY_RETENTION_PAYROLL_YEARS, 8),
    wageLedgerYears: num(process.env.SALARY_RETENTION_WAGE_LEDGER_YEARS, 10),
  },

  // ---------- Attendance retention purge (Attendance hardening, OQ-A4) ----------
  // Hard-erase of Attendance / AttendanceEvent muster rows whose retention window
  // has lapsed, plus operational DefaulterAlertDispatch idempotency rows.
  // DEFAULT OFF (shares the master RUN_RETENTION_PURGE_ON_SCHEDULE switch with the
  // salary purge) so prod never auto-purges until the owner + CA explicitly enable
  // it. Windows are the statutory FLOOR (a workspace cannot go below these):
  //   - musterYears: 10 (Gujarat muster-cum-wages register, strictest rule — applied
  //     to ALL Attendance + AttendanceEvent rows; OQ-A4 → A)
  //   - dispatchYears: 1 (DefaulterAlertDispatch is Bucket D, no personal data — the
  //     audit/log tier; not subject to the muster floor)
  // See docs/compliance/DATA-MAP-AND-RETENTION.md §2.
  attendanceRetention: {
    enabled: bool(process.env.RUN_RETENTION_PURGE_ON_SCHEDULE, false),
    musterYears: num(process.env.ATTENDANCE_RETENTION_MUSTER_YEARS, 10),
    dispatchYears: num(process.env.ATTENDANCE_RETENTION_DISPATCH_YEARS, 1),
  },

  // ---------- Finance/Bills retention purge (Finance/Bills hardening) ----------
  // Hard-erase of SOFT-DELETED legacy Bill rows (the lightweight AP/AR tracker)
  // whose retention window has lapsed. NEVER touches LedgerEntry, posted
  // PurchaseBill / ExpenseVoucher / PaymentOut, TdsTracker, or CapitalGoodsItc —
  // those are double-entry accounting records that can only be purged at the
  // workspace level (Workspaces hardening pass #7), not individually.
  // DEFAULT OFF (shares the master RUN_RETENTION_PURGE_ON_SCHEDULE switch with the
  // salary + attendance purges) so prod never auto-purges until the owner + CA
  // explicitly enable it. The window is the statutory FLOOR (an env override can
  // only EXTEND it, never shorten below):
  //   - financeYears: 8 (Companies Act 2013 s.128 books-of-account floor; CGST
  //     Rule 56 is 6y, IT Act s.44AA is 6y — 8y dominates and is the binding floor)
  // See docs/compliance/DATA-MAP-AND-RETENTION.md §2 + the Finance/Bills spec D4.
  billsRetention: {
    enabled: bool(process.env.RUN_RETENTION_PURGE_ON_SCHEDULE, false),
    financeYears: num(process.env.BILLS_RETENTION_FINANCE_YEARS, 8),
  },

  // ---------- RBAC override retention cleaner (RBAC hardening, Pillar 1) ----------
  // Clears the per-member access-control overrides (TeamMember.permissionOverrides
  // + permissionPathOverrides) on members removed longer than the keep window.
  // Owner decision (2026-06-15): revoke access NOW (handled at offboard via the
  // membership-status flip + Redis denylist; the leftover override rows are
  // already INERT for a removed member — see RolesGuard.resolveCaller), then KEEP
  // the override RECORD ~1 year for audit ("what access did this person have?")
  // and auto-clear it after. This is a SCRUB of Bucket-C config (arrays → []),
  // NOT a hard-delete of the TeamMember row — identity/statutory data is retained
  // by the Team/Salary/Attendance retention paths. NEVER touches active members
  // or Role definitions.
  // DEFAULT OFF (shares the master RUN_RETENTION_PURGE_ON_SCHEDULE switch with the
  // salary/attendance/bills purges) so prod never auto-clears until the owner
  // enables it. The keep window is the FLOOR (an env override can only EXTEND it):
  //   - overrideKeepYears: 1 (audit-trail keep window for per-member overrides;
  //     mirrors the ~1y RBAC audit-log retention — DATA-MAP §2 / RBAC spec §2).
  rbacRetention: {
    enabled: bool(process.env.RUN_RETENTION_PURGE_ON_SCHEDULE, false),
    overrideKeepYears: num(process.env.RBAC_RETENTION_OVERRIDE_KEEP_YEARS, 1),
  },

  // ---------- Workspace retention purge (Workspaces hardening, §3e) ----------
  // Scrubs Bucket-C profile/config fields (branding logos, notification policy,
  // self-service config, party intelligence, autoAcceptKnownInvites, storage
  // usage, app-lock idle, export prefs, residual SMTP host/port/user) from
  // SOFT-DELETED workspace rows after a grace window. Anchored on `deletedAt`.
  // Bucket-A identity (name/code/designations/bankAccounts/settings) and ALL
  // Bucket-B statutory rows are RETAINED — this cron NEVER deletes the workspace
  // row or any statutory data (the row-purge "last-B" condition is a deferred
  // follow-up; see workspace-retention-purge.cron.ts). Credentials (kiosk +
  // ingest token + SMTP password) were already scrubbed IMMEDIATELY at
  // soft-delete time, not here. DEFAULT OFF — shares the master
  // RUN_RETENTION_PURGE_ON_SCHEDULE switch with the salary/attendance/bills/rbac
  // purges. graceDays is a per-workspace setting with the code floor as the
  // legal-minimum (an env value below the floor cannot shorten it).
  workspaceRetention: {
    enabled: bool(process.env.RUN_RETENTION_PURGE_ON_SCHEDULE, false),
    graceDays: num(process.env.WORKSPACE_RETENTION_GRACE_DAYS, 90),
  },

  // ---------- Health / readiness probes (launch — Workstream F) ----------
  // Per-dependency probe budget for GET /api/ready. Mongo + Redis are each
  // pinged with this timeout so a wedged socket reports `down` instead of
  // hanging the readiness probe (which would in turn hang the load-balancer /
  // uptime check). 3s is generous for an in-region Mongo/Redis; tune via
  // HEALTH_PROBE_TIMEOUT_MS if a managed dependency is slower.
  health: {
    probeTimeoutMs: num(process.env.HEALTH_PROBE_TIMEOUT_MS, 3000),
  },

  // ---------- Queue-backlog monitor (launch monitoring — Workstream F) ----------
  // A worker-side cron (QueueMonitorService) samples the BullMQ queues
  // (connect-feed-fanout / billing-dunning / einvoice-retry) every minute and
  // raises a Sentry message + structured warn/error log when a queue's waiting
  // backlog or failed count crosses a threshold, or a backlog exists with zero
  // active workers (stalled). Runs on the worker/all role only (web stops crons
  // at boot). Default ON — the cost is three getJobCounts() reads/min and a
  // Sentry capture only on breach (a no-op until SENTRY_DSN is set). Set
  // QUEUE_MONITOR_ENABLED=false to silence it. Thresholds are tunable per
  // deployment once real traffic shapes the normal queue depth.
  queueMonitor: {
    enabled: bool(process.env.QUEUE_MONITOR_ENABLED, true),
    waitingThreshold: num(process.env.QUEUE_MONITOR_WAITING_THRESHOLD, 500),
    failedThreshold: num(process.env.QUEUE_MONITOR_FAILED_THRESHOLD, 50),
  },

  // ---------- CORS production allowlist (Phase 4) ----------
  corsAllowedOrigins: csv(process.env.CORS_ALLOWED_ORIGINS),

  // ---------- Backups (Phase 4) ----------
  backup: {
    bucket: process.env.BACKUP_BUCKET || '',
    endpoint: process.env.BACKUP_ENDPOINT || '',
    accessKey: process.env.BACKUP_ACCESS_KEY || '',
    secretKey: process.env.BACKUP_SECRET_KEY || '',
    retentionDays: num(process.env.BACKUP_RETENTION_DAYS, 30),
  },

  // ---------- OpenTelemetry (Phase 3.5 W4 — auth pilot; Phase 4 cross-module) ----------
  otel: {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS || '',
    serviceName: process.env.OTEL_SERVICE_NAME || 'crewroster-backend',
    sampleRate: float(process.env.OTEL_SAMPLE_RATE, 1.0),
  },

  // ---------- Meilisearch (ManekHR Connect — people / entity search) ----------
  // Backs `connect/search`. When `host` is blank the `MeiliClient` reports
  // `enabled === false` and `SearchService` transparently falls back to a
  // Mongo-regex search — a missing Meili deployment never breaks the endpoint.
  meili: {
    host: process.env.MEILI_HOST || '',
    apiKey: process.env.MEILI_API_KEY || '',
  },

} as const;

export type AppEnv = typeof env;
