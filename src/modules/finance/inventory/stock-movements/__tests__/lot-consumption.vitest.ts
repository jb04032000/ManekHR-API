import { describe, it, expect } from 'vitest';
import { shouldDecrementLotQty, shouldRestoreLotQty } from '../lot-consumption';

describe('shouldDecrementLotQty', () => {
  describe('genuine outward consumption decrements the lot (both valuation methods)', () => {
    const CONSUMING: Array<
      | 'sale_out'
      | 'dc_out'
      | 'wastage_out'
      | 'purchase_return_out'
      | 'debit_note_out'
      | 'manufacturing_out'
    > = [
      'sale_out',
      'dc_out',
      'wastage_out',
      'purchase_return_out',
      'debit_note_out',
      'manufacturing_out',
    ];

    for (const movementType of CONSUMING) {
      it(`${movementType} decrements qtyRemaining`, () => {
        expect(shouldDecrementLotQty({ movementType, isInward: false, bucketType: 'stock' })).toBe(
          true,
        );
      });
    }
  });

  describe('inward movements never decrement (the lot-creating inward already set qtyRemaining)', () => {
    it('purchase_in does not decrement', () => {
      expect(
        shouldDecrementLotQty({ movementType: 'purchase_in', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });

    it('credit_note_in (sales return) does not decrement', () => {
      expect(
        shouldDecrementLotQty({
          movementType: 'credit_note_in',
          isInward: true,
          bucketType: 'stock',
        }),
      ).toBe(false);
    });

    it('manufacturing_in (return to stock) does not decrement', () => {
      expect(
        shouldDecrementLotQty({
          movementType: 'manufacturing_in',
          isInward: true,
          bucketType: 'stock',
        }),
      ).toBe(false);
    });
  });

  describe('transfers are lot-neutral (a godown move relocates the same batch)', () => {
    it('transfer_out does not decrement', () => {
      expect(
        shouldDecrementLotQty({
          movementType: 'transfer_out',
          isInward: false,
          bucketType: 'stock',
        }),
      ).toBe(false);
    });

    it('transfer_in does not decrement', () => {
      expect(
        shouldDecrementLotQty({ movementType: 'transfer_in', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });
  });

  describe('reservations are lot-neutral (earmark only, no physical movement)', () => {
    it('so_reserve does not decrement', () => {
      expect(
        shouldDecrementLotQty({ movementType: 'so_reserve', isInward: false, bucketType: 'stock' }),
      ).toBe(false);
    });

    it('so_release does not decrement', () => {
      expect(
        shouldDecrementLotQty({ movementType: 'so_release', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });
  });

  describe('non-stock buckets do not touch stock lots', () => {
    it('sample_out on the sample bucket does not decrement', () => {
      expect(
        shouldDecrementLotQty({
          movementType: 'sample_out',
          isInward: false,
          bucketType: 'sample',
        }),
      ).toBe(false);
    });

    it('consignment_out on the consignment bucket does not decrement', () => {
      expect(
        shouldDecrementLotQty({
          movementType: 'consignment_out',
          isInward: false,
          bucketType: 'consignment',
        }),
      ).toBe(false);
    });
  });
});

describe('shouldRestoreLotQty', () => {
  describe('genuine stock returns to an existing lot restore qtyRemaining', () => {
    it('credit_note_in (sales return) restores', () => {
      expect(
        shouldRestoreLotQty({
          movementType: 'credit_note_in',
          isInward: true,
          bucketType: 'stock',
        }),
      ).toBe(true);
    });

    it('manufacturing_in (MV cancel returns consumed components) restores', () => {
      expect(
        shouldRestoreLotQty({
          movementType: 'manufacturing_in',
          isInward: true,
          bucketType: 'stock',
        }),
      ).toBe(true);
    });
  });

  describe('fresh-stock and outward movements never restore', () => {
    it('purchase_in does not restore (lot created with qtyRemaining = qtyInward)', () => {
      expect(
        shouldRestoreLotQty({ movementType: 'purchase_in', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });

    it('grn_in does not restore', () => {
      expect(
        shouldRestoreLotQty({ movementType: 'grn_in', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });

    it('transfer_in does not restore (relocation, lot-neutral)', () => {
      expect(
        shouldRestoreLotQty({ movementType: 'transfer_in', isInward: true, bucketType: 'stock' }),
      ).toBe(false);
    });

    it('sale_out (outward) does not restore', () => {
      expect(
        shouldRestoreLotQty({ movementType: 'sale_out', isInward: false, bucketType: 'stock' }),
      ).toBe(false);
    });
  });

  describe('non-stock buckets do not restore stock lots', () => {
    it('credit_note_in on a non-stock bucket does not restore', () => {
      expect(
        shouldRestoreLotQty({
          movementType: 'credit_note_in',
          isInward: true,
          bucketType: 'sample',
        }),
      ).toBe(false);
    });
  });
});
