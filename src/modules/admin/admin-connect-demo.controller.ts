import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';
import { AdminConnectDemoService } from './admin-connect-demo.service';
import { PostAsDemoDto } from './dto/admin-connect-demo.dto';

/**
 * Admin "Connect demo manager".
 *
 * Routes under `admin/connect/demo`, guarded class-wide by JwtAuthGuard +
 * IsAdminGuard (same convention as AdminConnectEntitlementsController), so every
 * method is admin-only. Lets an admin list the seeded Connect demo accounts,
 * remove them (one or all) once real users arrive, and post AS a demo account.
 * Only `isDemo` / demo-domain accounts are ever touched. Linked to:
 * admin-connect-demo.service.ts.
 *
 *   GET    /users          → list demo accounts (login + content counts)
 *   GET    /purge-preview  → dry-run report (rows-to-delete + stub/hard split,
 *                            NO mutation) so the admin sees the impact first
 *   POST   /clear          → remove ALL demo content (CLEAN hard-purged,
 *                            ENTANGLED anonymized to a stub — never wipes a real
 *                            user's shared history)
 *   DELETE /users/:id      → remove one demo account + its content (same split)
 *   POST   /users/:id/post → publish a text post as that demo account
 */
@LegacyUnclassified()
@Controller('admin/connect/demo')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class AdminConnectDemoController {
  constructor(private readonly service: AdminConnectDemoService) {}

  @Get('users')
  list() {
    return this.service.listUsers();
  }

  // Dry-run: report what `clear` WOULD delete (per-collection rows) and how many
  // demo accounts would be hard-deleted vs anonymized to a stub, WITHOUT
  // mutating anything. Lets the admin preview the safe-purge impact first.
  @Get('purge-preview')
  preview(@CurrentUser('sub') actorId: string) {
    return this.service.dryRun(actorId);
  }

  @Post('clear')
  clear(@CurrentUser('sub') actorId: string) {
    return this.service.clearAll(actorId);
  }

  @Delete('users/:id')
  remove(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.service.deleteUser(id, actorId);
  }

  @Post('users/:id/post')
  postAs(@Param('id') id: string, @Body() dto: PostAsDemoDto, @CurrentUser('sub') actorId: string) {
    return this.service.postAs(id, dto.body, actorId);
  }
}
