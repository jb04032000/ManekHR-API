# Backend Setup Guide

End-to-end setup instructions for `zari360-backend`. Covers fresh install, required services (MongoDB, Redis, Firebase), env vars, and common pitfalls.

---

## 1. Prerequisites

| Tool             | Version | Notes                                            |
| ---------------- | ------- | ------------------------------------------------ |
| Node.js          | 22.x    | `node -v` to check                               |
| npm              | ≥ 10    | bundled with Node                                |
| MongoDB          | ≥ 6     | local or Atlas                                   |
| Redis            | **≥ 5** | BullMQ requires it; older versions silently fail |
| Docker Desktop   | latest  | optional, easiest way to run Redis on Windows    |
| Firebase project | —       | needed for push notifications                    |

---

## 2. Install dependencies

```bash
cd zari360-backend
npm install
```

If you see `Cannot find module 'X'` on startup, run:

```bash
npm install dayjs date-fns multer axios @nestjs-modules/mailer
```

(These were missing from `package.json` historically — fixed now, but install if you hit it.)

---

## 3. Environment variables

Create `zari360-backend/.env`:

```bash
# --- Core ---
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/zari360

# --- JWT ---
JWT_SECRET=<random-32-char-string>
JWT_REFRESH_SECRET=<random-32-char-string>
JWT_EXPIRES_IN=30d
JWT_REFRESH_EXPIRES_IN=180d

# --- Redis (BullMQ queues) ---
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=  # only if your Redis requires auth

# --- Firebase (push notifications) ---
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"

# --- SMTP encryption (for custom workspace SMTP) ---
SMTP_ENCRYPTION_KEY=<random-32-char-string>

# --- Mail (default sender) ---
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-app-password
MAIL_FROM=noreply@yourdomain.com

# --- Storage --- (see .env.example for the authoritative R2_* key names)
STORAGE_PROVIDER=local        # or 'r2'
# R2_ACCOUNT_ID=
# R2_ACCESS_KEY_ID=
# R2_SECRET_ACCESS_KEY=
# R2_BUCKET_NAME=             # public bucket (feed, products, profiles, ERP docs)
# R2_PRIVATE_BUCKET_NAME=     # private bucket (chat + job-application files); signed-URL only
# R2_PUBLIC_URL=
```

### Firebase private key (gotcha)

The `FIREBASE_PRIVATE_KEY` from your service-account JSON contains literal `\n` sequences. Wrap the **entire value in double quotes**, keep `\n` as-is. The code handles `replace(/\\n/g, '\n')` internally.

If you see `[PushAdapter] Firebase init failed: Invalid PEM formatted message`, the escaping is wrong.

To get the key:

1. Firebase Console → Project Settings → Service Accounts
2. Click _Generate new private key_ → downloads JSON
3. Copy `project_id`, `client_email`, `private_key` into `.env`

---

## 4. MongoDB

### Local (Windows)

Install MongoDB Community → runs as Windows service on `27017`.

```bash
mongosh
> use zari360
> db.runCommand({ ping: 1 })
```

### Atlas (cloud)

Set `MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/zari360`.

---

## 5. Redis (CRITICAL)

BullMQ requires **Redis ≥ 5.0**. If you see `Error: Redis version needs to be greater or equal than 5.0.0`, follow this section.

### Option A — Docker (recommended for dev)

```bash
docker volume create zari360-redis-data

docker run -d --name zari360-redis \
  -p 6379:6379 \
  -v zari360-redis-data:/data \
  --restart unless-stopped \
  redis:7-alpine \
  redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
```

Flags explained:

- `-v zari360-redis-data:/data` — named volume so data survives container rebuild.
- `--appendonly yes` — AOF persistence (durable writes, replays on restart).
- `--maxmemory 512mb` — cap so Redis can't OOM the host.
- `--maxmemory-policy allkeys-lru` — evict least-recently-used keys when full.
- `--restart unless-stopped` — auto-restart with Docker.

Verify:

```bash
redis-cli ping                           # PONG
redis-cli INFO server | grep version     # redis_version:7.x
```

### Option B — Memurai (Windows-native, no Docker)

1. Download Memurai Developer (free): https://www.memurai.com/get-memurai
2. Install → runs as Windows service on `6379`.
3. Stop any old Redis service first: `services.msc` → find Redis → Stop, set Startup Type to _Manual_.

### Option C — WSL2 (Linux on Windows)

```bash
wsl --install
# inside WSL:
sudo apt update && sudo apt install redis-server
sudo service redis-server start
redis-cli ping
```

### Production

- **Self-hosted (Ubuntu):** `sudo apt install redis-server`, set `requirepass` in `/etc/redis/redis.conf`, bind to `127.0.0.1`.
- **Cloud:** Upstash (serverless, free tier), Redis Cloud (30MB free), AWS ElastiCache, GCP Memorystore, Azure Cache. Set `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` env vars.
- Always use a strong password and bind to localhost or VPC-private IP.

### Production hardening checklist

In `/etc/redis/redis.conf` (or via cloud provider settings):

```conf
# Security
requirepass <strong-random-password>
bind 127.0.0.1                 # or your private VPC IP
protected-mode yes

# Memory bounds
maxmemory 512mb                # tune to your tier
maxmemory-policy allkeys-lru   # evict LRU keys when full

# Persistence (pick AOF for durability)
appendonly yes
appendfsync everysec

# Lockdown dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command CONFIG ""       # only if you don't need runtime CONFIG
rename-command DEBUG ""
```

After editing: `sudo systemctl restart redis-server`.

### Application-level Redis architecture

The backend uses a **central Redis client** (`src/common/redis/redis.module.ts`):

- Single `ioredis` connection shared via `@Inject(REDIS_CLIENT)` — no per-service connection sprawl.
- `RedisModule` is `@Global()` so any service can inject without explicit imports.
- Auto-prefixes keys with `zari360:<NODE_ENV>:` to isolate envs sharing one Redis instance.
- Listens to `connect`, `ready`, `error`, `reconnecting`, `end` events with structured logging.
- Implements `OnApplicationShutdown` → calls `client.quit()` cleanly when the app shuts down.

**BullMQ defaults** (in `app.module.ts`):

```ts
defaultJobOptions: {
  removeOnComplete: { age: 24 * 3600, count: 1000 },   // prevent unbounded growth
  removeOnFail:     { age: 7 * 24 * 3600, count: 5000 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
}
prefix: `cr-bull:${NODE_ENV}`
```

Adding a new service that needs Redis:

```ts
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/common/redis/redis.module';

@Injectable()
export class MyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}
}
```

DO NOT do `new Redis({...})` in a service — connections won't be managed and tests will fail.

---

## 6. Asset copy (i18n + mail templates)

`PrintI18nService` reads from `dist/i18n/` and the mailer reads from
`dist/modules/mail/templates/`. The SWC builder used by `nest-cli` does **not**
honour the `nest-cli.json` `assets` array — verified: a clean `nest build`
leaves `dist/i18n` and `dist/modules/mail/templates` empty. So this project
copies those two trees with an explicit script. The `assets` array was therefore
removed from `nest-cli.json` (dead config under the swc builder).

The finance print **fonts** (`src/modules/finance/sales/print/fonts/*.js`,
base64 TTFs) are **not** in the copy script: the swc builder compiles `.js`
sources, so it already emits them to `dist/.../fonts/`. (Copying them too was a
redundant double-write and was removed.)

Configured in `package.json`:

```json
"copy:assets": "node -e \"...copies src/i18n + src/modules/mail/templates...\"",
"build": "nest build && npm run copy:assets",
"start:dev": "npm run copy:assets && nest start --watch"
```

`copy:assets` stays in both `build` and `start:dev` — it is load-bearing for
i18n + mail templates, not redundant. `nest-cli.json` has `"deleteOutDir": false`
so assets persist across rebuilds.

If you ever see `ENOENT: dist/i18n/<lang>/print.json`:

```bash
npm run copy:assets
```

---

## 7. Run

```bash
# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

Backend listens on `http://localhost:3000`. Swagger docs at `http://localhost:3000/api/docs`.

---

## 8. Verification

After `npm run start:dev`, you should see — in order:

```
[NestFactory] Starting Nest application...
[InstanceLoader] AppModule dependencies initialized
... (many module init logs) ...
[SubscriptionsService] Tier cache refreshed
[PushAdapter] Firebase admin initialized       ← Firebase OK
[NestApplication] Nest application successfully started
```

You should **NOT** see:

| Error                                                                 | Means                 | Fix                                                      |
| --------------------------------------------------------------------- | --------------------- | -------------------------------------------------------- |
| `Redis version needs to be greater or equal than 5.0.0`               | Old Redis             | Upgrade per §5                                           |
| `Firebase init failed: Invalid PEM`                                   | Bad private key       | Fix `FIREBASE_PRIVATE_KEY` quoting                       |
| `ENOENT: dist/i18n/...`                                               | Assets not copied     | `npm run copy:assets`                                    |
| `UnknownDependenciesException ... SubscriptionGuard ... in BomModule` | Missing global module | Verify `SubscriptionsModule` is `@Global()`              |
| `Cannot access 'X' before initialization`                             | Module circular dep   | Wrap with `forwardRef(() => X)`                          |
| `Cannot find module '@nestjs-modules/mailer/dist/adapters/...'`       | v2 export change      | Use `@nestjs-modules/mailer/adapters/handlebars.adapter` |

---

## 9. Module architecture notes

### Circular dependencies

Recent finance modules introduced bidirectional service imports. The fix pattern:

```ts
// In moduleA.module.ts
imports: [
  forwardRef(() => ModuleB),  // instead of plain ModuleB,
]

// In serviceA.ts
constructor(
  @Inject(forwardRef(() => ServiceB))
  private readonly serviceB: any,         // type as `any` to avoid SWC TDZ
) {}
```

`SubscriptionsModule` and `WorkspacesModule` are `@Global()` so feature modules don't need to import them explicitly for guard injection.

### Path conventions

Files at `src/modules/finance/<group>/file.ts` (depth 4) reach common with `../../../common/...`.
Files at `src/modules/finance/<group>/<sub>/file.ts` (depth 5) reach common with `../../../../common/...`.
Files at depth 5 reach a finance sibling with `../../<sibling>/...` (NOT `../../../<sibling>/`).

---

## 10. Production deploy checklist

- [ ] `MONGODB_URI` points to production MongoDB (Atlas or self-hosted with auth)
- [ ] `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` set; Redis ≥ 5; bound to private network
- [ ] Firebase env vars set; `FIREBASE_PRIVATE_KEY` properly quoted
- [ ] `JWT_SECRET`, `JWT_REFRESH_SECRET` are long random strings (NOT defaults)
- [ ] `SMTP_ENCRYPTION_KEY` set (used to encrypt workspace SMTP creds at rest)
- [ ] `STORAGE_PROVIDER=cloudflare-r2` + R2 creds (or S3) — local storage is dev-only
- [ ] `NODE_ENV=production`
- [ ] HTTPS terminator (nginx/Caddy/ALB) in front; backend on internal port
- [ ] `npm run build && npm run start:prod`; run under PM2 / systemd / Docker for restart-on-crash
- [ ] Mongo + Redis backups configured
- [ ] Logs shipped to a central store (CloudWatch, Loki, etc.)

---

## 11. Common dev workflows

```bash
# Reset dev database
mongosh
> use zari360
> db.dropDatabase()

# Re-seed
npm run seed
npm run seed:translations

# Validate i18n catalogs
npm run validate:i18n

# Run unit tests
npm run test:vitest
```
