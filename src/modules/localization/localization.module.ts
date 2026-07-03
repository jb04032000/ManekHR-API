import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LocalizationController } from './localization.controller';
import { LocalizationService } from './localization.service';
import { Language, LanguageSchema } from './schemas/language.schema';
import { Translation, TranslationSchema } from './schemas/translation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Language.name, schema: LanguageSchema },
      { name: Translation.name, schema: TranslationSchema },
    ]),
  ],
  controllers: [LocalizationController],
  providers: [LocalizationService],
  exports: [LocalizationService],
})
// No onModuleInit. Language seeding (LocalizationService.ensureLanguagesExist)
// runs via the ledgered migration runner (ADR-0001 Slice 5), unit
// `0035_localization_seed_languages`, not on boot. Do NOT re-add a boot hook here.
export class LocalizationModule {}
