import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_PIN_UNLOCK_KEY = 'isSkipPinUnlock';
export const SkipPinUnlock = () => SetMetadata(IS_SKIP_PIN_UNLOCK_KEY, true);
