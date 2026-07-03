# Advance Request Window Configuration — Implementation Plan (Phase 1a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the workspace owner configure WHEN employees may request a salary advance (any day / a single day like the 21st / a window like 21–23), and let employees see that window up-front instead of discovering it via an error on submit.

**Architecture:** The backend window ENGINE already exists (`advanceRequestPolicy` on `PayrollConfig.disbursementRules` + `advance-request-window.util.ts`). This plan (a) opens the write path — the disbursement-rules DTO + update service currently accept only the legacy `advanceRequestDay`, so we add `advanceRequestPolicy`; (b) adds a self-scoped read endpoint so a worker (who cannot read full `PayrollConfig`) can see the window; (c) wires both into the web settings panel and the worker request drawer.

**Tech Stack:** NestJS + Mongoose + class-validator (backend), Next.js + AntD v6 + next-intl + Zustand (web), vitest both sides.

**Spec:** `docs/superpowers/specs/2026-06-22-advance-salary-workflow-design.md` (§3, §6.1, §6.2). This is Phase 1a; the two-step approve→disburse lifecycle, budget allocation, and reporting-person review are separate later plans.

**Conventions to honor:** no `process.env.*` (use `src/config/env.ts`); audit every owner write via `AuditService`; colocated `*.vitest.ts`; AntD v6 only (`InputNumber suffix=`, `Alert title=`, no `destroyOnClose`); run web vitest with `--no-file-parallelism`; run BE vitest per-file (never the whole suite — it OOMs).

---

## File Structure

**Backend (`crewroster-backend`)**

- Modify: `src/modules/salary/dto/update-disbursement-rules.dto.ts` — add nested `AdvanceRequestPolicyInputDto` + `advanceRequestPolicy?` field.
- Modify: `src/modules/salary/salary.service.ts` — `updateDisbursementRules` persists `advanceRequestPolicy`; add `getAdvanceWindow(workspaceId, todayDay)` helper.
- Modify: `src/modules/salary/advance-salary-request.controller.ts` — add `GET /advance-requests/window` (self scope).
- Modify: `src/modules/salary/advance-salary-request.service.ts` — add `getWindowForMember(workspaceId)` returning `{ policy, isOpenToday, message }` reusing the window util.
- Create: `src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts`
- Create: `src/modules/salary/__tests__/advance-window.endpoint.vitest.ts`

**Web (`crewroster-web`)**

- Modify: `types/index.ts` — extend `DisbursementRules` with `advanceRequestPolicy`.
- Modify: `lib/api/modules/salary.api.ts` — `getAdvanceWindow(wsId)` client wrapper; `updateDisbursementRules` already passes the payload through (no signature change).
- Modify: `lib/api/endpoints.ts` — add `advanceRequestsWindow(wsId)` endpoint string.
- Create: `app/dashboard/salary/components/salary/AdvanceWindowControl.tsx` — the policy editor (radio + day pickers).
- Modify: `app/dashboard/salary/components/salary/DisbursementRulesPanel.tsx` — replace the single `advanceRequestDay` field with `<AdvanceWindowControl>`.
- Modify: `components/dashboard/salary/AdvanceRequestDrawer.tsx` — fetch + show the window banner.
- Create: `components/dashboard/salary/AdvanceWindowControl.vitest.tsx`
- Modify: `app/messages/en.json` (+ gu / gu-en / hi-en) — new keys.

---

## Task 1: Backend DTO accepts `advanceRequestPolicy`

**Files:**

- Modify: `src/modules/salary/dto/update-disbursement-rules.dto.ts`
- Test: `src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateDisbursementRulesDto } from '../update-disbursement-rules.dto';

const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

describe('UpdateDisbursementRulesDto - advanceRequestPolicy', () => {
  it('accepts a valid window policy', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'window', windowStartDay: 21, windowEndDay: 23 },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('accepts a fixed_day policy', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'fixed_day', fixedDay: 21 },
    });
    expect(await validate(dto, PIPE)).toHaveLength(0);
  });

  it('rejects an unknown mode', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'whenever' },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });

  it('rejects a day out of 1..31', async () => {
    const dto = plainToInstance(UpdateDisbursementRulesDto, {
      advanceRequestPolicy: { mode: 'window', windowStartDay: 0, windowEndDay: 40 },
    });
    expect((await validate(dto, PIPE)).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts`
Expected: FAIL — `advanceRequestPolicy` is non-whitelisted (property should not exist) / unknown.

- [ ] **Step 3: Add the nested DTO + field**

In `src/modules/salary/dto/update-disbursement-rules.dto.ts`, add imports and the nested class, and the field on `UpdateDisbursementRulesDto`:

```ts
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Mirrors PayrollConfig.disbursementRules.advanceRequestPolicy
// (schemas/payroll-config.schema.ts:127-160) + the window util's modes.
export class AdvanceRequestPolicyInputDto {
  @IsIn(['any_day', 'window', 'fixed_day'])
  mode: 'any_day' | 'window' | 'fixed_day';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  fixedDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  windowStartDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  windowEndDay?: number;
}
```

Then add to `UpdateDisbursementRulesDto` (keep the existing `advanceRequestDay` for back-compat):

```ts
  @IsOptional()
  @ValidateNested()
  @Type(() => AdvanceRequestPolicyInputDto)
  advanceRequestPolicy?: AdvanceRequestPolicyInputDto;
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/modules/salary/dto/update-disbursement-rules.dto.ts src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts
git commit -m "feat(salary): accept advanceRequestPolicy in disbursement-rules DTO"
```

---

## Task 2: Service persists `advanceRequestPolicy`

**Files:**

- Modify: `src/modules/salary/salary.service.ts` (method `updateDisbursementRules`)

- [ ] **Step 1: Locate the method**

Run: `grep -n "updateDisbursementRules" src/modules/salary/salary.service.ts`
Read the method. It builds a partial `$set` over `disbursementRules.*` and saves PayrollConfig. Note the exact pattern it uses for `advanceRequestDay`.

- [ ] **Step 2: Add the passthrough (mirror the existing `advanceRequestDay` handling)**

Inside `updateDisbursementRules`, wherever optional fields are conditionally set, add:

```ts
// Persist the structured request-window policy (any_day | window | fixed_day).
// Mirrors advanceRequestDay handling; the window util reads this on create.
// Links: advance-request-window.util.ts, AdvanceWindowControl.tsx.
if (dto.advanceRequestPolicy !== undefined) {
  config.disbursementRules.advanceRequestPolicy = dto.advanceRequestPolicy;
  // keep the legacy single-day in sync when a fixed day is chosen, so older
  // readers that still consult advanceRequestDay stay correct.
  if (dto.advanceRequestPolicy.mode === 'fixed_day' && dto.advanceRequestPolicy.fixedDay) {
    config.disbursementRules.advanceRequestDay = dto.advanceRequestPolicy.fixedDay;
  }
}
```

(If the method mutates a Mongoose doc and `.save()`s, the above fits. If it uses `findOneAndUpdate` with a `$set` map, instead add `$set['disbursementRules.advanceRequestPolicy'] = dto.advanceRequestPolicy;` following the existing field's exact style.)

- [ ] **Step 3: Write the persistence test**

Create `src/modules/salary/__tests__/disbursement-rules.policy.vitest.ts` using the existing `@nestjs/mongoose` decorator-mock pattern (see `src/modules/auth/__tests__/auth.service.audit.vitest.ts`). Mock the PayrollConfig model so `updateDisbursementRules` with `{ advanceRequestPolicy: { mode:'window', windowStartDay:21, windowEndDay:23 } }` results in those values being written. Assert the saved document carries `disbursementRules.advanceRequestPolicy.mode === 'window'`.

- [ ] **Step 4: Run + verify pass**

Run: `npx vitest run src/modules/salary/__tests__/disbursement-rules.policy.vitest.ts`

- [ ] **Step 5: Commit**

```bash
git add src/modules/salary/salary.service.ts src/modules/salary/__tests__/disbursement-rules.policy.vitest.ts
git commit -m "feat(salary): persist advanceRequestPolicy on disbursement-rules update"
```

---

## Task 3: Self-scoped "my advance window" read

**Files:**

- Modify: `src/modules/salary/advance-salary-request.service.ts` (add `getWindowForMember`)
- Modify: `src/modules/salary/advance-salary-request.controller.ts` (add `GET window`)
- Test: `src/modules/salary/__tests__/advance-window.endpoint.vitest.ts`

- [ ] **Step 1: Write the failing service test**

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@nestjs/mongoose', () => {
  const noop = () => () => undefined;
  return {
    Prop: () => noop(),
    Schema: () => noop(),
    SchemaFactory: { createForClass: () => ({ index: () => undefined }) },
    InjectModel: () => () => undefined,
    getModelToken: (n: string) => `${n}Model`,
    MongooseModule: { forFeature: () => ({}) },
  };
});
import { AdvanceSalaryRequestService } from '../advance-salary-request.service';

describe('getWindowForMember', () => {
  it('reports closed + message when today is outside a fixed_day policy', async () => {
    const cfg = {
      disbursementRules: {
        advanceRequestDay: 15,
        advanceRequestPolicy: { mode: 'fixed_day', fixedDay: 21 },
      },
    };
    const payrollConfigModel = { findOne: () => ({ lean: () => ({ exec: async () => cfg }) }) };
    const svc = new AdvanceSalaryRequestService(
      {} as any,
      payrollConfigModel as any,
      {} as any,
      {} as any,
    );
    const res = await svc.getWindowForMember('ws1', 23); // today = 23, policy day = 21
    expect(res.isOpenToday).toBe(false);
    expect(res.policy.mode).toBe('fixed_day');
    expect(res.message).toMatch(/day 21/);
  });

  it('reports open for an any_day policy', async () => {
    const cfg = { disbursementRules: { advanceRequestPolicy: { mode: 'any_day' } } };
    const payrollConfigModel = { findOne: () => ({ lean: () => ({ exec: async () => cfg }) }) };
    const svc = new AdvanceSalaryRequestService(
      {} as any,
      payrollConfigModel as any,
      {} as any,
      {} as any,
    );
    const res = await svc.getWindowForMember('ws1', 23);
    expect(res.isOpenToday).toBe(true);
  });
});
```

> Note: constructor arg order must match the real service — verify against `advance-salary-request.service.ts` constructor (advanceRequestModel, payrollConfigModel, notificationsService, teamMemberModel) and adjust the positional mocks so `payrollConfigModel` is in the right slot.

- [ ] **Step 2: Run, verify fail** (`getWindowForMember` is undefined)

Run: `npx vitest run src/modules/salary/__tests__/advance-window.endpoint.vitest.ts`

- [ ] **Step 3: Implement `getWindowForMember`**

In `advance-salary-request.service.ts`, reuse the existing helpers (`loadPayrollConfig`, `getTodayInIST`, `isAdvanceRequestWindowOpen`, `advanceRequestWindowMessage`):

```ts
// Worker-facing read: lets the request drawer show the window without exposing
// the full PayrollConfig (which is salary view:all). Links: AdvanceRequestDrawer.tsx,
// advance-request-window.util.ts. `todayDay` is injectable for tests; defaults to IST today.
async getWindowForMember(
  workspaceId: string,
  todayDay?: number,
): Promise<{ policy: { mode: string; fixedDay?: number; windowStartDay?: number; windowEndDay?: number }; isOpenToday: boolean; message: string }> {
  const config = await this.loadPayrollConfig(workspaceId);
  const fallbackDay = config.disbursementRules?.advanceRequestDay ?? 15;
  const policy = config.disbursementRules?.advanceRequestPolicy;
  const day = todayDay ?? this.getTodayInIST().day;
  const isOpenToday = isAdvanceRequestWindowOpen(policy, fallbackDay, day);
  return {
    policy: policy ?? { mode: 'fixed_day', fixedDay: fallbackDay },
    isOpenToday,
    message: advanceRequestWindowMessage(policy, fallbackDay),
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/modules/salary/__tests__/advance-window.endpoint.vitest.ts`

- [ ] **Step 5: Add the controller route**

In `advance-salary-request.controller.ts`, add (self scope, same guard as `/mine`):

```ts
/**
 * GET /workspaces/:workspaceId/salary/advance-requests/window
 * Self-scoped: tells the requesting worker whether the advance window is open
 * today + a human message. Declared before the parameterised GET. Links:
 * AdvanceRequestDrawer.tsx, getWindowForMember.
 */
@Get('window')
@RequirePermissions(AppModule.SALARY, ModuleAction.REQUEST_ADVANCE, 'self')
getWindow(@Param('workspaceId') workspaceId: string) {
  return this.advanceSalaryRequestService.getWindowForMember(workspaceId);
}
```

> Place this BEFORE the existing `@Get(':requestId')`-style param route (mirror the `/mine` ordering comment) so `window` is not parsed as an id.

- [ ] **Step 6: Verify the controller test path** (extend the existing controller vitest if present; assert `getWindow` calls the service). Run the salary advance controller test file.

- [ ] **Step 7: Commit**

```bash
git add src/modules/salary/advance-salary-request.service.ts src/modules/salary/advance-salary-request.controller.ts src/modules/salary/__tests__/advance-window.endpoint.vitest.ts
git commit -m "feat(salary): self-scoped advance-request window read endpoint"
```

---

## Task 4: Web types + API wrappers

**Files:**

- Modify: `types/index.ts` (extend `DisbursementRules`)
- Modify: `lib/api/endpoints.ts` (add window endpoint)
- Modify: `lib/api/modules/salary.api.ts` (add `getAdvanceWindow`)

- [ ] **Step 1: Extend the type**

In `types/index.ts`, on the `DisbursementRules` interface add (find it via `grep -n "advanceRequestDay" types/index.ts`):

```ts
  advanceRequestPolicy?: {
    mode: 'any_day' | 'window' | 'fixed_day';
    fixedDay?: number;
    windowStartDay?: number;
    windowEndDay?: number;
  };
```

Add an `AdvanceWindowResponse` type:

```ts
export interface AdvanceWindowResponse {
  policy: {
    mode: 'any_day' | 'window' | 'fixed_day';
    fixedDay?: number;
    windowStartDay?: number;
    windowEndDay?: number;
  };
  isOpenToday: boolean;
  message: string;
}
```

- [ ] **Step 2: Add the endpoint + client wrapper**

`lib/api/endpoints.ts` — in the `salary` block near `advanceRequestsMine`:

```ts
    advanceRequestsWindow: (wsId: string) => `workspaces/${wsId}/salary/advance-requests/window`,
```

`lib/api/modules/salary.api.ts` — add:

```ts
/** Self-scoped: is the advance window open today + a message. Links: AdvanceRequestDrawer. */
export async function getAdvanceWindow(wsId: string): Promise<AdvanceWindowResponse> {
  const response = await http.get(E.advanceRequestsWindow(wsId));
  return unwrap<AdvanceWindowResponse>(response);
}
```

(Import `AdvanceWindowResponse` in the type import block.)

- [ ] **Step 3: Typecheck the touched files**

Run: `npx eslint types/index.ts lib/api/endpoints.ts lib/api/modules/salary.api.ts`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add types/index.ts lib/api/endpoints.ts lib/api/modules/salary.api.ts
git commit -m "feat(salary-web): types + client for advanceRequestPolicy and window read"
```

---

## Task 5: Owner settings — AdvanceWindowControl

**Files:**

- Create: `app/dashboard/salary/components/salary/AdvanceWindowControl.tsx`
- Modify: `app/dashboard/salary/components/salary/DisbursementRulesPanel.tsx`
- Test: `components/dashboard/salary/AdvanceWindowControl.vitest.tsx`

- [ ] **Step 1: Write the failing component test**

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdvanceWindowControl } from '@/app/dashboard/salary/components/salary/AdvanceWindowControl';

const messages = { salarySettings: {} };
afterEach(cleanup);

describe('AdvanceWindowControl', () => {
  it('emits a window policy when window mode + days are chosen', () => {
    const onChange = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdvanceWindowControl value={{ mode: 'any_day' }} disabled={false} onChange={onChange} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByLabelText(/window/i)); // radio: a range of days
    const [start, end] = screen.getAllByRole('spinbutton');
    fireEvent.change(start, { target: { value: '21' } });
    fireEvent.change(end, { target: { value: '23' } });
    fireEvent.blur(end);
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ mode: 'window', windowStartDay: 21, windowEndDay: 23 });
  });
});
```

- [ ] **Step 2: Run, verify fail** (component doesn't exist)

Run: `npx vitest run components/dashboard/salary/AdvanceWindowControl.vitest.tsx --no-file-parallelism`

- [ ] **Step 3: Implement the control**

Create `app/dashboard/salary/components/salary/AdvanceWindowControl.tsx`. A controlled component: AntD `Radio.Group` (Any day / A single day / A range of days) + conditional `InputNumber`s. AntD v6 (`InputNumber suffix=`, no banned APIs). Calls `onChange(policy)` on every edit.

```tsx
'use client';
// Owner control for the advance-request window. Writes PayrollConfig.disbursementRules
// .advanceRequestPolicy via DisbursementRulesPanel -> updateDisbursementRules.
// Links: backend advance-request-window.util.ts (same modes), AdvanceRequestDrawer (worker view).
import { InputNumber, Radio } from 'antd';
import { useTranslations } from 'next-intl';

export interface AdvanceWindowPolicy {
  mode: 'any_day' | 'window' | 'fixed_day';
  fixedDay?: number;
  windowStartDay?: number;
  windowEndDay?: number;
}

export function AdvanceWindowControl({
  value,
  disabled,
  onChange,
}: {
  value: AdvanceWindowPolicy;
  disabled: boolean;
  onChange: (p: AdvanceWindowPolicy) => void;
}) {
  const t = useTranslations('salarySettings');
  const mode = value.mode ?? 'any_day';
  return (
    <div>
      <Radio.Group
        value={mode}
        disabled={disabled}
        onChange={(e) => {
          const m = e.target.value as AdvanceWindowPolicy['mode'];
          if (m === 'any_day') onChange({ mode: 'any_day' });
          else if (m === 'fixed_day')
            onChange({ mode: 'fixed_day', fixedDay: value.fixedDay ?? 21 });
          else
            onChange({
              mode: 'window',
              windowStartDay: value.windowStartDay ?? 21,
              windowEndDay: value.windowEndDay ?? 23,
            });
        }}
        options={[
          {
            value: 'any_day',
            label: t('advanceWindow.anyDay', { defaultValue: 'Any day of the month' }),
          },
          {
            value: 'fixed_day',
            label: t('advanceWindow.fixedDay', { defaultValue: 'A single day' }),
          },
          {
            value: 'window',
            label: t('advanceWindow.window', { defaultValue: 'A range of days' }),
          },
        ]}
      />
      {mode === 'fixed_day' && (
        <div className="mt-3">
          <InputNumber
            min={1}
            max={28}
            disabled={disabled}
            value={value.fixedDay ?? 21}
            aria-label={t('advanceWindow.fixedDay', { defaultValue: 'A single day' })}
            suffix={t('disbursement.salaryDateSuffix', { defaultValue: 'of month' })}
            onChange={(v) => onChange({ mode: 'fixed_day', fixedDay: v ?? 21 })}
          />
        </div>
      )}
      {mode === 'window' && (
        <div className="mt-3 flex items-center gap-2">
          <InputNumber
            min={1}
            max={31}
            disabled={disabled}
            value={value.windowStartDay ?? 21}
            aria-label={t('advanceWindow.startDay', { defaultValue: 'From day' })}
            onChange={(v) =>
              onChange({
                mode: 'window',
                windowStartDay: v ?? 1,
                windowEndDay: value.windowEndDay ?? 23,
              })
            }
          />
          <span>{t('advanceWindow.to', { defaultValue: 'to' })}</span>
          <InputNumber
            min={1}
            max={31}
            disabled={disabled}
            value={value.windowEndDay ?? 23}
            aria-label={t('advanceWindow.endDay', { defaultValue: 'to day' })}
            onChange={(v) =>
              onChange({
                mode: 'window',
                windowStartDay: value.windowStartDay ?? 21,
                windowEndDay: v ?? 31,
              })
            }
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run components/dashboard/salary/AdvanceWindowControl.vitest.tsx --no-file-parallelism`

- [ ] **Step 5: Wire into DisbursementRulesPanel**

In `DisbursementRulesPanel.tsx`: replace the `advanceRequestDay` `<div>` block (lines ~240-270) with `<AdvanceWindowControl value={policy} disabled={!isOwner} onChange={setPolicy} />`; add `policy` state seeded from `config.disbursementRules.advanceRequestPolicy ?? { mode:'fixed_day', fixedDay: config.disbursementRules.advanceRequestDay ?? 15 }`; include `advanceRequestPolicy: policy` in the `updateDisbursementRules` payload in `handleSaveDisburse`. Keep `advanceRequestDay` out of the UI (the backend keeps it in sync for fixed_day).

- [ ] **Step 6: Lint + commit**

Run: `npx eslint app/dashboard/salary/components/salary/AdvanceWindowControl.tsx app/dashboard/salary/components/salary/DisbursementRulesPanel.tsx components/dashboard/salary/AdvanceWindowControl.vitest.tsx`

```bash
git add app/dashboard/salary/components/salary/AdvanceWindowControl.tsx app/dashboard/salary/components/salary/DisbursementRulesPanel.tsx components/dashboard/salary/AdvanceWindowControl.vitest.tsx
git commit -m "feat(salary-web): owner advance-window control (any day / single day / range)"
```

---

## Task 6: Worker sees the window in the request drawer

**Files:**

- Modify: `components/dashboard/salary/AdvanceRequestDrawer.tsx`

- [ ] **Step 1: Add a window fetch + banner**

On drawer open, call `getAdvanceWindow(workspaceId)`; render an AntD `Alert` (`title=`, v6) above the form: when `isOpenToday` show a neutral info Alert with `message` (e.g. "Advances open on day 21" / "21–23"); when closed show a `warning` Alert with `message` and disable the Submit button. Keep the existing submit + `parseApiError` fallback as the backstop.

```tsx
// inside the component
const [window, setWindow] = useState<AdvanceWindowResponse | null>(null);
useEffect(() => {
  if (!open || !workspaceId) return;
  let live = true;
  getAdvanceWindow(workspaceId).then((w) => { if (live) setWindow(w); }).catch(() => {});
  return () => { live = false; };
}, [open, workspaceId]);
// ...in JSX, above <Form>:
{window && (
  <Alert
    type={window.isOpenToday ? 'info' : 'warning'}
    showIcon
    className="mb-3"
    title={window.message}
  />
)}
// disable submit when closed:
<Button type="primary" loading={saving} disabled={window ? !window.isOpenToday : false} onClick={() => form.submit()}>
```

- [ ] **Step 2: Update the drawer test**

In `components/dashboard/salary/AdvanceRequestDrawer.vitest.tsx`, mock `getAdvanceWindow` (via the existing `@/lib/api/modules/salary.api` mock — add `getAdvanceWindow: vi.fn().mockResolvedValue({ isOpenToday: true, message: 'Advances open on day 21', policy: { mode:'fixed_day', fixedDay:21 } })`). Add a test: when `isOpenToday:false`, the Submit button is disabled and `createAdvanceRequest` is not called.

- [ ] **Step 3: Run, verify pass**

Run: `npx vitest run components/dashboard/salary/AdvanceRequestDrawer.vitest.tsx --no-file-parallelism`

- [ ] **Step 4: Lint + commit**

```bash
git add components/dashboard/salary/AdvanceRequestDrawer.tsx components/dashboard/salary/AdvanceRequestDrawer.vitest.tsx
git commit -m "feat(salary-web): show advance window + block submit when closed"
```

---

## Task 7: i18n keys (4 locales)

**Files:**

- Modify: `app/messages/en.json`, `gu.json`, `gu-en.json`, `hi-en.json`

- [ ] **Step 1: Add keys** under `salarySettings.advanceWindow` (anyDay/fixedDay/window/startDay/endDay/to) in all four files; native gu/gu-en/hi-en (en first, then translate). Worker banner uses the backend `message` string (English from BE today; localizing BE messages is out of scope here).

- [ ] **Step 2: Verify parity**

Run: `npm run check:i18n`
Expected: parity count increases by the same number across all locales, no missing-key errors.

- [ ] **Step 3: Commit**

```bash
git add app/messages/en.json app/messages/gu.json app/messages/gu-en.json app/messages/hi-en.json
git commit -m "i18n(salary): advance-window control strings"
```

---

## Final verification

- [ ] BE: `npx vitest run src/modules/salary/dto/__tests__/update-disbursement-rules.dto.vitest.ts src/modules/salary/__tests__/advance-window.endpoint.vitest.ts src/modules/salary/__tests__/disbursement-rules.policy.vitest.ts` — all green.
- [ ] BE build: `npm run build` (SWC) — clean.
- [ ] Web: `npx vitest run components/dashboard/salary/AdvanceWindowControl.vitest.tsx components/dashboard/salary/AdvanceRequestDrawer.vitest.tsx --no-file-parallelism` — green.
- [ ] Web lint on all touched files — 0 errors. `npm run check:i18n` — green.
- [ ] Live smoke (owner): Payroll Settings → set window to 21–23 → save. As a member, open the advance drawer on a day outside 21–23 → see "opens on…" + Submit disabled; inside the window → Submit enabled and a request succeeds.

---

## Self-review (done at authoring)

- Spec coverage: §6.1 (owner window settings) = Tasks 1,2,5; §6.2 (worker sees window) = Tasks 3,6. Two-step pay / allocation / review are explicitly OUT (later plans).
- No placeholders: every code step has real code or a precise file+pattern reference (Task 2 service edit is anchored to the method's existing `advanceRequestDay` pattern; verify-then-mirror).
- Type consistency: `AdvanceRequestPolicy{Input}Dto` / `advanceRequestPolicy` / `AdvanceWindowResponse` used consistently across BE + web.
- Scope: single coherent slice (request-window config); independently shippable + testable.
