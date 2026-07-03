import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { MarketingDispatchService } from './services/marketing-dispatch.service';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Wave 8.2 — admin marketing campaigns + platform-pool top-up.
 *
 * Decoupled from customer reminder sends: the marketing pool is a separate
 * credit ledger that admin manually tops up (after paying MSG91/AiSensy).
 * Customer subscription credits are NEVER charged for marketing sends.
 */
@LegacyUnclassified()
@Controller('admin/communications/marketing')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class MarketingAdminController {
  constructor(private readonly marketing: MarketingDispatchService) {}

  @Get('pools')
  getPools() {
    return this.marketing.getBothPools();
  }

  @Post('topup')
  topUp(
    @Req() req: Request,
    @Body()
    body: {
      channel: 'sms' | 'whatsapp';
      credits: number;
      ref?: string;
      note?: string;
    },
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.marketing.topUpPool({
      channel: body.channel,
      credits: body.credits,
      adminId,
      ref: body.ref,
      note: body.note,
    });
  }

  @Get('ledger')
  ledger(@Query('channel') channel?: 'sms' | 'whatsapp', @Query('limit') limit?: string) {
    return this.marketing.listLedger(channel, limit ? parseInt(limit, 10) : undefined);
  }

  @Post('send-bulk')
  sendBulk(
    @Req() req: Request,
    @Body()
    body: {
      workspaceId: string;
      templateId: string;
      senderId?: string;
      recipients: string[];
      vars?: Record<string, string>;
      note?: string;
    },
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.marketing.sendBulkSms({
      workspaceId: body.workspaceId,
      templateId: body.templateId,
      senderId: body.senderId,
      recipients: body.recipients,
      vars: body.vars,
      adminId,
      note: body.note,
    });
  }
}
