import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types, UpdateQuery } from 'mongoose';
import { Firm } from './firm.schema';
import { AccountsService } from '../ledger/accounts.service';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { CashRegistersService } from '../cash-registers/cash-registers.service';
import { GodownsService } from '../inventory/godowns/godowns.service';
import { FiscalYearService } from '../fiscal-year/fiscal-year.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { encryptSmtpPassword } from '../../../common/utils/crypto-utils';
import { UpdateGstConfigDto } from './dto/update-gst-config.dto';
import { UpdateFirmBrandingDto } from './dto/update-firm-branding.dto';
import { UpdateInvoiceLayoutDto } from './dto/update-invoice-layout.dto';
import { UpdateFirmGstinsDto } from './dto/update-firm-gstins.dto';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';

@Injectable()
export class FirmsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap each write; the firm-settings PostHog event fires only on create()
  // (the one write that receives a userId). The other firm-config writes do not
  // thread a userId and the polish rule forbids changing their signatures, so they
  // get spans only.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Firm.name) private readonly model: Model<Firm>,
    private readonly accountsService: AccountsService,
    private readonly voucherSeriesService: VoucherSeriesService,
    @Inject(forwardRef(() => CashRegistersService))
    private readonly cashRegistersService: any,
    @Inject(forwardRef(() => GodownsService))
    private readonly godownsService: GodownsService,
    @Inject(forwardRef(() => FiscalYearService))
    private readonly fiscalYearService: FiscalYearService,
    private readonly postHog: PostHogService,
    private readonly auditService: AuditService,
  ) {}

  async create(workspaceId: string, userId: string, dto: any): Promise<Firm> {
    return withFinanceSpan(this.tracer, 'finance.createFirm', { workspaceId, userId }, async () => {
      const firm = new this.model({
        ...dto,
        workspaceId: new Types.ObjectId(workspaceId),
        setupChecklistState: {
          step1Done: true,
          step2Done: false,
          step3Done: false,
          dismissedFields: [],
        },
      });
      const savedFirm = await firm.save();
      const firmId = savedFirm._id.toString();

      // Seed accounts from business-type template (idempotent)
      await this.accountsService.seedFromTemplate(
        workspaceId,
        firmId,
        dto.businessType ?? 'trading',
      );

      // Seed default "Main Cash" register
      await this.cashRegistersService.seedDefault(workspaceId, firmId);

      // Auto-seed default voucher series for this FY
      await this.voucherSeriesService.seedDefaults(workspaceId, firmId, dto.fyStartMonth ?? 4);

      // D-02: Auto-seed the "Main Godown" for this firm
      await this.seedMainGodown(workspaceId, savedFirm._id);

      // F-15 Plan 03 (D-12): Auto-seed default fiscal year (Apr 1 → Mar 31 of
      // current Indian FY) so all subsequent voucher writes can resolve a FY
      // and the FY-lock guard short-circuits cleanly when no record matches.
      await this.fiscalYearService.seedDefaultFy(workspaceId, savedFirm._id, dto.fyStartMonth ?? 4);

      // Fire-and-forget product analytics on the firm-create write (ids only,
      // no PII - never the firm's GSTIN / PAN / contact details).
      this.postHog.capture({
        distinctId: userId,
        event: 'finance_settings.created_firm',
        properties: { workspaceId, firmId },
      });

      return savedFirm;
    });
  }

  async findAll(workspaceId: string): Promise<Firm[]> {
    return this.model
      .find({ workspaceId: new Types.ObjectId(workspaceId), isDeleted: false })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(workspaceId: string, firmId: string): Promise<Firm> {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(firmId),
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('Firm not found');
    return doc;
  }

  async update(workspaceId: string, firmId: string, dto: any): Promise<Firm> {
    return withFinanceSpan(this.tracer, 'finance.updateFirm', { workspaceId, firmId }, async () => {
      // CR-02: strip credential fields before $set — prevents plaintext overwrite of
      // encrypted credentials that are managed exclusively via updateGstConfig().
      // (Razorpay/Cashfree gateway entries removed 2026-06-06 with the dead Firm fields -
      // feedback_no_payments_in_billing; the finance module does no payment collection.)
      const BLOCKED_FIELDS = ['irpConfig', 'ewbConfig'];
      const safeDto = Object.fromEntries(
        Object.entries(dto as Record<string, unknown>).filter(([k]) => !BLOCKED_FIELDS.includes(k)),
      );

      const doc = await this.model
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(firmId),
            workspaceId: new Types.ObjectId(workspaceId),
            isDeleted: false,
          },
          { $set: safeDto },
          { new: true },
        )
        .exec();
      if (!doc) throw new NotFoundException('Firm not found');
      return doc;
    });
  }

  async remove(workspaceId: string, firmId: string): Promise<void> {
    return withFinanceSpan(this.tracer, 'finance.removeFirm', { workspaceId, firmId }, async () => {
      const result = await this.model
        .updateOne(
          {
            _id: new Types.ObjectId(firmId),
            workspaceId: new Types.ObjectId(workspaceId),
            isDeleted: false,
          },
          { isDeleted: true, deletedAt: new Date() },
        )
        .exec();
      if (result.matchedCount === 0) throw new NotFoundException('Firm not found');
    });
  }

  // Fields each wizard step is permitted to write. The wizard previously
  // `$set` the raw request body, which (a) silently dropped off-schema fields
  // (address/contact were never persisted) and (b) was a mass-assignment hole
  // (a crafted body could overwrite credentials / arbitrary firm fields,
  // bypassing the BLOCKED_FIELDS guard that update() applies). Only the known
  // per-step fields below are persisted; anything else in the body is ignored.
  private static readonly WIZARD_STEP_FIELDS: Record<1 | 2 | 3, readonly string[]> = {
    1: ['firmName', 'businessType', 'gstin', 'pan', 'accountsBooksBeginDate'],
    2: [
      'address',
      'contactPhone',
      'contactEmail',
      'website',
      'aato',
      'inventoryValuationMethod',
      'lateFeePct',
    ],
    3: ['primaryRole', 'roundingPolicy'],
  };

  async updateWizardStep(
    workspaceId: string,
    firmId: string,
    step: 1 | 2 | 3,
    dto: Record<string, unknown>,
  ): Promise<Firm> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateFirmWizardStep',
      { workspaceId, firmId, step },
      async () => {
        const allowed = FirmsService.WIZARD_STEP_FIELDS[step] ?? [];
        const setFields: Record<string, unknown> = {};
        for (const key of allowed) {
          if (dto && dto[key] !== undefined) setFields[key] = dto[key];
        }
        setFields[`setupChecklistState.step${step}Done`] = true;

        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(firmId),
              workspaceId: new Types.ObjectId(workspaceId),
              isDeleted: false,
            },
            { $set: setFields },
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('Firm not found');
        return doc;
      },
    );
  }

  /**
   * D-02: Auto-seeds the "Main Godown" for a newly created firm.
   * Called from create() after the firm document is persisted.
   * Delegates to GodownsService.seedMainGodown (idempotent).
   */
  async seedMainGodown(workspaceId: string, firmId: Types.ObjectId): Promise<void> {
    await this.godownsService.seedMainGodown(workspaceId, firmId.toString());
  }

  /**
   * F-12: Updates firm irpConfig and ewbConfig for GST integration.
   * Encrypts gspKey and password fields before persisting — never stores plaintext.
   * Returns masked config (gspKey and encryptedPassword replaced with boolean indicators).
   */
  async updateGstConfig(
    workspaceId: string,
    firmId: string,
    dto: UpdateGstConfigDto,
  ): Promise<Firm> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateFirmGstConfig',
      { workspaceId, firmId },
      // Span only - body contains encrypted GSP keys / credentials. Attributes
      // stay ids-only; never log the gspKey / username / password.
      () => this.updateGstConfigImpl(workspaceId, firmId, dto),
    );
  }

  private async updateGstConfigImpl(
    workspaceId: string,
    firmId: string,
    dto: UpdateGstConfigDto,
  ): Promise<Firm> {
    const setFields: Record<string, any> = {};

    if (dto.irpConfig) {
      const irp = dto.irpConfig;
      setFields['irpConfig.mode'] = irp.mode;
      if (irp.gspKey !== undefined && irp.gspKey !== '') {
        setFields['irpConfig.gspKey'] = encryptSmtpPassword(irp.gspKey);
      }
      if (irp.username !== undefined) {
        setFields['irpConfig.username'] = irp.username;
      }
      if (irp.password !== undefined && irp.password !== '') {
        setFields['irpConfig.encryptedPassword'] = encryptSmtpPassword(irp.password);
      }
    }

    if (dto.ewbConfig) {
      const ewb = dto.ewbConfig;
      setFields['ewbConfig.mode'] = ewb.mode;
      if (ewb.gspKey !== undefined && ewb.gspKey !== '') {
        setFields['ewbConfig.gspKey'] = encryptSmtpPassword(ewb.gspKey);
      }
      if (ewb.username !== undefined) {
        setFields['ewbConfig.username'] = ewb.username;
      }
      if (ewb.password !== undefined && ewb.password !== '') {
        setFields['ewbConfig.encryptedPassword'] = encryptSmtpPassword(ewb.password);
      }
    }

    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(firmId),
          workspaceId: new Types.ObjectId(workspaceId),
          isDeleted: false,
        },
        { $set: setFields },
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Firm not found');

    // Mask sensitive fields on return — never return plaintext keys
    const masked = doc.toObject() as any;
    if (masked.irpConfig) {
      masked.irpConfig = {
        mode: masked.irpConfig.mode,
        gspKeySet: !!masked.irpConfig.gspKey,
        usernameSet: !!masked.irpConfig.username,
        passwordSet: !!masked.irpConfig.encryptedPassword,
      };
    }
    if (masked.ewbConfig) {
      masked.ewbConfig = {
        mode: masked.ewbConfig.mode,
        gspKeySet: !!masked.ewbConfig.gspKey,
        usernameSet: !!masked.ewbConfig.username,
        passwordSet: !!masked.ewbConfig.encryptedPassword,
      };
    }
    return masked as Firm;
  }

  /**
   * Finance branding editor (design spec 2026-06-01 SS2C / SS6.A). Persists the
   * invoice/voucher branding keys onto `firm.brandProfile`. The print themes
   * already consume these keys; this is the write path.
   *
   * Uses dot-notation `$set` / `$unset` (`brandProfile.<key>`) so a partial
   * PATCH updates only the supplied keys and never clobbers sibling brand
   * values. A key sent as `null` clears (unsets) that brand value; any other
   * value upserts it. Only the DTO's own (validated) keys are projected in, so
   * no arbitrary key can be written through this path.
   */
  async updateBranding(
    workspaceId: string,
    firmId: string,
    dto: UpdateFirmBrandingDto,
  ): Promise<Firm> {
    return withFinanceSpan(this.tracer, 'finance.updateFirmBranding', { workspaceId, firmId }, () =>
      this.updateBrandingImpl(workspaceId, firmId, dto),
    );
  }

  private async updateBrandingImpl(
    workspaceId: string,
    firmId: string,
    dto: UpdateFirmBrandingDto,
  ): Promise<Firm> {
    // Partition the (validated) DTO keys. An explicit `null` means "clear this
    // brand field" and maps to `$unset`; any other defined value maps to `$set`.
    // A key omitted from the PATCH body stays untouched. Without the `$unset`
    // branch a cleared logo / colour / footer would keep its old stored value.
    const setFields: Record<string, unknown> = {};
    const unsetFields: Record<string, ''> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === null) {
        unsetFields[`brandProfile.${key}`] = '';
      } else if (value !== undefined) {
        setFields[`brandProfile.${key}`] = value;
      }
    }

    const update: UpdateQuery<Firm> = {};
    if (Object.keys(setFields).length > 0) update.$set = setFields;
    if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;

    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(firmId),
          workspaceId: new Types.ObjectId(workspaceId),
          isDeleted: false,
        },
        // A no-op PATCH (nothing to set or unset) passes `{}` so Mongo returns
        // the firm unchanged instead of rejecting an empty operator object.
        update,
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Firm not found');
    return doc;
  }

  /**
   * Invoice layout config editor (design spec 2026-06-01 SS2C / 3B). Persists
   * the show/hide flags onto `firm.invoiceLayout`. Uses dot-notation `$set` so
   * a partial PATCH updates only the supplied keys and never clobbers the other
   * flags. Omitted keys stay untouched (they keep their stored or default value).
   * The themes use `layout?.<flag> !== false` so a stored `true` and an absent
   * key both render the section; only an explicit `false` hides it.
   */
  async updateInvoiceLayout(
    workspaceId: string,
    firmId: string,
    dto: UpdateInvoiceLayoutDto,
  ): Promise<Firm> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateFirmInvoiceLayout',
      { workspaceId, firmId },
      () => this.updateInvoiceLayoutImpl(workspaceId, firmId, dto),
    );
  }

  private async updateInvoiceLayoutImpl(
    workspaceId: string,
    firmId: string,
    dto: UpdateInvoiceLayoutDto,
  ): Promise<Firm> {
    const setFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) {
        setFields[`invoiceLayout.${key}`] = value;
      }
    }

    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(firmId),
          workspaceId: new Types.ObjectId(workspaceId),
          isDeleted: false,
        },
        Object.keys(setFields).length > 0 ? { $set: setFields } : {},
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Firm not found');
    return doc;
  }

  // D21: set the firm's period-lock date (or clear it when null/empty). Postings/edits dated
  // on or before this date are then blocked by FyLockService.assertOpen.
  async setBooksLock(
    workspaceId: string,
    firmId: string,
    lockedUptoDate: string | null | undefined,
    userId: string,
  ): Promise<Firm> {
    return withFinanceSpan(
      this.tracer,
      'finance.setFirmBooksLock',
      { workspaceId, firmId },
      async () => {
        const update =
          lockedUptoDate == null || lockedUptoDate === ''
            ? { $unset: { booksLockedUptoDate: '' } }
            : { $set: { booksLockedUptoDate: new Date(lockedUptoDate) } };
        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(firmId),
              workspaceId: new Types.ObjectId(workspaceId),
              isDeleted: false,
            },
            update,
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('Firm not found');
        // D16/R6: books-lock is a compliance control - locking/unlocking re-opens filed periods
        // for edits, so record who changed it and to what. Awaited (was fire-and-forget) so the
        // audit row completes before the response; a logging failure is swallowed, never fatal.
        await this.auditService
          .logEvent({
            workspaceId,
            module: AppModule.FINANCE,
            entityType: 'firm_books_lock',
            entityId: firmId,
            action: lockedUptoDate ? 'finance.books_locked' : 'finance.books_unlocked',
            actorId: userId,
            meta: { lockedUptoDate: lockedUptoDate ?? null },
          })
          .catch(() => undefined);
        return doc;
      },
    );
  }

  /**
   * 2f multi-GSTIN: replace the firm's additional state GSTIN registrations.
   * stateCode is normalized to the GSTIN's leading two digits to keep the pair
   * internally consistent.
   */
  async updateAdditionalGstins(
    workspaceId: string,
    firmId: string,
    dto: UpdateFirmGstinsDto,
  ): Promise<Firm> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateFirmAdditionalGstins',
      { workspaceId, firmId },
      // Span only - never log the GSTIN strings themselves as attributes.
      () => this.updateAdditionalGstinsImpl(workspaceId, firmId, dto),
    );
  }

  private async updateAdditionalGstinsImpl(
    workspaceId: string,
    firmId: string,
    dto: UpdateFirmGstinsDto,
  ): Promise<Firm> {
    const additionalGstins = (dto.additionalGstins ?? []).map((e) => ({
      gstin: e.gstin,
      stateCode: e.gstin.slice(0, 2),
      label: e.label,
    }));
    const doc = await this.model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(firmId),
          workspaceId: new Types.ObjectId(workspaceId),
          isDeleted: false,
        },
        { $set: { additionalGstins } },
        { new: true },
      )
      .exec();
    if (!doc) throw new NotFoundException('Firm not found');
    return doc;
  }

  /**
   * D-02: Returns the default godown ObjectId for a firm.
   * Used by InventoryService.resolveGodownId fallback when a line lacks godownId.
   */
  async getDefaultGodownId(firmId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const godowns = await this.godownsService.list('', firmId.toString());
    const defaultGodown = godowns.find((g) => g.isDefault);
    if (!defaultGodown) return null;
    return defaultGodown._id;
  }

  /**
   * Setup-checklist items shown on the finance dashboard. Each item reflects a
   * REAL persisted state and links to the REAL page that completes it. The
   * earlier version had two dead `settings?tab=...` links, an address check
   * against a field that was never written, and a "voucher series" item that
   * went green from an unrelated wizard step (series are auto-seeded at firm
   * creation, so that was never a real to-do). Items are intentionally limited
   * to the things a firm genuinely needs before issuing a clean GST invoice.
   */
  async getSetupChecklist(workspaceId: string, firmId: string): Promise<any[]> {
    const firm = await this.findOne(workspaceId, firmId);
    const bp = firm.brandProfile ?? {};
    const addr = firm.address ?? {};
    const base = `/dashboard/finance/firms/${firmId}`;
    const profileRoute = `${base}/settings/business`;
    const brandingRoute = `${base}/settings/branding`;

    return [
      {
        key: 'tax_identity',
        label: 'Add GSTIN & tax details',
        done: !!firm.gstin,
        route: profileRoute,
      },
      {
        key: 'business_address',
        label: 'Add business address',
        done: !!addr.line1,
        route: profileRoute,
      },
      {
        key: 'brand_profile',
        label: 'Add logo & signature',
        done: !!bp.logoUrl,
        route: brandingRoute,
      },
      {
        key: 'bank_details',
        label: 'Add bank details for invoices',
        done: !!(bp.bankAccountNumber || bp.bankName),
        route: brandingRoute,
      },
    ];
  }
}
