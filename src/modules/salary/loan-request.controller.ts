import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../common/enums/modules.enum';
import { CallerScopeService } from '../../common/services/caller-scope.service';
import { LoanRequestService } from './loan-request.service';
import {
  CreateLoanRequestDto,
  ApproveLoanRequestDto,
  RejectLoanRequestDto,
} from './dto/loan-request.dto';

type AuthenticatedRequest = {
  user: { sub: string };
};

/**
 * LoanRequestController
 *
 * Employee-originated, self-service 0% installment-loan request lifecycle.
 * Mirrors AdvanceSalaryRequestController exactly:
 *   POST   /workspaces/:workspaceId/salary/loan-requests             (self — apply)
 *   GET    /workspaces/:workspaceId/salary/loan-requests/mine        (self — own history)
 *   GET    /workspaces/:workspaceId/salary/loan-requests/eligibility (self — pre-validate)
 *   GET    /workspaces/:workspaceId/salary/loan-requests/pending     (owner — queue)
 *   PATCH  /workspaces/:workspaceId/salary/loan-requests/:id/approve (owner — materialize 0% loan)
 *   PATCH  /workspaces/:workspaceId/salary/loan-requests/:id/reject  (owner)
 *
 * Self routes use @RequirePermissions(SALARY, REQUEST_LOAN, 'self') — a dedicated
 * self-service action (modelled on REQUEST_ADVANCE) so a worker can apply without
 * holding salary VIEW/EDIT. The caller's own member id is resolved server-side
 * (createRequest + /mine + /eligibility), never trusted from the body.
 *
 * Owner routes use @RequirePermissions(SALARY, EDIT, 'all') — matching the
 * advance-request and Employer Loan owner-route pattern.
 *
 * All routes are gated on the 'loan_management' subscription sub-feature (the
 * same canonical key the Employer Loan routes use in salary.controller.ts).
 */
@Controller('workspaces/:workspaceId/salary/loan-requests')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.SALARY, subFeature: 'loan_management' })
export class LoanRequestController {
  constructor(
    private readonly loanRequestService: LoanRequestService,
    private readonly callerScope: CallerScopeService,
  ) {}

  /**
   * POST /workspaces/:workspaceId/salary/loan-requests
   * Employee self-applies for a 0% installment loan. Self-scoped: the requesting
   * user's teamMemberId is resolved from the JWT, never a body-supplied id.
   */
  @Post()
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_LOAN, 'self')
  async createRequest(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateLoanRequestDto,
  ) {
    // SECURITY: bind the request to the caller's OWN team-member record (resolved
    // from the JWT), never a body id — closes the IDOR. Mirrors the advance
    // createRequest. Links: CallerScopeService.resolve.
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.loanRequestService.createRequest(workspaceId, req.user.sub, ctx.teamMemberId, dto);
  }

  /**
   * GET /workspaces/:workspaceId/salary/loan-requests/mine
   * The caller's own loan-request history. Declared BEFORE any parameterised
   * route so Nest does not treat "mine" as a requestId.
   */
  @Get('mine')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_LOAN, 'self')
  async listMine(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.loanRequestService.listMine(workspaceId, ctx.teamMemberId);
  }

  /**
   * GET /workspaces/:workspaceId/salary/loan-requests/eligibility
   * Self-scoped: tells the worker app whether the apply button should be enabled,
   * the active caps, and (when ineligible) the stable reason codes. Declared
   * before the parameterised owner routes so "eligibility" is not parsed as an id.
   */
  @Get('eligibility')
  @RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_LOAN, 'self')
  async getEligibility(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const ctx = await this.callerScope.resolve(workspaceId, req.user.sub);
    if (!ctx.teamMemberId) {
      throw new ForbiddenException('No team member record found for this user in the workspace.');
    }
    return this.loanRequestService.getEligibility(workspaceId, ctx.teamMemberId);
  }

  /**
   * GET /workspaces/:workspaceId/salary/loan-requests/pending
   * Owner queue — all pending requests in the workspace with member name/id.
   * Declared before the parameterised PATCH routes for readability (Nest matches
   * full paths, so ordering is not strictly required, but mirrors the advance
   * /mine + /window grouping convention).
   */
  @Get('pending')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  listPending(@Param('workspaceId') workspaceId: string) {
    return this.loanRequestService.listPending(workspaceId);
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/loan-requests/:requestId/approve
   * Owner approves a pending request — calls the existing LoanService.createLoan
   * to materialize the real interest-free EmployerLoan, then stamps the request.
   */
  @Patch(':requestId/approve')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  approve(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApproveLoanRequestDto,
  ) {
    return this.loanRequestService.approveRequest(workspaceId, requestId, req.user.sub, dto);
  }

  /**
   * PATCH /workspaces/:workspaceId/salary/loan-requests/:requestId/reject
   * Owner declines a pending request with a reason.
   */
  @Patch(':requestId/reject')
  @RequirePermissions(AppModule.SALARY, ModuleAction.EDIT, 'all')
  reject(
    @Param('workspaceId') workspaceId: string,
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RejectLoanRequestDto,
  ) {
    return this.loanRequestService.rejectRequest(workspaceId, requestId, req.user.sub, dto);
  }
}
