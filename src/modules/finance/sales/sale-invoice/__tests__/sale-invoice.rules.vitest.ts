import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertRcmBosExclusive } from '../sale-invoice.rules';

// SAL-2: reverse charge and Bill of Supply cannot coexist on one invoice.
describe('assertRcmBosExclusive (SAL-2 RCM/BoS mutual exclusivity)', () => {
  it('throws when BOTH reverse-charge and Bill of Supply are set', () => {
    expect(() => assertRcmBosExclusive(true, true)).toThrow(BadRequestException);
  });

  it('allows reverse-charge alone (tax shifts to the recipient)', () => {
    expect(() => assertRcmBosExclusive(true, false)).not.toThrow();
  });

  it('allows Bill of Supply alone (no-tax document)', () => {
    expect(() => assertRcmBosExclusive(false, true)).not.toThrow();
  });

  it('allows a normal invoice (neither flag)', () => {
    expect(() => assertRcmBosExclusive(false, false)).not.toThrow();
  });
});
