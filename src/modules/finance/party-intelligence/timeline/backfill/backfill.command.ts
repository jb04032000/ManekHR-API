/**
 * Phase 17 / FIN-16-03 — Backfill admin endpoint (CLI substitute).
 *
 * `nest-commander` is not a dependency in this codebase, so the backfill is
 * exposed as an admin-guarded HTTP endpoint instead of a CLI command. Same
 * functional contract — owners trigger the one-time materialization for a
 * workspace; idempotent re-runs.
 *
 *   POST /api/admin/finance/party-timeline/backfill
 *   Body: { wsId: string; dryRun?: boolean }
 *
 * Guarded by JwtAuthGuard + IsAdminGuard (matches AdminController pattern).
 */
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../../../../common/guards/admin.guard';
import {
  PartyTimelineBackfillService,
  BackfillResult,
} from './backfill.service';

@Controller('admin/finance/party-timeline')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class PartyTimelineBackfillController {
  constructor(
    private readonly service: PartyTimelineBackfillService,
  ) {}

  @Post('backfill')
  async run(
    @Body() body: { wsId: string; dryRun?: boolean },
  ): Promise<BackfillResult> {
    return this.service.run({ wsId: body.wsId, dryRun: body.dryRun });
  }
}
