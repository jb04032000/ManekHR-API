import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard, RequirePermissions } from '../../../common/guards/roles.guard';
import { SubscriptionGuard, RequireSubscription } from '../../../common/guards/subscription.guard';
import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { PartiesService } from './parties.service';
import { CreatePartyDto } from './dto/create-party.dto';
import { UpdateContactSuppressGreetingsDto } from './dto/update-contact-suppress-greetings.dto';

@ApiTags('Finance - Parties')
@Controller('workspaces/:workspaceId/finance/firms/:firmId/parties')
@RequireSubscription({ module: AppModule.FINANCE, subFeature: 'parties_master' })
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class PartiesController {
  constructor(private readonly partiesService: PartiesService) {}

  @Get()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findAll(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Query() query: any,
  ) {
    return this.partiesService.findAll(wsId, firmId, query);
  }

  @Post()
  @RequirePermissions(AppModule.FINANCE, ModuleAction.CREATE)
  create(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Body() dto: CreatePartyDto,
  ) {
    return this.partiesService.create(wsId, firmId, dto);
  }

  @Get(':partyId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.VIEW)
  findOne(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
  ) {
    return this.partiesService.findOne(wsId, firmId, partyId);
  }

  @Patch(':partyId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  update(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
    @Body() dto: Partial<CreatePartyDto>,
  ) {
    return this.partiesService.update(wsId, firmId, partyId, dto);
  }

  @Delete(':partyId')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.DELETE)
  remove(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
  ) {
    return this.partiesService.remove(wsId, firmId, partyId);
  }

  /**
   * Phase 17 / FIN-16-05 D-32 (B6 fix) — toggle per-contact suppressGreetings.
   *
   * Consumed by Plan 17-08 web Suppress button on the Upcoming Greetings table.
   *
   * Plan 17-06 specified the simpler path
   *   `/workspaces/:wsId/parties/:partyId/contacts/:contactId/suppress-greetings`
   * but this codebase mounts parties under firm-scoped
   *   `api/workspaces/:workspaceId/finance/firms/:firmId/parties/...`
   * (Rule 3 — actual path differs from plan). The web client at Plan 17-08
   * already has firmId in scope (party detail flows are firm-scoped).
   *
   * RBAC: existing AppModule.FINANCE + ModuleAction.EDIT (parties write
   * permission) — no new RBAC needed per plan acceptance criteria.
   */
  @Patch(':partyId/contacts/:contactId/suppress-greetings')
  @RequirePermissions(AppModule.FINANCE, ModuleAction.EDIT)
  updateContactSuppressGreetings(
    @Param('workspaceId') wsId: string,
    @Param('firmId') firmId: string,
    @Param('partyId') partyId: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactSuppressGreetingsDto,
  ) {
    return this.partiesService.updateContactSuppressGreetings(
      wsId,
      firmId,
      partyId,
      contactId,
      dto.suppressGreetings,
    );
  }
}
