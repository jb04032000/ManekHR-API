import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { UserDevicesController } from '../user-devices.controller';
import { IS_SKIP_PIN_UNLOCK_KEY } from '../../../common/decorators/skip-pin-unlock.decorator';

/**
 * Regression guard for the browser-push App Lock fix: the /devices/* endpoints
 * must stay exempt from the App Lock (PIN) guard. Push-token registration is
 * product-neutral + user-scoped and is driven from the PIN-free Connect surface,
 * so PinUnlockGuard must NOT 423 it while the ERP side is locked. If a future
 * refactor drops @SkipPinUnlock from UserDevicesController, enabling browser push
 * silently breaks with APP_LOCKED again — this test fails first.
 */
describe('UserDevicesController App Lock exemption', () => {
  it('carries class-level @SkipPinUnlock', () => {
    const skip = Reflect.getMetadata(IS_SKIP_PIN_UNLOCK_KEY, UserDevicesController);
    expect(skip).toBe(true);
  });
});
