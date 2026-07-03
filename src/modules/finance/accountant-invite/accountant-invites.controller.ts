import { Controller, Post, Get, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { AccountantInvitesService } from './accountant-invites.service';
import { CreateAccountantInviteDto } from './dto/create-accountant-invite.dto';

@ApiTags('Finance - Accountant Invite')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/accountant-invites')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'finance_accountant_invite' })
export class AccountantInvitesController {
  constructor(private readonly invitesService: AccountantInvitesService) {}

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  invite(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreateAccountantInviteDto,
  ) {
    return this.invitesService.invite(wsId, firmId, dto);
  }

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(@Param('workspaceId') wsId: string, @Param('firmId') firmId: string) {
    return this.invitesService.findAll(wsId, firmId);
  }

  @Delete(':inviteId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  revoke(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invitesService.revoke(wsId, firmId, inviteId);
  }
}

/**
 * Accept the invite from the email link. Authenticated on purpose (SEC-3): the
 * invite token must not grant access on its own, so the user has to be signed in
 * and - enforced in the service - their account email must match the invited
 * address.
 */
@ApiTags('Finance - Accountant Invite')
@Controller('finance')
@UseGuards(JwtAuthGuard)
export class AccountantAcceptController {
  constructor(private readonly invitesService: AccountantInvitesService) {}

  @Post('accept-invite')
  accept(@Query('token') token: string, @Req() req: { user?: { sub?: string } }) {
    return this.invitesService.accept(token, req.user?.sub ?? '');
  }
}
