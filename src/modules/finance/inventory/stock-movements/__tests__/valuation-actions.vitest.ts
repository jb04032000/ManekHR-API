import { describe, it, expect } from 'vitest';
import { planValuationActions } from '../valuation-actions';

describe('planValuationActions', () => {
  const NONE = { createFifoLayer: false, recalcMovingAvg: false, consumeFifoLayers: false };

  describe('inward stock receipts (non-transfer)', () => {
    it('purchase_in creates a FIFO layer and recalcs the moving average (both methods track in parallel, D-04)', () => {
      expect(
        planValuationActions({
          movementType: 'purchase_in',
          isInward: true,
          method: 'moving_average',
          bucketType: 'stock',
        }),
      ).toEqual({ createFifoLayer: true, recalcMovingAvg: true, consumeFifoLayers: false });
      expect(
        planValuationActions({
          movementType: 'purchase_in',
          isInward: true,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual({ createFifoLayer: true, recalcMovingAvg: true, consumeFifoLayers: false });
    });

    it('opening_stock is a real inward (sets the average)', () => {
      expect(
        planValuationActions({
          movementType: 'opening_stock',
          isInward: true,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual({ createFifoLayer: true, recalcMovingAvg: true, consumeFifoLayers: false });
    });
  });

  describe('non-stock-bucket inwards must not touch stock valuation', () => {
    it('sample_return_in draining the sample bucket creates no layer and no avg recalc', () => {
      // accept() drains the sample bucket with a positive sample_return_in; it
      // must not mint a stock FIFO layer or move the stock moving average.
      expect(
        planValuationActions({
          movementType: 'sample_return_in',
          isInward: true,
          method: 'moving_average',
          bucketType: 'sample',
        }),
      ).toEqual(NONE);
    });

    it('consignment_return_in on the consignment bucket is valuation-neutral', () => {
      expect(
        planValuationActions({
          movementType: 'consignment_return_in',
          isInward: true,
          method: 'fifo',
          bucketType: 'consignment',
        }),
      ).toEqual(NONE);
    });

    it('sample_return_in INTO the stock bucket still creates a layer + recalcs (real stock re-entry)', () => {
      expect(
        planValuationActions({
          movementType: 'sample_return_in',
          isInward: true,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual({ createFifoLayer: true, recalcMovingAvg: true, consumeFifoLayers: false });
    });
  });

  describe('outward issues (non-transfer)', () => {
    it('sale_out consumes FIFO layers for a fifo firm on the stock bucket', () => {
      expect(
        planValuationActions({
          movementType: 'sale_out',
          isInward: false,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual({ createFifoLayer: false, recalcMovingAvg: false, consumeFifoLayers: true });
    });

    it('sale_out does nothing extra for a moving-average firm (snapshot already on the movement)', () => {
      expect(
        planValuationActions({
          movementType: 'sale_out',
          isInward: false,
          method: 'moving_average',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
    });

    it('does not consume FIFO layers for non-stock buckets', () => {
      expect(
        planValuationActions({
          movementType: 'sample_out',
          isInward: false,
          method: 'fifo',
          bucketType: 'sample',
        }),
      ).toEqual(NONE);
    });
  });

  describe('transfers are valuation-neutral (bug fix: a godown move must not change item cost)', () => {
    it('transfer_in never creates a layer or recalcs the average, for either method', () => {
      expect(
        planValuationActions({
          movementType: 'transfer_in',
          isInward: true,
          method: 'moving_average',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
      expect(
        planValuationActions({
          movementType: 'transfer_in',
          isInward: true,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
    });

    it('transfer_out never consumes layers, for either method', () => {
      expect(
        planValuationActions({
          movementType: 'transfer_out',
          isInward: false,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
      expect(
        planValuationActions({
          movementType: 'transfer_out',
          isInward: false,
          method: 'moving_average',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
    });
  });

  describe('reservations are valuation-neutral (cost is 0 for reservation-only movements)', () => {
    it('so_reserve and so_release do nothing to valuation', () => {
      expect(
        planValuationActions({
          movementType: 'so_reserve',
          isInward: false,
          method: 'fifo',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
      expect(
        planValuationActions({
          movementType: 'so_release',
          isInward: true,
          method: 'moving_average',
          bucketType: 'stock',
        }),
      ).toEqual(NONE);
    });
  });
});
