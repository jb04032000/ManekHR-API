import { IsIn, IsInt, ValidateIf } from 'class-validator';

/**
 * Allowed App Lock idle-timeout presets, in milliseconds. Matches the web
 * `IDLE_PRESETS` set on `/dashboard/settings/security` so a value the user
 * sees in the dropdown always validates server-side. Cross-validated by the
 * DTO via `@IsIn` and re-asserted defensively in `UsersService.setAppLockIdleMs`.
 */
export const APP_LOCK_IDLE_PRESETS_MS = [
  60_000, // 1 min
  120_000, // 2 min
  300_000, // 5 min
  600_000, // 10 min
  900_000, // 15 min
  1_800_000, // 30 min
] as const;

export type AppLockIdlePresetMs = (typeof APP_LOCK_IDLE_PRESETS_MS)[number];

/**
 * Body for `PATCH /me/security/app-lock-idle`. Accepts one of the documented
 * presets, or `null` to clear the user's override (so the per-workspace value
 * or the deployment default applies).
 */
export class SetAppLockIdleDto {
  /**
   * Idle timeout in milliseconds. `null` clears the override. `ValidateIf`
   * skips the `@IsIn` check when the value is explicitly `null` — otherwise
   * class-validator would reject `null` as not-in-the-presets-array.
   */
  @ValidateIf((o: SetAppLockIdleDto) => o.appLockIdleMs !== null)
  @IsInt()
  @IsIn(APP_LOCK_IDLE_PRESETS_MS)
  appLockIdleMs!: number | null;
}
