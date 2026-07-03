import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { Msg91PricingAdminService } from './services/msg91-pricing-admin.service';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Wave 8.2 — admin CRUD over the versioned MSG91/AiSensy cost table.
 * Versioned: edits insert a new row + auto-close prior open row. History
 * preserved for monthly invoice reconciliation.
 */
@LegacyUnclassified()
@Controller('admin/communications/pricing')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class Msg91PricingAdminController {
  constructor(private readonly pricing: Msg91PricingAdminService) {}

  @Get()
  list(@Query('history') history?: string) {
    return this.pricing.list({ includeHistory: history === 'true' });
  }

  @Post()
  add(
    @Body()
    body: {
      provider: 'msg91' | 'aisensy';
      channel: 'sms' | 'whatsapp';
      encoding: 'GSM7' | 'UCS2' | 'N/A';
      segments: number;
      costPaise: number;
      country?: string;
      note?: string;
    },
  ) {
    return this.pricing.addRow(body);
  }

  @Post(':id/close')
  close(@Param('id') id: string) {
    return this.pricing.closeRow(id);
  }
}
