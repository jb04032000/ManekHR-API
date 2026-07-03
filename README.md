<!-- generated-by: gsd-doc-writer -->

# zari360-backend

The Zari360 (Zari360) API server — a NestJS application backing the web dashboard
(`zari360-web`) and mobile app (`zari360-app`). Multi-tenant, workspace-scoped REST
API for workforce management: team, attendance, shifts, salary/payroll, billing, RBAC,
machines/production, and finance.

Part of the [Zari360 (Zari360) monorepo](../README.md).

## Tech Stack

| Layer            | Stack                                                            |
| ---------------- | ---------------------------------------------------------------- |
| Framework        | NestJS 11 (Express platform), TypeScript 5.7                     |
| Runtime          | Node.js >= 20, npm >= 10                                         |
| Database         | MongoDB via Mongoose 8                                           |
| Auth             | Passport JWT (access + refresh), Google OAuth 2.0                |
| Queues / Cache   | BullMQ + Redis (`ioredis`)                                       |
| Storage          | Local filesystem or Cloudflare R2 (`@aws-sdk/client-s3`)         |
| Mail             | Nodemailer + `@nestjs-modules/mailer` (Handlebars templates)     |
| Push             | Firebase Admin SDK                                               |
| Scheduling       | `@nestjs/schedule` (cron jobs)                                   |
| Events           | `@nestjs/event-emitter`                                          |
| Throttling       | `@nestjs/throttler`                                              |
| Docs             | `@nestjs/swagger` (OpenAPI 3)                                    |
| PDF / Excel      | jsPDF + jspdf-autotable, PDFKit, XLSX                            |
| Payments         | Razorpay                                                         |

## Quick Start

```bash
cd zari360-backend
npm install
cp .env.example .env   # then fill in required values
npm run start:dev      # NestJS watch mode on http://localhost:3000
```

Swagger UI is exposed at <http://localhost:3000/api/docs> once the server is up.

## Environment Variables

The repo ships an `.env.example` listing the supported variables. Critical ones:

| Variable                                  | Required | Notes                                                |
| ----------------------------------------- | -------- | ---------------------------------------------------- |
| `MONGODB_URI`                             | Yes      | Mongo connection string. Default `mongodb://localhost:27017/zari360` |
| `JWT_ACCESS_SECRET`                       | Yes      | Signs short-lived access tokens (default expiry 30d) |
| `JWT_REFRESH_SECRET`                      | Yes      | Signs refresh tokens (default expiry 180d)           |
| `SMTP_ENCRYPTION_KEY`                     | Yes      | Used by `common/utils/crypto-utils.ts` to encrypt per-workspace SMTP credentials at rest |
| `ADMIN_SETUP_SECRET`                      | Yes      | One-time bootstrap secret for the first admin user   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | Required for Google OAuth login                    |
| `STORAGE_PROVIDER` (`local` \| `r2`)      | Yes      | Switches uploads between local disk and Cloudflare R2 |
| `R2_*`                                    | If R2    | Account ID, bucket, keys, public URL                 |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | If push | Firebase Admin credentials for push notifications |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Yes | Platform-default mail transport |
| `WEB_APP_URL`                             | Yes      | Used for invite links and email CTAs                 |
| `PORTAL_TOKEN_SECRET`                     | Yes      | 32-byte secret signing customer-portal tokens        |
| `ATLAS_SEARCH_ENABLED`                    | Optional | `true` to enable MongoDB Atlas Search for team       |
| `SUREPASS_FILING_STUB`                    | Optional | Phase 17 GSTIN filing-status stub toggle             |

See [`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md) for the full reference and
[`./.env.example`](./.env.example) for a complete starter file.

## Modules (`src/modules/`)

| Module                  | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `auth`                  | JWT access/refresh strategies, Google OAuth, sessions, password reset |
| `users`                 | User accounts, profile, devices                              |
| `workspaces`            | Multi-tenant workspaces, branding, payroll settings, employee-code counters |
| `team`                  | Employee CRUD, bulk ops, soft delete/offboarding, documents, permissions |
| `rbac`                  | Dynamic role-based access control: roles, permissions, role matrix |
| `resource-scopes`       | Per-resource scoping (locations, machines) layered on RBAC   |
| `subscriptions`         | Plans, entitlements, add-ons, subscription lifecycle         |
| `add-ons`               | Subscription add-on catalog                                  |
| `attendance`            | Event-sourced attendance projection (check-in/out, leave, regularization) |
| `attendance-devices`    | Hardware device registry (e.g. ZKTeco)                       |
| `attendance-ingest`     | ADMS PUSH-protocol ingest (`/iclock` text/plain endpoint)    |
| `attendance-import`     | Bulk attendance imports                                      |
| `attendance-policies`   | Late-mark, half-day and overtime policy rules                |
| `attendance-statutory`  | Statutory leave/attendance compliance                        |
| `regularization`        | Attendance correction requests + approval flow               |
| `anomalies`             | Attendance anomaly detection                                 |
| `shifts`                | Shift definitions, assignment, overnight handling            |
| `holidays`              | Holiday calendar per workspace                               |
| `salary`                | Payroll generation, payslips, ledger, payments               |
| `bills`                 | Vendor / utility bills                                       |
| `finance`               | Sales, purchases, expenses, fixed assets, inventory, reminders, GST |
| `locations`             | Workspace locations (separate from `Workspace.location`)     |
| `machines`              | Machine registry, assignments, per-machine permissions       |
| `downtime`              | Production downtime logging + reasons                        |
| `production-logs`       | Piece-rate production logs feeding payroll                   |
| `maintenance`           | Machine maintenance schedules and history                    |
| `dashboard`             | Aggregated dashboard queries                                 |
| `statistics`            | Reporting and utilization analytics                          |
| `uploads`               | File uploads (local FS or Cloudflare R2)                     |
| `mail`                  | Email transport, templates, per-workspace SMTP, quotas       |
| `sms`                   | SMS delivery integration                                     |
| `notifications`         | Firebase push notifications                                  |
| `localization`          | i18n translation registry + admin tooling                    |
| `audit`                 | Audit log events                                             |
| `sessions`              | Authenticated session management                             |
| `settings`              | Workspace-level settings                                     |
| `admin`                 | Platform admin (users, plans, subscriptions)                 |

## Folder Structure

```
src/
  main.ts              # Bootstrap: ValidationPipe, ResponseInterceptor, Swagger, CORS
  app.module.ts        # Root module wiring config + all feature modules
  app.controller.ts
  app.service.ts
  config/              # app, database, jwt, google-oauth, storage configs
  common/              # Cross-cutting: guards, interceptors, filters, pipes,
                       # decorators, dto, enums, helpers, types, utils, middleware
  modules/             # Feature modules (see table above)
  i18n/                # Built-in translation seed data
  migrations/          # One-off data migration scripts
  seed.ts              # `npm run seed` — initial data
  seed-translations.ts # `npm run seed:translations`
```

## Response Envelope

Every successful response is wrapped by the global `ResponseInterceptor`
(`src/common/interceptors/response.interceptor.ts`), registered in `src/main.ts`:

```json
{ "success": true, "data": <payload> }
```

Handlers that already return an object containing both `success` and `data`
(e.g. paginated results with `meta`) are passed through untouched. Errors flow through
`HttpExceptionFilter` (`src/common/filters/http-exception.filter.ts`) for consistent
shape. Web and mobile clients automatically unwrap `.data` (see root `CLAUDE.md`).

## Build & Run

```bash
npm run build         # nest build → dist/
npm run start:prod    # node dist/main (reads .env, listens on PORT or 3000)
npm run lint          # ESLint --fix
npm run format        # Prettier
npm test              # Jest unit tests (*.spec.ts under src/)
npm run test:vitest   # Vitest suites (e.g. attendance projection)
npm run test:e2e      # Jest e2e (test/jest-e2e.json)
npm run seed          # Seed initial data
npm run seed:translations  # Seed i18n translations
npm run validate:i18n      # Validate translation completeness
```

## API Docs

Interactive Swagger UI: <http://localhost:3000/api/docs>
The OpenAPI document is built in `src/main.ts` via `DocumentBuilder` (`Zari360 API` v1.0).

## See Also

- Root monorepo overview: [`../README.md`](../README.md) <!-- VERIFY: monorepo root README path -->
- Architecture: [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- Configuration reference: [`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md)
- Per-feature docs: [`../docs/features/`](../docs/features/) <!-- VERIFY: features doc directory -->
- Web client: [`../zari360-web/`](../zari360-web/)
- Mobile client: [`../zari360-app/`](../zari360-app/)
