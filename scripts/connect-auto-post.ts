/**
 * connect:autopost — keeps the Connect demo feed alive on its own.
 *
 * Each run publishes one (or `--count N`) fresh "market pulse" post from a
 * rotating demo workshop / trade account, with imagery, light engagement and
 * proper feed fan-out — so the feed keeps moving between full re-seeds.
 *
 * Content source, in priority order:
 *   1. scripts/connect-demo/autopost-inbox.json — a queue of ready posts. The
 *      scheduled task (which researches the live textile market) appends items
 *      here; the script consumes one per run. Format:
 *        [{ "body": "...", "hashtags": ["..."], "image": "work|product|poster|none",
 *           "authorType": "workshop_owner|trader|..." }]
 *   2. The curated MARKET_TOPICS rotation in content.ts (skips topics used in
 *      the last 10 days, tracked in .autopost-state.json) — so even with an
 *      empty queue it always has something good and on-brand to post.
 *
 * Safety: only ever posts as the @connect-demo.zari360.test accounts. If no
 * demo users exist it tells you to run `npm run seed:connect` first and exits.
 *
 *   Run:   npm run connect:autopost              (one post)
 *          npm run connect:autopost -- --count 2 (two posts)
 *          npm run connect:autopost -- --dry-run (preview, writes nothing)
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose, { Types } from 'mongoose';

import {
  loadEnv,
  connectMongo,
  getModels,
  DEMO_DOMAIN,
  type DemoModels,
} from './connect-demo/models';
import * as img from './connect-demo/images';
import {
  PERSONAS,
  COMPANY_PAGES,
  COMMENTS,
  MARKET_TOPICS,
  type PersonaType,
} from './connect-demo/content';
import { createPost, addEngagement } from './connect-demo/helpers';

const STATE_FILE = path.resolve(__dirname, 'connect-demo', '.autopost-state.json');
const INBOX_FILE = path.resolve(__dirname, 'connect-demo', 'autopost-inbox.json');
const REUSE_COOLDOWN_DAYS = 10;

interface AutopostState {
  recent: Array<{ id: string; at: string }>; // recently used topic ids
  runCount: number;
}
interface InboxItem {
  body: string;
  hashtags?: string[];
  tags?: string[];
  image?: 'work' | 'product' | 'poster' | 'none';
  authorType?: PersonaType;
}
interface ChosenContent {
  topicId: string;
  body: string;
  hashtags: string[];
  tags: string[];
  image: 'work' | 'product' | 'poster' | 'none';
  preferType?: PersonaType;
  source: 'inbox' | 'rotation';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function parseArgs(): { count: number; dryRun: boolean } {
  const argv = process.argv.slice(2);
  let count = 1;
  const ci = argv.indexOf('--count');
  if (ci !== -1 && argv[ci + 1]) count = Math.max(1, Math.min(5, parseInt(argv[ci + 1], 10) || 1));
  return { count, dryRun: argv.includes('--dry-run') };
}

/** Pick the next piece of content: drain the inbox first, then the rotation. */
function nextContent(state: AutopostState, inbox: InboxItem[]): ChosenContent {
  const fresh = inbox.shift(); // mutates the caller's array (consumed = removed)
  if (fresh && fresh.body?.trim()) {
    return {
      topicId: `inbox:${Date.now()}`,
      body: fresh.body.trim(),
      hashtags: fresh.hashtags ?? [],
      tags: fresh.tags ?? [],
      image: fresh.image ?? 'work',
      preferType: fresh.authorType,
      source: 'inbox',
    };
  }
  const cutoff = Date.now() - REUSE_COOLDOWN_DAYS * 86_400_000;
  const recent = new Set(
    state.recent.filter((r) => new Date(r.at).getTime() > cutoff).map((r) => r.id),
  );
  const pool = MARKET_TOPICS.filter((t) => !recent.has(t.id));
  const choices = pool.length > 0 ? pool : MARKET_TOPICS;
  const topic = choices[state.runCount % choices.length];
  return {
    topicId: topic.id,
    body: topic.body,
    hashtags: topic.hashtags,
    tags: topic.tags ?? [],
    image: topic.image,
    preferType: topic.preferType,
    source: 'rotation',
  };
}

async function loadDemoUsers(m: DemoModels) {
  const rows = await m.User.find({ email: { $regex: `${DEMO_DOMAIN.replace('.', '\\.')}$` } })
    .select('_id email name')
    .lean<Array<{ _id: Types.ObjectId; email: string; name: string }>>();
  const byKey = new Map<string, { id: Types.ObjectId; name: string }>();
  for (const r of rows) byKey.set(r.email.split('@')[0], { id: r._id, name: r.name });
  return byKey;
}

async function run(): Promise<void> {
  const { count, dryRun } = parseArgs();
  loadEnv();
  const masked = await connectMongo();
  console.log('[connect:autopost] Connected to', masked, dryRun ? '(dry-run)' : '');
  const m = getModels();

  const demoUsers = await loadDemoUsers(m);
  if (demoUsers.size === 0) {
    console.error('[connect:autopost] No demo users found. Run `npm run seed:connect` first.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const state = readJson<AutopostState>(STATE_FILE, { recent: [], runCount: 0 });
  const inbox = readJson<InboxItem[]>(INBOX_FILE, []);

  // Candidate authors = demo owners/traders/recruiters who can credibly post
  // market commentary, with their company page (if any) for nicer attribution.
  const businessPersonas = PERSONAS.filter(
    (p) => p.type === 'workshop_owner' || p.type === 'trader' || p.type === 'recruiter',
  ).filter((p) => demoUsers.has(p.key));

  const allDemoIds = Array.from(demoUsers.values()).map((u) => u.id);

  for (let n = 0; n < count; n += 1) {
    const content = nextContent(state, inbox);

    // Choose an author: prefer the requested type, else any business persona.
    const preferred = content.preferType
      ? businessPersonas.filter((p) => p.type === content.preferType)
      : businessPersonas;
    const candidates = preferred.length > 0 ? preferred : businessPersonas;
    const author = candidates[(state.runCount + n) % candidates.length];
    const authorUser = demoUsers.get(author.key);

    // Post AS the author's company page when they have one.
    const pageSeed = COMPANY_PAGES.find((c) => c.ownerKey === author.key);
    const pageDoc = pageSeed
      ? await m.CompanyPage.findOne({ slug: pageSeed.slug })
          .select('_id')
          .lean<{ _id: Types.ObjectId } | null>()
      : null;
    const companyPageId = pageDoc?._id ?? null;

    // Build media for the chosen image style.
    const seedStr = `autopost|${content.topicId}|${author.key}|${state.runCount + n}`;
    let kind: 'text' | 'photo' = 'text';
    let media: Array<Record<string, unknown>> = [];
    if (content.image === 'work') {
      kind = 'photo';
      media = [{ url: img.workPhoto(seedStr), type: 'image' }];
    } else if (content.image === 'product') {
      kind = 'photo';
      const cat = author.type === 'trader' ? 'finished-goods' : 'embroidery-zari';
      media = [{ url: img.productPhoto(cat, seedStr), type: 'image' }];
    } else if (content.image === 'poster') {
      kind = 'photo';
      media = [{ url: img.videoPoster(seedStr), type: 'image' }];
    }

    // Recipients = author + followers of the page (if posting as page) or user.
    let followerRows: Array<{ followerId: Types.ObjectId }> = [];
    if (companyPageId) {
      followerRows = await m.Follow.find({ followeeType: 'companyPage', followeeId: companyPageId })
        .select('followerId')
        .lean<Array<{ followerId: Types.ObjectId }>>();
    } else {
      followerRows = await m.Follow.find({ followeeType: 'user', followeeId: authorUser.id })
        .select('followerId')
        .lean<Array<{ followerId: Types.ObjectId }>>();
    }
    const recipients = followerRows.map((f) => f.followerId);

    const label = `${author.name}${pageSeed ? ` (${pageSeed.name})` : ''}`;
    if (dryRun) {
      console.log(
        `\n[dry-run] would post as ${label} [${content.source}/${content.topicId}] ${kind}`,
      );
      console.log(`  ${content.body}`);
      console.log(
        `  #${content.hashtags.join(' #')} · ${recipients.length} followers · image=${content.image}`,
      );
    } else {
      const pid = await createPost(
        m,
        {
          authorId: authorUser.id,
          companyPageId,
          kind,
          body: content.body,
          tags: content.tags,
          hashtags: content.hashtags,
          media,
          authorErpLinked: Boolean(pageSeed?.erpLinked),
          authorSkills: author.skills,
          authorDistrict: author.city,
          when: new Date(),
        },
        recipients,
      );
      // Light, believable engagement.
      const reactors = allDemoIds
        .filter((id) => String(id) !== String(authorUser.id))
        .slice(0, 2 + ((state.runCount + n) % 4));
      const comments =
        (state.runCount + n) % 2 === 0
          ? [
              {
                authorId: reactors[0] ?? authorUser.id,
                body: COMMENTS[(state.runCount + n) % COMMENTS.length],
              },
            ]
          : [];
      await addEngagement(m, pid, reactors, comments);
      console.log(
        `[connect:autopost] Posted as ${label}: "${content.body.slice(0, 60)}…" (${recipients.length} followers reached)`,
      );
    }

    // Record usage (rotation topics only) and advance.
    if (content.source === 'rotation') {
      state.recent.unshift({ id: content.topicId, at: new Date().toISOString() });
      state.recent = state.recent.slice(0, 40);
    }
    state.runCount += 1;
  }

  if (!dryRun) {
    writeJson(STATE_FILE, state);
    writeJson(INBOX_FILE, inbox); // persist the drained queue
  }

  await mongoose.disconnect();
  console.log('[connect:autopost] Done.');
}

run().catch((err) => {
  console.error('[connect:autopost] Error:', err);
  process.exit(1);
});
