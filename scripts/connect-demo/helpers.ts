/**
 * connect-demo/helpers.ts — post construction + feed fan-out shared by the
 * seed and the auto-poster, so both create posts that look identical to ones
 * the real app produces (media shapes, fan-out rows, denormalized counts).
 */
import { Types } from 'mongoose';
import type { DemoModels } from './models';
import * as img from './images';
import type { PostSeed } from './content';

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'demo'
  );
}

export function uniqIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const id of ids) {
    const k = String(id);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(id);
    }
  }
  return out;
}

export interface BuiltMedia {
  media: Array<Record<string, unknown>>;
  audio: Record<string, unknown> | null;
  mediaLayout: 'grid' | 'carousel';
}

/** Turn a PostSeed's media spec into real media/audio sub-documents. */
export function buildPostMedia(
  seed: Pick<PostSeed, 'kind' | 'media' | 'voice'>,
  seedStr: string,
): BuiltMedia {
  const out: BuiltMedia = { media: [], audio: null, mediaLayout: seed.media?.layout ?? 'grid' };
  if (seed.kind === 'photo' && seed.media) {
    out.media = Array.from({ length: Math.max(1, seed.media.count) }, (_, i) => ({
      url: img.workPhoto(`${seedStr}|${i}`, i === 0 ? seed.media?.label : undefined),
      type: 'image',
      caption: i === 0 ? (seed.media?.label ?? '') : '',
    }));
  } else if (seed.kind === 'video' && seed.media) {
    const poster = img.videoPoster(seedStr, seed.media.label);
    out.media = [
      {
        url: img.demoVideoUrl(poster),
        type: 'video',
        posterUrl: poster,
        durationSec: 32,
        caption: seed.media.label ?? '',
      },
    ];
  } else if (seed.kind === 'document' && seed.media) {
    out.media = [
      {
        url: img.documentThumb(seed.media.label ?? 'Document'),
        type: 'document',
        caption: seed.media.label ?? '',
      },
    ];
  } else if (seed.kind === 'voice' && seed.voice) {
    out.audio = {
      url: img.silentWavDataUri(),
      durationSec: seed.voice.durationSec,
      transcript: seed.voice.transcript ?? null,
      transcriptLang: 'hi',
    };
  }
  return out;
}

export interface CreatePostInput {
  authorId: Types.ObjectId;
  companyPageId?: Types.ObjectId | null;
  kind: 'text' | 'photo' | 'video' | 'document' | 'voice';
  body: string;
  tags?: string[];
  hashtags?: string[];
  media?: Array<Record<string, unknown>>;
  audio?: Record<string, unknown> | null;
  mediaLayout?: 'grid' | 'carousel';
  visibility?: 'public' | 'connections';
  authorErpLinked?: boolean;
  authorSkills?: string[];
  authorDistrict?: string;
  repostOf?: Types.ObjectId | null;
  /** Backdate the post (and its feed rows) to spread the feed over time. */
  when?: Date;
}

/**
 * Create a post and fan it out to each recipient's feed (one FeedEntry per
 * owner). Backdates createdAt to `when` so the feed shows a realistic spread.
 * Returns the created post id.
 */
export async function createPost(
  m: DemoModels,
  input: CreatePostInput,
  recipientIds: Types.ObjectId[],
): Promise<Types.ObjectId> {
  const post = await m.Post.create({
    authorId: input.authorId,
    companyPageId: input.companyPageId ?? null,
    kind: input.kind,
    body: input.body,
    media: input.media ?? [],
    audio: input.audio ?? null,
    mediaLayout: input.mediaLayout ?? 'grid',
    tags: input.tags ?? [],
    hashtags: input.hashtags ?? [],
    visibility: input.visibility ?? 'public',
    authorErpLinked: input.authorErpLinked ?? false,
    // This helper only ever creates seeded demo content (seed-connect + auto-post),
    // so stamp the denormalized demo flag the FE "Sample" badge + feed/search
    // down-rank read. Without it demo posts default to isDemo:false and render
    // with no badge. Keep in sync with feed.service create-path + post.schema.
    isDemo: true,
    authorSkills: input.authorSkills ?? [],
    authorDistrict: input.authorDistrict ?? '',
    repostOf: input.repostOf ?? null,
  });

  const when = input.when ?? (post as unknown as { createdAt?: Date }).createdAt ?? new Date();
  if (input.when) {
    // Force the auto-timestamp back to `when` so the demo feed isn't all "now".
    await m.Post.updateOne({ _id: post._id }, { $set: { createdAt: when } }, { timestamps: false });
  }

  const recipients = uniqIds([input.authorId, ...recipientIds]);
  if (recipients.length > 0) {
    await m.FeedEntry.insertMany(
      recipients.map((ownerId) => ({
        ownerId,
        postId: post._id,
        authorId: input.authorId,
        companyPageId: input.companyPageId ?? null,
        postedAt: when,
      })),
    );
  }
  return post._id as Types.ObjectId;
}

export interface CommentSpec {
  authorId: Types.ObjectId;
  body: string;
}

/** Attach likes + comments to a post and keep the denormalized counts in step. */
export async function addEngagement(
  m: DemoModels,
  postId: Types.ObjectId,
  reactorIds: Types.ObjectId[],
  comments: CommentSpec[],
): Promise<void> {
  const reactors = uniqIds(reactorIds);
  if (reactors.length > 0) {
    await m.Reaction.insertMany(reactors.map((userId) => ({ postId, userId, type: 'like' })));
  }
  for (const c of comments) {
    await m.Comment.create({ postId, authorId: c.authorId, body: c.body, parentId: null });
  }
  if (reactors.length > 0 || comments.length > 0) {
    await m.Post.updateOne(
      { _id: postId },
      { $inc: { reactionCount: reactors.length, commentCount: comments.length } },
    );
  }
}
