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
import { LegalPagesService } from './legal-pages.service';
import { CreateLegalPageDto, UpdateLegalPageDto } from './dto/legal-page.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

/**
 * Admin CRUD + publish for the legal-pages CMS. Mirrors the admin Tiers stack:
 * `@LegacyUnclassified()` satisfies the global RolesGuard marker requirement and
 * `IsAdminGuard` does the real admin gating (JwtAuthGuard is global; re-listed to
 * keep the controller self-describing like AdminController/LocalizationController).
 *
 * Cross-module links: LegalPagesService (writes audited under AppModule.LEGAL);
 * public read lives in legal-pages.public.controller (@Public GET /legal-pages/:slug).
 */
@LegacyUnclassified()
@Controller('admin/legal-pages')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class LegalPagesAdminController {
  constructor(private readonly legalPagesService: LegalPagesService) {}

  @Get()
  list(@Query('product') product?: string, @Query('kind') kind?: string) {
    return this.legalPagesService.list({ product, kind });
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.legalPagesService.getById(id);
  }

  @Post()
  create(@Body() dto: CreateLegalPageDto, @CurrentUser('sub') actorId: string) {
    return this.legalPagesService.create(dto, actorId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLegalPageDto,
    @CurrentUser('sub') actorId: string,
  ) {
    return this.legalPagesService.update(id, dto, actorId);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.legalPagesService.publish(id, actorId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.legalPagesService.remove(id, actorId);
  }
}
