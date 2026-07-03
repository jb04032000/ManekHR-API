import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { Msg91AdminService } from './services/msg91-admin.service';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Wave 8 — admin-only ops endpoints for MSG91 wallet + cost reporting.
 * All routes require admin role (see `IsAdminGuard`).
 */
@LegacyUnclassified()
@Controller('admin/communications/msg91')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class Msg91AdminController {
  constructor(private readonly admin: Msg91AdminService) {}

  @Get('balance')
  getBalance() {
    return this.admin.getBalance();
  }

  @Post('topup')
  recordTopUp(
    @Req() req: Request,
    @Body()
    body: {
      amountPaise: number;
      providerReferenceId?: string;
      note?: string;
    },
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminUserId = user.sub ?? user._id ?? '';
    return this.admin.recordTopUp(adminUserId, body);
  }

  @Get('topups')
  listTopUps(@Query('limit') limit?: string) {
    return this.admin.listTopUps(limit ? parseInt(limit, 10) : undefined);
  }

  @Get('margin-report')
  marginReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('from / to must be ISO dates');
    }
    return this.admin.marginReport({
      from: fromDate,
      to: toDate,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('refund-queue')
  refundQueue() {
    return this.admin.refundQueue();
  }

  /**
   * Wave 8.1 — manual credit refund (admin-only). Last-resort path; no
   * auto-refund exists anywhere in the codebase. Audit trail written.
   */
  @Post('manual-refund')
  manualRefund(
    @Req() req: Request,
    @Body()
    body: {
      workspaceId: string;
      channel: 'sms' | 'whatsapp';
      n: number;
      reason: string;
    },
  ) {
    const user = req.user as { sub?: string; _id?: string };
    const adminId = user.sub ?? user._id ?? '';
    return this.admin.manualRefundCredit({
      workspaceId: body.workspaceId,
      channel: body.channel,
      n: body.n,
      reason: body.reason,
      adminId,
    });
  }
}
