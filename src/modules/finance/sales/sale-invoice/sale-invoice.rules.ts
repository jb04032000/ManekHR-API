import { BadRequestException } from '@nestjs/common';

/**
 * SAL-2: reverse charge (RCM) and Bill of Supply are mutually exclusive on a
 * single invoice.
 *  - Reverse charge (Sec 9(3)/9(4)) shifts the GST liability to the RECIPIENT
 *    — tax is still due, just paid by the buyer.
 *  - A Bill of Supply (composition dealer / wholly-exempt supply) is a NO-TAX
 *    document.
 * Flagging both produces an incoherent document (tax due AND no tax), so reject
 * it at both write paths (create + update).
 */
export function assertRcmBosExclusive(isReverseCharge: boolean, isBillOfSupply: boolean): void {
  if (isReverseCharge && isBillOfSupply) {
    throw new BadRequestException(
      'An invoice cannot be both reverse-charge and a Bill of Supply. Reverse charge shifts tax to the recipient; a Bill of Supply carries no tax.',
    );
  }
}
