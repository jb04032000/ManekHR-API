import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Request } from 'express';
// Side-effect import: registers Express.Request.user typing.
import '../../../common/types/express-request.augmentation';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { isWorkspaceOwner } from '../../../common/utils/workspace-ownership.util';
import { FirmsService } from './firms.service';
import { UpdateFirmDto } from './dto/update-firm.dto';
import { UpdateGstConfigDto } from './dto/update-gst-config.dto';
import { UpdateFirmBrandingDto } from './dto/update-firm-branding.dto';
import { UpdateInvoiceLayoutDto } from './dto/update-invoice-layout.dto';
import { UpdateFirmGstinsDto } from './dto/update-firm-gstins.dto';
import { SetBooksLockDto } from './dto/set-books-lock.dto';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { WorkspaceMember } from '../../workspaces/schemas/workspace-member.schema';
import { LegacyUnclassified } from '../../../common/decorators/legacy-unclassified.decorator';

@ApiTags('Finance - Settings')
@LegacyUnclassified()
@Controller('workspaces/:workspaceId/finance/firms')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class FirmsController {
  constructor(
    private readonly firmsService: FirmsService,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(WorkspaceMember.name)
    private readonly memberModel: Model<WorkspaceMember>,
  ) {}

  // POST /firms removed: Firm is auto-created with the Workspace (1:1).
  // Use PATCH /:firmId to update fields, or wizard endpoints for setup.

  // POST /firms/ensure — idempotent recovery endpoint for the case when
  // workspace creation succeeded but the firm cascade failed silently.
  // If a firm exists for this workspace, returns it; otherwise creates one
  // with safe defaults so the user can complete setup via the wizard.
  //
  // Intentionally does NOT use @RequirePermissions / @RequireSubscription —
  // those gate behind plan/role permissions, but this is workspace bootstrap
  // recovery. A workspace owner or active member with no Finance permissions
  // would otherwise be locked out of fixing their own workspace. We do the
  // ownership check inline instead.
  @Post('ensure')
  async ensure(
    @Param('workspaceId') wsId: string,
    @Req() req: Request,
    @Body()
    dto: {
      firmName?: string;
      businessType?: string;
      gstin?: string;
      pan?: string;
      fyStartMonth?: number;
    },
  ) {
    const userId = req.user?.sub;
    if (!userId) throw new ForbiddenException('Not authenticated');

    const workspace = await this.workspaceModel.findById(new Types.ObjectId(wsId)).exec();
    if (!workspace) throw new ForbiddenException('Workspace not found');

    const isOwner = isWorkspaceOwner(workspace, userId);
    if (!isOwner) {
      const member = await this.memberModel
        .findOne({
          workspaceId: new Types.ObjectId(wsId),
          userId: new Types.ObjectId(userId),
          status: 'active',
        })
        .exec();
      if (!member) {
        throw new ForbiddenException('Not a member of this workspace');
      }
    }

    const existing = await this.firmsService.findAll(wsId);
    if (existing.length > 0) return existing[0];
    return this.firmsService.create(wsId, userId, {
      firmName: dto?.firmName ?? 'My Business',
      businessType: dto?.businessType ?? 'trading',
      gstin: dto?.gstin,
      pan: dto?.pan,
      fyStartMonth: dto?.fyStartMonth ?? 4,
    });
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  findAll(@Param('workspaceId') wsId: string) {
    return this.firmsService.findAll(wsId);
  }

  // GET /firms/current — convenience endpoint returning the workspace's
  // single firm (1:1). Frontend should prefer this over findAll[0].
  @Get('current')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  async findCurrent(@Param('workspaceId') wsId: string) {
    const firms = await this.firmsService.findAll(wsId);
    return firms[0] ?? null;
  }

  @Get(':firmId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  findOne(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.firmsService.findOne(wsId, firmId);
  }

  @Patch(':firmId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateFirmDto,
  ) {
    return this.firmsService.update(wsId, firmId, dto);
  }

  // DELETE /:firmId removed: Firm is bound 1:1 to Workspace.
  // To delete a firm, delete the workspace.

  @Patch(':firmId/gst-config')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.GST_COMPLIANCE, subFeature: 'gstin_lookup' })
  updateGstConfig(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateGstConfigDto,
  ) {
    return this.firmsService.updateGstConfig(wsId, firmId, dto);
  }

  // PATCH /:firmId/branding — finance branding editor (design spec 2026-06-01
  // SS2C / SS6.A). Writes the logo / signature / brand colours / footer / T&C /
  // declaration / bank + UPI keys onto `firm.brandProfile`, which the voucher
  // print themes already render. This is the FIRST slice of the finance module
  // migrated to the new path-RBAC marker: gated by `finance.settings.manage`
  // (registered leaf, Owner/HR-only by preset). The handler-level
  // `@RequirePermission` overrides the class-level `@LegacyUnclassified` marker
  // in RolesGuard (real marker wins). Subscription gate mirrors the other firm-
  // config writes.
  @Patch(':firmId/branding')
  @RequirePermission('finance.settings.manage')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  updateBranding(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateFirmBrandingDto,
  ) {
    return this.firmsService.updateBranding(wsId, firmId, dto);
  }

  // PATCH /:firmId/invoice-layout — per-firm invoice section config (design spec
  // 2026-06-01 SS2C / 3B). Five show/hide flags that the A4 web print themes
  // honour. All flags default to true so an absent invoiceLayout is safe
  // (themes render identically to today). Gated by `finance.settings.manage`
  // and RequireSubscription matching the branding endpoint convention.
  @Patch(':firmId/invoice-layout')
  @RequirePermission('finance.settings.manage')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  updateInvoiceLayout(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateInvoiceLayoutDto,
  ) {
    return this.firmsService.updateInvoiceLayout(wsId, firmId, dto);
  }

  // PATCH /:firmId/gstins — 2f multi-GSTIN: replace the firm's additional state
  // GSTIN registrations (the primary `gstin` stays on the firm record). Gated by
  // `finance.settings.manage` like the other firm-config writes.
  @Patch(':firmId/gstins')
  @RequirePermission('finance.settings.manage')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  updateGstins(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: UpdateFirmGstinsDto,
  ) {
    return this.firmsService.updateAdditionalGstins(wsId, firmId, dto);
  }

  // PATCH /:firmId/books-lock — D21 period locking. Set a date to lock all postings/edits
  // dated on or before it (after GSTR filing / month close); send null to unlock. Gated by
  // finance.settings.manage like the other firm-config writes.
  @Patch(':firmId/books-lock')
  @RequirePermission('finance.settings.manage')
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  setBooksLock(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: SetBooksLockDto,
    @Req() req: Request,
  ) {
    const u = req.user as { _id?: string; sub?: string } | undefined;
    return this.firmsService.setBooksLock(wsId, firmId, dto.lockedUptoDate, u?._id ?? u?.sub ?? '');
  }

  @Post(':firmId/wizard/step1')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  wizardStep1(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: any,
  ) {
    return this.firmsService.updateWizardStep(wsId, firmId, 1, dto);
  }

  @Post(':firmId/wizard/step2')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  wizardStep2(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: any,
  ) {
    return this.firmsService.updateWizardStep(wsId, firmId, 2, dto);
  }

  @Post(':firmId/wizard/step3')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  @RequireSubscription({ module: AppModule.FINANCE, subFeature: 'accounting_setup_checklist' })
  wizardStep3(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: any,
  ) {
    return this.firmsService.updateWizardStep(wsId, firmId, 3, dto);
  }
}
