import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LegalPage, LegalPageSchema } from './schemas/legal-page.schema';
import { LegalPagesService } from './legal-pages.service';
import { LegalPagesAdminController } from './legal-pages.admin.controller';
import { LegalPagesPublicController } from './legal-pages.public.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * Admin-managed legal/policy pages (Terms + Privacy CMS).
 *   - AuditModule provides AuditService (admin writes logged under AppModule.LEGAL).
 *   - The seed migration (0047, src/migrations/seed-legal-pages.ts) registers its
 *     own LegalPage model in MigrationsModule, so this module only owns the runtime
 *     CRUD + public read.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: LegalPage.name, schema: LegalPageSchema }]),
    AuditModule,
  ],
  controllers: [LegalPagesAdminController, LegalPagesPublicController],
  providers: [LegalPagesService],
  exports: [LegalPagesService],
})
export class LegalPagesModule {}
