import { Logger } from '@nestjs/common';

const logger = new Logger('ZkCodeMapper');

/** D-15: ZK status code → punchType enum. Unknown codes default to CHECK_IN with warning. */
const ZK_STATUS_TO_PUNCH_TYPE: Record<number, string> = {
  0: 'CHECK_IN',
  1: 'CHECK_OUT',
  2: 'BREAK_OUT',
  3: 'BREAK_IN',
  4: 'OT_IN',
  5: 'OT_OUT',
};

/** D-15: ZK verify code → verifyMethod string. Unknown codes → null. */
const ZK_VERIFY_TO_METHOD: Record<number, string> = {
  1: 'fp',
  4: 'card',
  15: 'face',
  25: 'palm',
};

export function mapStatusCode(code: number): string {
  const mapped = ZK_STATUS_TO_PUNCH_TYPE[code];
  if (mapped === undefined) {
    logger.warn(`Unknown ZK status code ${code}, defaulting to CHECK_IN`);
    return 'CHECK_IN';
  }
  return mapped;
}

export function mapVerifyCode(code: number): string | null {
  return ZK_VERIFY_TO_METHOD[code] ?? null;
}
