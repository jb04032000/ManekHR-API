import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { ConnectProfile, ConnectProfileSchema } from '../profile/schemas/connect-profile.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { UserBlock, UserBlockSchema } from '../inbox/schemas/user-block.schema';
import { ConnectNetworkModule } from '../network/connect-network.module';
import { MentionService } from './mention.service';
import { MentionSuggestService } from './mention-suggest.service';
import { MentionController } from './mention.controller';

/**
 * ManekHR Connect - Mention (tagging) module.
 *
 * Owns MentionService, the "who can tag whom" resolver for feed @mentions.
 * Registers the 5 models the service reads (all read-only here - each is
 * owned/written by its home module): User + ConnectProfile (people),
 * CompanyPage + Storefront (pages), UserBlock (bidirectional block gate).
 * Imports ConnectNetworkModule to inject NetworkService (it re-exports the
 * service) for the connections-only reach gate. Exports MentionService so the
 * feed + comment modules can resolve tags on write.
 *
 * Token convention: registration uses the schema-class `.name` token (the repo
 * convention, e.g. ConnectNetworkModule), which yields the same string literals
 * the service injects via @InjectModel('User') etc. - they resolve to one token.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
      { name: CompanyPage.name, schema: CompanyPageSchema },
      { name: Storefront.name, schema: StorefrontSchema },
      { name: UserBlock.name, schema: UserBlockSchema },
    ]),
    // Re-exports NetworkService (the connections-only reach gate).
    ConnectNetworkModule,
  ],
  // MentionController backs the composer @-picker (GET /connect/mention/suggest).
  controllers: [MentionController],
  providers: [MentionService, MentionSuggestService],
  exports: [MentionService],
})
export class MentionModule {}
