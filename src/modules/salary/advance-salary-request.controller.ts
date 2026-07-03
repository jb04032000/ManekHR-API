import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { AdvanceSalaryRequestService } from './advance-salary-request.service';
// SalaryService owns approveAndDisburseAdvanceRequest (approve + record advance Payment +
// start interest-free installment recovery). Dependency is one-way: SalaryService already
// injects AdvanceSalaryRequestService, so the controller calling SalaryService is no cycle.
import { SalaryService } from './salary.service';
import {
  CreateAdvanceRequestDto,
  ApproveAdvanceRequestDto,
  RejectAdvanceRequestDto,
  PayAdvanceRequestDto,
  VerifyAdvanceRequestDto,
} from './dto/advance-salary-request.dto';

type AuthenticatedRequest = {
  user: { sub: string };
};

/**
 * AdvanceSalaryRequestController
 *
 * Exposes D-02 / D-08 advance salary request lifecycle endpoints:
 *   POST   /workspaces/:workspaceId/salary/advance-requests         (self — create)
 *   GET    /workspaces/:workspaceId/salary/advance-requests         (owner — list all)
 *   GET    /workspaces/:workspaceId/salary/advance-requests/mine    (self — own history)
 *   PATCH  /workspaces/:workspaceId/salary/advance-requests/:id/approve (owner)
 *   PATCH  /workspaces/:workspaceId/salary/advance-requests/:id/reject  (owner)
 *
 * Owner-only routes use @RequirePermissions(SALARY, EDIT, 'all') — matching the
 * existing advance-plans PATCH pattern in salary.controller.ts.
 * Self routes use @RequirePermissions(SALARY, REQUEST_ADVANCE, 'self') — a
 * dedicated self-service action (modelled on APPLY_LEAVE) so a worker can
 * request an advance without holding salary VIEW. The caller's own member id is
 * resolved server-side (createRequest + /mine), never trusted from the body.
 * All routes are gated on the 'advance_payments' subscription sub-feature
 * (VERIFIED canonical key from salary.controller.ts lines 873-929).
 */
@Controller('workspaces/:workspaceId/salary/advance-requests')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.SALARY, subFeature: 'advance_payments' })
export class AdvanceSalaryRequestController {
  constructor(
    private readonly advanceSalaryRequestService: AdvanceSalaryRequestService,
    private readonly salaryService: SalaryService,
    private readonly callerScope: CallerScopeService,
  ) {}

  /**
   * POST /workspaces/:workspaceId/salary/advance-requests
   * Employee submits an advance request for the current month (D-02 + D-08).
   * Self-scoped: the requesting user's teamMemberId is resolved from the JWT.
   */
  @Post()
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_ADVANCE, 'self')
  async createRequest(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateAdvanceRequestDto,
  ) {
    // SECURITY: bind the request to the caller's OWN team-member record (resolved
    // from the JWT), never a body-supplied id — closes the IDOR. Same resolution
    // the GET /mine route uses. Links: CallerScopeService.resolve.
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.advanceSalaryRequestService.createRequest(
      workspaceId,
      req.user.sub,
      ctx.teamMemberId,
      dto,
    );
  }

  /**
   * GET /workspaces/:workspaceId/salary/advance-requests/mine
   * Returns the caller's own advance request history.
   * Must be declared BEFORE the parameterised GET below so Nest's router does
   * not treat the literal "mine" segment as a requestId value.
   */
  @Get('mine')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_ADVANCE, 'self')
  async listMine(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.advanceSalaryRequestService.listForMember(workspaceId, ctx.teamMemberId);
  }

  /**
   * GET /workspaces/:workspaceId/salary/advance-requests/window
   * Self-scoped: tells the requesting worker whether the advance window is open
   * today, the current policy, and a human message for when it is closed.
   * Declared before any parameterised @Get(':requestId') route so the literal
   * "window" segment is not parsed as a requestId value (mirrors the /mine pattern).
   * Links: AdvanceSalaryRequestService.getWindowForMember, AdvanceRequestDrawer.tsx.
   */
  @Get('window')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_ADVANCE, 'self')
  getWindow(@Param('workspaceId') workspaceId: string) {
    return this.advanceSalaryRequestService.getWindowForMember(workspaceId);
  }

  /**
   * GET /workspaces/:workspaceId/salary/advance-requests/for-my-reports
   * Reporting-person review queue (Phase 3a): the caller's DIRECT REPORTS'
   * advance requests (members whose TeamMember.reportsTo == the caller). Gated
   * on salary.review_advance@self; the caller's own teamMemberId is resolved
   * server-side from the JWT (never the body), then the service filters by the
   * reportsTo edge. Declared BEFORE the parameterised owner GET / PATCH routes
   * so the literal "for-my-reports" segment is not parsed as a requestId
   * (mirrors the /mine + /window pattern). Visibility is a reportsTo-FILTERED
   * read, NOT a new RBAC scope.
   */
  @Get('for-my-reports')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REVIEW_ADVANCE, 'self')
  async listForMyReports(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.advanceSalaryRequestService.listForMyReports(workspaceId, ctx.teamMemberId);
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/advance-requests/:requestId/verify
   * Reporting-person VERIFY (Phase 3a) — ADVISORY. Stamps
   * verifiedBy/verifiedAt/verifyNote on a direct report's request; it NEVER
   * changes status nor blocks the owner approve/reject/pay path. Gated on
   * salary.review_advance@self; the reviewer's identity + own teamMemberId are
   * resolved server-side from the JWT. The service enforces separation of
   * duties (no self-verify) and the reportsTo membership check.
   * Declared BEFORE the owner :requestId/approve|reject|pay routes (same prefix,
   * different leaf) — Nest matches on the full path so ordering here is for
   * readability/grouping with the self-scoped review surface.
   */
  @Patch(':requestId/verify')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REVIEW_ADVANCE, 'self')
  async verify(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerifyAdvanceRequestDto,
  ) {
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.advanceSalaryRequestService.verifyRequest(
      workspaceId,
      requestId,
      req.user.sub,
      ctx.teamMemberId,
      dto.note,
    );
  }

  /**
   * GET /workspaces/:workspaceId/salary/advance-requests
   * Owner queue — lists all advance requests for the workspace with optional filters.
   */
  @Get()
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  listForWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
    @Query('teamMemberId') teamMemberId?: string,
  ) {
    return this.advanceSalaryRequestService.listForWorkspace(workspaceId, {
      status,
      teamMemberId,
    });
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/advance-requests/:requestId/approve
   * Owner approves a pending advance request (D-08 owner action).
   *
   * Phase 1b TWO-STEP: approve is now APPROVE-ONLY (pending -> approved + sets
   * approvedAmount). It records NO Payment and starts NO recovery — the money is
   * handed over later on the payout day via the `pay` route (payApprovedAdvance),
   * which captures method/proof/who-disbursed and CREATES the recovery plan there.
   * Recovery-term fields on ApproveAdvanceRequestDto are kept OPTIONAL for the
   * legacy combined path (approveAndDisburseAdvanceRequest, still callable for
   * back-compat) but are IGNORED here; we forward only amount + note.
   * Links: advance-salary-request.service.ts approve, salary.service.ts payApprovedAdvance.
   */
  @Patch(':requestId/approve')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  approve(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApproveAdvanceRequestDto,
  ) {
    return this.advanceSalaryRequestService.approve(workspaceId, requestId, req.user.sub, {
      approvedAmount: dto.approvedAmount,
      reviewNote: dto.reviewNote,
    });
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/advance-requests/:requestId/reject
   * Owner rejects a pending advance request.
   */
  @Patch(':requestId/reject')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  reject(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RejectAdvanceRequestDto,
  ) {
    return this.advanceSalaryRequestService.reject(workspaceId, requestId, req.user.sub, dto);
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/advance-requests/:requestId/pay
   * Owner pays out an APPROVED advance request: records the cash/bank Payment,
   * posts the finance ledger journal (Dr 1014 Salary Advance / Cr cash-bank), and
   * flips the request to 'paid' so the next month's salary auto-recovers it.
   * The amount comes from the approved request, never the client. Completes the
   * request→approve→PAY→ledger lifecycle (markPaid was previously never wired).
   */
  @Patch(':requestId/pay')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  pay(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: PayAdvanceRequestDto,
  ) {
    return this.salaryService.payApprovedAdvance(workspaceId, req.user.sub, requestId, dto);
  }
}
