import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { BillsService } from './bills.service';
import { CreateBillDto, UpdateBillDto, RecordBillPaymentDto } from './dto/bill.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { isWorkspaceOwner } from '../../common/utils/workspace-ownership.util';
import { applyPathOverrides } from '../../modules/rbac/permission-path-overrides';
import { pathGrantSatisfies } from '../../modules/rbac/permission-matcher';

/**
 * BillsController — legacy AP/AR Bills surface.
 *
 * Finance/Bills hardening (OQ-FB-2): migrated OFF the DEPRECATED
 * `@RequirePermissions(AppModule.BILLS, …)` flat permission (which had NO scope,
 * so a Worker/Karigar holding BILLS.VIEW could list every workspace bill) ONTO
 * the FINANCE path model (`finance.payable.*`, scope `all`). Bills are company
 * financials, NOT worker self-data — the Worker/Karigar role preset carries ZERO
 * finance.* grants, so this removes worker Bills access end to end. The seeded
 * Manager/HR roles carry the new paths (HR additionally holds the sensitive
 * `delete`); existing workspaces are backfilled by migration 0042.
 *
 * Tenant scope (OQ-FB-4): every route is `workspaces/:workspaceId/bills` and the
 * service queries always AND-in `{ workspaceId, isDeleted:false }`, so there is
 * no cross-workspace read/write and soft-deleted bills never surface. Scope is
 * `all` (workspace-scoped, not self): finance is organizational, so any holder
 * sees ALL of the workspace's bills.
 */
@Controller('workspaces/:workspaceId/bills')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillsController {
  constructor(
    private readonly billsService: BillsService,
    // Read-only models for the Owner/HR override resolution on the paid-invoice
    // replacement guard (D1). Resolved by name token; no extra module import.
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('WorkspaceMember') private readonly memberModel: Model<any>,
    @InjectModel('Role') private readonly roleModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
  ) {}

  @Get()
  @RequirePermission('finance.payable.view', 'all')
  findAll(@Param('workspaceId') workspaceId: string, @Query() query: any) {
    return this.billsService.findAll(workspaceId, query);
  }

  @Post()
  @RequirePermission('finance.payable.create', 'all')
  create(@Param('workspaceId') workspaceId: string, @Req() req, @Body() createDto: CreateBillDto) {
    return this.billsService.create(workspaceId, req.user.sub, createDto);
  }

  @Get(':billId')
  @RequirePermission('finance.payable.view', 'all')
  findOne(@Param('workspaceId') workspaceId: string, @Param('billId') billId: string) {
    return this.billsService.findById(workspaceId, billId);
  }

  @Patch(':billId')
  @RequirePermission('finance.payable.edit', 'all')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('billId') billId: string,
    @Req() req,
    @Body() updateDto: UpdateBillDto,
  ) {
    // D1: only an Owner/HR may replace the invoice on a PAID bill. Resolve that
    // privilege here (cheap, owner short-circuits) and pass it to the service,
    // which enforces the block + audits the override.
    const isOwnerOrHr = await this.resolveOwnerOrHr(workspaceId, req.user.sub);
    return this.billsService.update(workspaceId, billId, updateDto, req.user.sub, isOwnerOrHr);
  }

  @Delete(':billId')
  // Sensitive (soft-delete of a statutory AP/AR record) — HR/Owner only by
  // preset (Manager does NOT hold finance.payable.delete).
  @RequirePermission('finance.payable.delete', 'all')
  remove(@Param('workspaceId') workspaceId: string, @Param('billId') billId: string, @Req() req) {
    // OQ-FB-1 / BUG-FB-1: soft-delete, passing the actor as deletedBy.
    return this.billsService.remove(workspaceId, billId, req.user.sub);
  }

  @Post(':billId/payments')
  @RequirePermission('finance.payable.recordPayment', 'all')
  recordPayment(
    @Param('workspaceId') workspaceId: string,
    @Param('billId') billId: string,
    @Req() req,
    @Body() paymentDto: RecordBillPaymentDto,
  ) {
    return this.billsService.recordPayment(workspaceId, billId, paymentDto, req.user.sub);
  }

  /**
   * Resolve whether the caller is the workspace Owner or holds an HR-tier grant.
   * Used ONLY to permit the D1 paid-invoice replacement override (a rare,
   * audited correction). Mirrors the RolesGuard resolution chain read-only:
   * owner short-circuits; otherwise the caller's effective permissionPaths
   * (role + per-member path overrides) must include `finance.payable.delete`,
   * which is HR/Owner-only by preset (Manager lacks it). Fail-closed: any lookup
   * miss returns false so the block stays in force.
   */
  private async resolveOwnerOrHr(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const ws = await this.workspaceModel.findById(workspaceId).lean().exec();
      if (!ws || ws.isDeleted === true) return false;
      if (isWorkspaceOwner(ws, userId)) return true;

      const member = await this.memberModel
        .findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          userId: new mongoose.Types.ObjectId(userId),
          status: 'active',
        })
        .lean()
        .exec();
      if (!member?.roleId) return false;

      const role = await this.roleModel
        .findOne({ _id: new mongoose.Types.ObjectId(String(member.roleId)) })
        .lean()
        .exec();
      if (!role) return false;

      const teamMember = await this.teamMemberModel
        .findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          linkedUserId: new mongoose.Types.ObjectId(userId),
          isDeleted: false,
        })
        .select('permissionPathOverrides')
        .lean()
        .exec();

      const grantedPaths = applyPathOverrides(
        role.permissionPaths ?? [],
        teamMember?.permissionPathOverrides ?? [],
      );
      return pathGrantSatisfies(grantedPaths, {
        path: 'finance.payable.delete',
        scope: 'all',
      });
    } catch {
      return false;
    }
  }
}
