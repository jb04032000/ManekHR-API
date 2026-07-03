import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { LocalizationService } from './localization.service';
import {
  CreateLanguageDto,
  UpdateLanguageDto,
  UpsertTranslationDto,
  BulkImportDto,
  TranslationsIndexQueryDto,
} from './dto/localization.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsAdminGuard } from '../../common/guards/admin.guard';
import { Public } from '../../common/decorators/public.decorator';
import { LegacyUnclassified } from '../../common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller('localization')
@UseGuards(JwtAuthGuard, IsAdminGuard)
export class LocalizationController {
  constructor(private readonly localizationService: LocalizationService) {}

  // ---------------------------------------------------------------------------
  // Public routes
  // ---------------------------------------------------------------------------

  @Public()
  @Get('languages')
  getLanguages() {
    return this.localizationService.getLanguages();
  }

  @Public()
  @Get('version/:langCode')
  getVersion(@Param('langCode') langCode: string) {
    return this.localizationService.getVersion(langCode);
  }

  // ---------------------------------------------------------------------------
  // Admin routes â€” specific paths BEFORE catch-all /:langCode
  // ---------------------------------------------------------------------------

  @Get('admin/languages')
  getAllLanguages() {
    return this.localizationService.getAllLanguages();
  }

  @Get('admin/namespaces')
  getNamespaces() {
    return this.localizationService.getDistinctNamespaces();
  }

  @Get('admin/translations/index')
  getTranslationsIndex(@Query() query: TranslationsIndexQueryDto) {
    return this.localizationService.getTranslationsIndex({
      langCode: query.langCode,
      module: query.module,
      screen: query.screen,
      feature: query.feature,
    });
  }

  @Get('admin/:langCode/translations')
  getTranslations(
    @Param('langCode') langCode: string,
    @Query('namespace') namespace?: string,
    @Query('platform') platform?: string,
    @Query('screen') screen?: string,
    @Query('feature') feature?: string,
  ) {
    return this.localizationService.getTranslations(langCode, namespace, platform, screen, feature);
  }

  @Post('languages')
  createLanguage(@Body() dto: CreateLanguageDto, @Req() req: { user: { sub: string } }) {
    return this.localizationService.createLanguage(dto, req.user.sub);
  }

  @Patch('languages/:code')
  updateLanguage(
    @Param('code') code: string,
    @Body() dto: UpdateLanguageDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.localizationService.updateLanguage(code, dto, req.user.sub);
  }

  @Delete('languages/:code')
  softDeleteLanguage(@Param('code') code: string) {
    return this.localizationService.softDeleteLanguage(code);
  }

  @Delete('admin/languages/:code/permanent')
  hardDeleteLanguage(@Param('code') code: string) {
    return this.localizationService.hardDeleteLanguage(code);
  }

  @Post('import/:langCode')
  bulkImport(
    @Param('langCode') langCode: string,
    @Body() dto: BulkImportDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.localizationService.bulkImport(
      langCode,
      dto.translations,
      req.user.sub,
      dto.platform,
    );
  }

  @Get('export/:langCode')
  exportBundle(@Param('langCode') langCode: string) {
    return this.localizationService.exportBundle(langCode);
  }

  @Get('diff/:langCode')
  getTranslationDiff(@Param('langCode') langCode: string, @Query('platform') platform?: string) {
    return this.localizationService.getTranslationDiff(langCode, platform);
  }

  @Put(':langCode/:namespace/:key')
  upsertTranslation(
    @Param('langCode') langCode: string,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @Body() dto: UpsertTranslationDto,
    @Req() req: { user: { sub: string } },
  ) {
    return this.localizationService.upsertTranslation(
      langCode,
      namespace,
      key,
      dto.value,
      req.user.sub,
      dto.platforms,
      {
        description: dto.description,
        screen: dto.screen,
        feature: dto.feature,
        componentRef: dto.componentRef,
        tags: dto.tags,
      },
    );
  }

  @Delete(':langCode/:namespace/:key')
  deleteTranslation(
    @Param('langCode') langCode: string,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
  ) {
    return this.localizationService.deleteTranslation(langCode, namespace, key);
  }

  @Post('copy/:langCode')
  copyFromDefault(
    @Param('langCode') langCode: string,
    @Body('userId') userId: string,
    @Query('platform') platform?: string,
  ) {
    return this.localizationService.copyFromDefault(langCode, userId, platform);
  }

  // ---------------------------------------------------------------------------
  // Public catch-all bundle route â€” MUST be last to avoid swallowing admin paths
  // ---------------------------------------------------------------------------

  @Public()
  @Get(':langCode')
  getBundle(@Param('langCode') langCode: string, @Query('platform') platform?: string) {
    return this.localizationService.getBundle(langCode, platform);
  }
}
