# Workspaces Module - Surface Map

> Generated 2026-05-07. Source: `src/modules/workspaces/`

## File Inventory

| File                                  | Purpose                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `workspaces.module.ts`                | `@Global()` NestJS module. Registers schemas, providers, exports.         |
| `workspaces.controller.ts`            | REST controller (`/workspaces`). 20 route handlers.                       |
| `workspaces.service.ts`               | Core business logic. 18 public + 2 private methods.                       |
| `workspace-counter.service.ts`        | Atomic sequence counters (employees, machines, locations, etc.).          |
| `invite-notification.dispatcher.ts`   | Fan-out service: in-app, email, SMS, push for invites.                    |
| `schemas/workspace.schema.ts`         | Mongoose `Workspace` schema.                                              |
| `schemas/workspace-member.schema.ts`  | Mongoose `WorkspaceMember` schema (join table).                           |
| `schemas/workspace-counter.schema.ts` | Mongoose `WorkspaceCounter` schema (sequence counters).                   |
| `dto/workspace.dto.ts`                | DTOs: Create, Update, Invite, ChangeRole, Branding, ExportPrefs, EmpCode. |
| `dto/kiosk.dto.ts`                    | DTO: `UpdateKioskSettingsDto`.                                            |
| `types/workspace.types.ts`            | TypeScript interfaces: `WorkspaceWithRole`, `WorkspaceMemberResult`.      |

---

## 1. Routes (WorkspacesController)

Base path: `/workspaces`
Class-level guards: `JwtAuthGuard`, `SubscriptionGuard`

| #   | Method   | Path                                           | Handler                      | Guards / Decorators                                  | DTO / Params              | Returns                                      |
| --- | -------- | ---------------------------------------------- | ---------------------------- | ---------------------------------------------------- | ------------------------- | -------------------------------------------- |
| 1   | `GET`    | `/workspaces`                                  | `findAll`                    | (class-level)                                        | `req.user.sub`            | `{ owned, member }`                          |
| 2   | `POST`   | `/workspaces`                                  | `create`                     | (class-level)                                        | `CreateWorkspaceDto`      | `Workspace`                                  |
| 3   | `GET`    | `/workspaces/:id`                              | `findOne`                    | (class-level)                                        | `:id`                     | `{ workspace, members }`                     |
| 4   | `PATCH`  | `/workspaces/:id`                              | `update`                     | `@RequireSubscription(SETTINGS, edit_settings)`      | `UpdateWorkspaceDto`      | `Workspace`                                  |
| 5   | `DELETE` | `/workspaces/:id`                              | `remove`                     | (class-level)                                        | `:id`, `req.user.sub`     | `void`                                       |
| 6   | `GET`    | `/workspaces/:id/members`                      | `getMembers`                 | (class-level)                                        | `:id`                     | `member[]`                                   |
| 7   | `POST`   | `/workspaces/:id/invite`                       | `inviteMember`               | (class-level)                                        | `InviteMemberDto`         | `{ message }`                                |
| 8   | `DELETE` | `/workspaces/:id/members/:memberId`            | `removeMember`               | (class-level)                                        | `:id`, `:memberId`        | `void`                                       |
| 9   | `PATCH`  | `/workspaces/:id/members/:memberId/role`       | `changeMemberRole`           | (class-level)                                        | `ChangeMemberRoleDto`     | `WorkspaceMember`                            |
| 10  | `GET`    | `/workspaces/:id/invitations`                  | `getPendingInvitations`      | (class-level)                                        | `:id`                     | `invitation[]`                               |
| 11  | `POST`   | `/workspaces/:id/invitations/:memberId/resend` | `resendInvite`               | (class-level)                                        | `:id`, `:memberId`        | `{ message }`                                |
| 12  | `DELETE` | `/workspaces/:id/invitations/:memberId`        | `cancelInvite`               | (class-level)                                        | `:id`, `:memberId`        | `{ message }`                                |
| 13  | `GET`    | `/workspaces/join/:token`                      | `getInviteDetails`           | **`@Public()`** (no auth)                            | `:token`                  | invite preview                               |
| 14  | `DELETE` | `/workspaces/join/:token`                      | `declineInvite`              | **`@Public()`** (no auth)                            | `:token`                  | `{ message }`                                |
| 15  | `POST`   | `/workspaces/join/:token`                      | `joinWithToken`              | (class-level)                                        | `:token`, `req.user.sub`  | `{ workspace, member }`                      |
| 16  | `GET`    | `/workspaces/:id/branding`                     | `getBranding`                | (class-level)                                        | `:id`                     | `{ branding, exportPreferences }`            |
| 17  | `PATCH`  | `/workspaces/:id/branding`                     | `updateBranding`             | `@RequireSubscription(SETTINGS, workspace_branding)` | `BrandingDto`             | `branding`                                   |
| 18  | `PATCH`  | `/workspaces/:id/export-preferences`           | `updateExportPreferences`    | `@RequireSubscription(SETTINGS, workspace_branding)` | `ExportPreferencesDto`    | `exportPreferences`                          |
| 19  | `GET`    | `/workspaces/:id/employee-code-settings`       | `getEmployeeCodeSettings`    | (class-level)                                        | `:id`                     | `{ settings, currentCounter, nextSequence }` |
| 20  | `PATCH`  | `/workspaces/:id/employee-code-settings`       | `updateEmployeeCodeSettings` | `@RequireSubscription(SETTINGS, edit_settings)`      | `EmployeeCodeSettingsDto` | `{ settings, currentCounter, nextSequence }` |
| 21  | `PATCH`  | `/workspaces/:id/kiosk`                        | `updateKiosk`                | `@RequireSubscription(SETTINGS, edit_settings)`      | `UpdateKioskSettingsDto`  | `{ enabled, allowedIpRanges, secret? }`      |
| 22  | `POST`   | `/workspaces/:id/kiosk/regenerate-token`       | `regenerateToken`            | `@RequireSubscription(SETTINGS, edit_settings)`      | `:id`                     | `{ secret, rotatedAt }`                      |

---

## 2. Services

### WorkspacesService

| #   | Method                       | Visibility | Signature                                                                        | Description                                                                          |
| --- | ---------------------------- | ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `create`                     | public     | `(userId, CreateWorkspaceDto) => Workspace`                                      | Create workspace + owner member + auto-create Firm + grant trial credits             |
| 2   | `findAllForUser`             | public     | `(userId) => { owned, member }`                                                  | List all workspaces (owned + member-of) for a user                                   |
| 3   | `findById`                   | public     | `(workspaceId) => Workspace`                                                     | Get single workspace by ID (checks owner `isActive`)                                 |
| 4   | `update`                     | public     | `(workspaceId, UpdateWorkspaceDto) => Workspace`                                 | Partial update workspace settings                                                    |
| 5   | `remove`                     | public     | `(workspaceId, requestUserId) => void`                                           | Delete workspace + cascade-delete members (owner only, not last ws)                  |
| 6   | `getMembers`                 | public     | `(workspaceId) => member[]`                                                      | List active/invited members with populated user info                                 |
| 7   | `inviteMember`               | public     | `(workspaceId, inviterId, InviteMemberDto) => { message }`                       | Invite by email/mobile. Checks seat limit, generates token, dispatches notifications |
| 8   | `removeMember`               | public     | `(workspaceId, memberId, requestUserId) => void`                                 | Remove a member (cannot remove self or owner)                                        |
| 9   | `changeMemberRole`           | public     | `(memberId, ChangeMemberRoleDto) => WorkspaceMember`                             | Change a member's RBAC role                                                          |
| 10  | `getInviteDetails`           | public     | `(token) => invite preview`                                                      | Public. Resolve invite token to workspace/role info                                  |
| 11  | `joinWithToken`              | public     | `(token, userId) => { workspace, member }`                                       | Accept invite. Links user, sets status=active                                        |
| 12  | `getPendingInvitations`      | public     | `(workspaceId) => invitation[]`                                                  | List all pending (status=invited) members                                            |
| 13  | `resendInvite`               | public     | `(workspaceId, memberId, inviterId) => { message }`                              | Re-generate token + re-dispatch notification                                         |
| 14  | `cancelInvite`               | public     | `(workspaceId, memberId) => { message }`                                         | Set invite status=declined, clear token                                              |
| 15  | `declineInvite`              | public     | `(token) => { message }`                                                         | Public. Invitee declines via token                                                   |
| 16  | `getBranding`                | public     | `(workspaceId) => { branding, exportPreferences }`                               | Get branding/export config                                                           |
| 17  | `updateBranding`             | public     | `(workspaceId, BrandingDto) => branding`                                         | Set branding fields                                                                  |
| 18  | `updateExportPreferences`    | public     | `(workspaceId, ExportPreferencesDto) => exportPreferences`                       | Set PDF export toggles                                                               |
| 19  | `getEmployeeCodeSettings`    | public     | `(workspaceId) => { settings, currentCounter, nextSequence }`                    | Read employee auto-code config + counter state                                       |
| 20  | `updateEmployeeCodeSettings` | public     | `(workspaceId, EmployeeCodeSettingsDto) => { settings, ... }`                    | Update auto-code format/prefix/starting number. Validates against counter.           |
| 21  | `regenerateKioskToken`       | public     | `(workspaceId) => { secret, rotatedAt }`                                         | Rotate kiosk secret (bcrypt hash stored, plaintext returned once)                    |
| 22  | `updateKioskSettings`        | public     | `(workspaceId, UpdateKioskSettingsDto) => { enabled, allowedIpRanges, secret? }` | Toggle kiosk, set IP allowlist. Auto-generates token on first enable.                |
| -   | `getWorkspaceLimit`          | private    | `(userId) => number`                                                             | Reads subscription entitlements for max workspaces                                   |
| -   | `getCurrentWorkspaceCount`   | private    | `(userId) => number`                                                             | Counts owned workspaces                                                              |
| -   | `checkSeatLimit`             | private    | `(workspaceId) => void`                                                          | Enforces per-workspace member cap from subscription                                  |

### WorkspaceCounterService

| #   | Method                               | Signature                      | Description                                              |
| --- | ------------------------------------ | ------------------------------ | -------------------------------------------------------- |
| 1   | `reserveNextCode`                    | `(workspaceId) => number`      | Atomic `$inc` on `teamMemberCodeCounter`                 |
| 2   | `peekNextCode`                       | `(workspaceId) => number`      | Read-only preview of next team member code               |
| 3   | `getCurrent`                         | `(workspaceId) => number`      | Current counter value (0 if none)                        |
| 4   | `setCounter`                         | `(workspaceId, value) => void` | Force-set counter (upsert). Used by settings + backfill. |
| 5   | `reserveNextMachineCode`             | `(workspaceId) => number`      | Atomic `$inc` on `machineCodeCounter`                    |
| 6   | `peekNextMachineCode`                | `(workspaceId) => number`      | Read-only preview of next machine code                   |
| 7   | `reserveNextLocationCode`            | `(workspaceId) => number`      | Atomic `$inc` on `locationCodeCounter`                   |
| 8   | `peekNextLocationCode`               | `(workspaceId) => number`      | Read-only preview of next location code                  |
| 9   | `reserveNextGodownCode`              | `(workspaceId) => number`      | Atomic `$inc` on `godownCodeCounter`                     |
| 10  | `reserveNextProductionLogCode`       | `(workspaceId) => number`      | Atomic `$inc` on `productionLogCounter`                  |
| 11  | `peekNextProductionLogCode`          | `(workspaceId) => number`      | Read-only preview of next production log code            |
| 12  | `reserveNextDowntimeCode`            | `(workspaceId) => number`      | Atomic `$inc` on `downtimeCounter`                       |
| 13  | `peekNextDowntimeCode`               | `(workspaceId) => number`      | Read-only preview of next downtime code                  |
| 14  | `reserveNextMaintenanceScheduleCode` | `(workspaceId) => number`      | Atomic `$inc` on `maintenanceScheduleCounter`            |
| 15  | `peekNextMaintenanceScheduleCode`    | `(workspaceId) => number`      | Read-only preview of next maintenance schedule code      |
| 16  | `reserveNextServiceLogCode`          | `(workspaceId) => number`      | Atomic `$inc` on `serviceLogCounter`                     |
| 17  | `peekNextServiceLogCode`             | `(workspaceId) => number`      | Read-only preview of next service log code               |

### InviteNotificationDispatcher

| #   | Method     | Signature                             | Description                                                                                 |
| --- | ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `dispatch` | `(InviteNotificationContext) => void` | Fan-out: in-app notification + push + email (quota-checked) + SMS for mobile-only new users |

---

## 3. Schemas / Models

### Workspace (`workspaces` collection)

| Field                            | Type                                                                          | Default                             | Notes                        |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| `name`                           | `string`                                                                      | required                            |                              |
| `businessType`                   | `string?`                                                                     | -                                   |                              |
| `location`                       | `string?`                                                                     | -                                   |                              |
| `timezone`                       | `string`                                                                      | `'Asia/Kolkata'`                    |                              |
| `fiscalYearStartMonth`           | `number?`                                                                     | `4`                                 |                              |
| `ownerId`                        | `ObjectId` ref `User`                                                         | required                            |                              |
| `isActive`                       | `boolean`                                                                     | `true`                              |                              |
| `designations`                   | `string[]`                                                                    | `[]`                                |                              |
| `bankAccounts`                   | `{ id, label }[]`                                                             | `[]`                                |                              |
| `branding`                       | `{ logo, pdfHeaderLogo, pdfWatermarkLogo, pdfFooterDetails }`                 | undefined                           |                              |
| `exportPreferences`              | `{ includeHeaderLogo, includeFooter, includeWatermark }`                      | undefined                           |                              |
| `employeeCodeSettings`           | `{ enabled, format, prefix, startingNumber, allowCustom }`                    | undefined                           |                              |
| `emailConfig`                    | `{ emailLimitOverride, smtpConfig, usage }`                                   | undefined                           | Custom SMTP + usage tracking |
| `regularizationConfig`           | `{ approvalLevels, fallbackApprover, maxDaysBack, maxAttachmentsPerRequest }` | undefined                           |                              |
| `attendanceIngestToken`          | `string \| null`                                                              | `null`                              |                              |
| `attendanceIngestTokenRotatedAt` | `Date \| null`                                                                | `null`                              |                              |
| `partyIntelligence`              | `{ rfmTuning?, greetings?, gstinPollCadenceDays? }`                           | undefined                           | Phase 17 / FIN-16            |
| `kioskEnabled`                   | `boolean`                                                                     | `false`                             | M-02                         |
| `kioskTokenHash`                 | `string \| null`                                                              | `null`                              | bcrypt hash                  |
| `kioskAllowedIpRanges`           | `string[]`                                                                    | `[]`                                | CIDR allowlist               |
| `kioskTokenRotatedAt`            | `Date \| null`                                                                | `null`                              |                              |
| `maintenanceLeadTimeDays`        | `number`                                                                      | `7`                                 | min:1, max:30. Phase 24.     |
| `productionUptimeTargetPct`      | `number`                                                                      | `85`                                | min:1, max:100. Phase 25.    |
| `storageUsage`                   | `{ bytes, lastUpdatedAt }`                                                    | `{ bytes: 0, lastUpdatedAt: null }` | Wave-3 Drift #36             |
| `createdAt`                      | `Date`                                                                        | auto                                | timestamps: true             |
| `updatedAt`                      | `Date`                                                                        | auto                                | timestamps: true             |

### WorkspaceMember (`workspacemembers` collection)

| Field               | Type                                              | Default    | Notes                       |
| ------------------- | ------------------------------------------------- | ---------- | --------------------------- |
| `workspaceId`       | `ObjectId` ref `Workspace`                        | required   |                             |
| `userId`            | `ObjectId` ref `User` \| null                     | `null`     | null for pre-signup invites |
| `roleId`            | `ObjectId` ref `Role`                             | `null`     |                             |
| `status`            | `enum('active','invited','suspended','declined')` | `'active'` |                             |
| `invitedBy`         | `ObjectId` ref `User`                             | -          |                             |
| `inviteToken`       | `string?`                                         | -          | legacy                      |
| `inviteTokenHash`   | `string?`                                         | -          | SHA-256 of raw token        |
| `inviteExpiry`      | `Date?`                                           | -          | 7-day TTL                   |
| `inviteeIdentifier` | `string?`                                         | -          | email or mobile             |
| `inviteeType`       | `enum('email','mobile') \| null`                  | `null`     |                             |
| `joinedAt`          | `Date?`                                           | -          |                             |
| `createdAt`         | `Date`                                            | auto       |                             |
| `updatedAt`         | `Date`                                            | auto       |                             |

**Indexes:**

- `{ workspaceId: 1, userId: 1 }` - unique, sparse
- `{ inviteeIdentifier: 1 }` - sparse

### WorkspaceCounter (`workspace_counters` collection)

| Field                        | Type                       | Default                   | Notes  |
| ---------------------------- | -------------------------- | ------------------------- | ------ |
| `workspaceId`                | `ObjectId` ref `Workspace` | required, unique, indexed |        |
| `teamMemberCodeCounter`      | `number`                   | `0`                       |        |
| `machineCodeCounter`         | `number`                   | `0`                       |        |
| `locationCodeCounter`        | `number`                   | `0`                       |        |
| `godownCodeCounter`          | `number`                   | `0`                       | min: 0 |
| `productionLogCounter`       | `number`                   | `0`                       | min: 0 |
| `downtimeCounter`            | `number`                   | `0`                       | min: 0 |
| `maintenanceScheduleCounter` | `number`                   | `0`                       | min: 0 |
| `serviceLogCounter`          | `number`                   | `0`                       | min: 0 |

---

## 4. DTOs

### `CreateWorkspaceDto`

| Field          | Type                | Validators                          | Notes                            |
| -------------- | ------------------- | ----------------------------------- | -------------------------------- |
| `name`         | `string`            | required, `@IsNotEmpty`             |                                  |
| `businessType` | `string?`           | optional                            |                                  |
| `location`     | `string?`           | optional                            |                                  |
| `timezone`     | `string?`           | optional                            |                                  |
| `designations` | `string[]?`         | optional                            |                                  |
| `bankAccounts` | `BankAccountDto[]?` | optional, validated nested          |                                  |
| `firmName`     | `string?`           | optional                            | Passed to FirmsService on create |
| `gstin`        | `string?`           | optional                            | Passed to FirmsService on create |
| `pan`          | `string?`           | optional                            | Passed to FirmsService on create |
| `fyStartMonth` | `number?`           | optional, `@IsInt @Min(1) @Max(12)` | Passed to FirmsService on create |

### `UpdateWorkspaceDto`

| Field                       | Type                | Validators                           |
| --------------------------- | ------------------- | ------------------------------------ |
| `name`                      | `string?`           | optional                             |
| `businessType`              | `string?`           | optional                             |
| `location`                  | `string?`           | optional                             |
| `timezone`                  | `string?`           | optional                             |
| `designations`              | `string[]?`         | optional                             |
| `bankAccounts`              | `BankAccountDto[]?` | optional, validated nested           |
| `maintenanceLeadTimeDays`   | `number?`           | optional, `@IsInt @Min(1) @Max(30)`  |
| `productionUptimeTargetPct` | `number?`           | optional, `@IsInt @Min(1) @Max(100)` |

### `InviteMemberDto`

| Field    | Type      | Validators                                 |
| -------- | --------- | ------------------------------------------ |
| `email`  | `string?` | optional, `@IsEmail`                       |
| `mobile` | `string?` | optional, `@Matches(/^\+?[1-9]\d{1,14}$/)` |
| `roleId` | `string?` | optional, `@IsMongoId`                     |

### `ChangeMemberRoleDto`

| Field    | Type      | Validators                                         |
| -------- | --------- | -------------------------------------------------- |
| `roleId` | `string?` | optional, `@IsMongoId`. Null = system Member role. |

### `BrandingDto`

| Field              | Type      | Validators                  |
| ------------------ | --------- | --------------------------- |
| `logo`             | `string?` | optional                    |
| `pdfHeaderLogo`    | `string?` | optional                    |
| `pdfWatermarkLogo` | `string?` | optional                    |
| `pdfFooterDetails` | `string?` | optional, `@MaxLength(300)` |

### `ExportPreferencesDto`

| Field               | Type       | Validators |
| ------------------- | ---------- | ---------- |
| `includeHeaderLogo` | `boolean?` | optional   |
| `includeFooter`     | `boolean?` | optional   |
| `includeWatermark`  | `boolean?` | optional   |

### `EmployeeCodeSettingsDto`

| Field            | Type       | Validators                                                                        |
| ---------------- | ---------- | --------------------------------------------------------------------------------- |
| `enabled`        | `boolean?` | optional                                                                          |
| `format`         | `string?`  | optional, `@MaxLength(64)`, must contain `{#...}` token, alphanumeric+tokens only |
| `prefix`         | `string?`  | optional, `@MaxLength(16)`, alphanumeric only                                     |
| `startingNumber` | `number?`  | optional, `@IsInt @Min(1) @Max(9999999)`                                          |
| `allowCustom`    | `boolean?` | optional                                                                          |

### `UpdateKioskSettingsDto`

| Field             | Type        | Validators                    |
| ----------------- | ----------- | ----------------------------- |
| `enabled`         | `boolean?`  | optional                      |
| `allowedIpRanges` | `string[]?` | optional, `@ArrayMaxSize(50)` |

### `BankAccountDto` (internal, nested)

| Field   | Type     | Validators |
| ------- | -------- | ---------- |
| `id`    | `string` | required   |
| `label` | `string` | required   |

---

## 5. Guards, Decorators, Interceptors

| Name                                           | Source                                  | Usage in Workspaces                                                                                                                     |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `JwtAuthGuard`                                 | `common/guards/jwt-auth.guard.ts`       | Class-level on `WorkspacesController`                                                                                                   |
| `SubscriptionGuard`                            | `common/guards/subscription.guard.ts`   | Class-level on `WorkspacesController`. Reads `@RequireSubscription` metadata.                                                           |
| `@RequireSubscription({ module, subFeature })` | `common/guards/subscription.guard.ts`   | Used on 6 routes: `update`, `updateBranding`, `updateExportPreferences`, `updateEmployeeCodeSettings`, `updateKiosk`, `regenerateToken` |
| `@Public()`                                    | `common/decorators/public.decorator.ts` | Used on 2 routes: `getInviteDetails`, `declineInvite`. Bypasses `JwtAuthGuard`.                                                         |

**Subscription-gated features used:**

| Module               | Sub-feature          | Routes                                                                                                |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `AppModule.SETTINGS` | `edit_settings`      | `PATCH :id`, `PATCH :id/employee-code-settings`, `PATCH :id/kiosk`, `POST :id/kiosk/regenerate-token` |
| `AppModule.SETTINGS` | `workspace_branding` | `PATCH :id/branding`, `PATCH :id/export-preferences`                                                  |

---

## 6. Cron Jobs

**No cron jobs exist inside the workspaces module.**

No `@Cron` decorators, no `*.cron.ts` files within `src/modules/workspaces/`.

---

## 7. Types / Interfaces

### `WorkspaceWithRole` (`types/workspace.types.ts`)

```ts
{
  workspace: Workspace;
  currentUserRole: Role | null;
}
```

### `WorkspaceMemberResult` (`types/workspace.types.ts`)

```ts
{
  member: WorkspaceMember;
}
```

### `InviteNotificationContext` (`invite-notification.dispatcher.ts`)

```ts
{
  workspaceId: string;
  workspaceName: string;
  inviterName: string;
  inviteeIdentifier: string;
  inviteeType: 'email' | 'mobile';
  inviteeUserId?: string;
  inviteeEmail?: string;
  role: string;
  inviteUrl: string;
  mobileDeepLink: string;
}
```

---

## 8. Module Dependencies

**Imports:** `ConfigModule`, `UsersModule`, `SubscriptionsModule`, `SmsModule`, `MailModule`, `NotificationsModule`, `UserDevicesModule`
**Lazy (ModuleRef):** `FirmsService` (finance), `AddOnsService` (add-ons) -- avoids circular imports
**Exports:** `WorkspacesService`, `WorkspaceCounterService`, `MongooseModule` (schemas)
**Scope:** `@Global()` -- available to all modules without explicit import
