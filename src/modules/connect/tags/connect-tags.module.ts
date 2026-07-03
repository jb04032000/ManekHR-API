import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectTag, ConnectTagSchema } from './schemas/connect-tag.schema';
import { Post, PostSchema } from '../feed/schemas/post.schema';
import { TagService } from './tag.service';
import { TrendingTagsService } from './trending-tags.service';
import { TagController } from './tag.controller';

/**
 * ManekHR Connect — Tags module (S1.3).
 *
 * Owns the `ConnectTag` taxonomy + `TagService` (hashtag normalization, usage
 * recording, autocomplete) and the `/connect/tags/search` endpoint. Exports
 * `TagService` so the feed routes its hashtag parse path through it.
 * `PostHogService` is `@Global`, so `TagService` injects it without an import.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ConnectTag.name, schema: ConnectTagSchema },
      // Read-only: TrendingTagsService aggregates posts for tag velocity.
      { name: Post.name, schema: PostSchema },
    ]),
  ],
  controllers: [TagController],
  providers: [TagService, TrendingTagsService],
  exports: [TagService],
})
export class ConnectTagsModule {}
