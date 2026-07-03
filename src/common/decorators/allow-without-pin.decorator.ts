import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route reachable by an authenticated user who has NOT set a Quick PIN
 * yet — the pre-PIN onboarding window. The canonical case is `POST /workspaces`
 * (create the FIRST workspace), which MUST happen before PIN setup: App Lock is
 * an ERP-only protection over an existing workspace's payroll/finance/staff
 * data, and you cannot have a PIN-protected ERP space before you have created
 * the space.
 *
 * The PinUnlockGuard honours this ONLY in its no-PIN branch — a user who HAS a
 * PIN must still unlock (so an established, currently-locked ERP user cannot use
 * a marked route while locked). This is the key difference from
 * `@SkipPinUnlock`, which exempts the route for EVERYONE (including PIN-holders
 * who are locked). Use `@SkipPinUnlock` for identity/account routes that hold no
 * ERP data; use `@AllowWithoutPin` for onboarding writes that a PIN-less user
 * legitimately needs but a PIN-holder should still be locked out of.
 *
 * Cross-links: read by common/guards/pin-unlock.guard.ts. Keep the two in sync.
 */
export const IS_ALLOW_WITHOUT_PIN_KEY = 'isAllowWithoutPin';
export const AllowWithoutPin = () => SetMetadata(IS_ALLOW_WITHOUT_PIN_KEY, true);
