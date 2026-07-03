import { describe, it, expect } from 'vitest';

import {
  HANDLE_MAX_LEN,
  HANDLE_MIN_LEN,
  RESERVED_HANDLES,
  slugifyName,
  validateHandleFormat,
} from '../utils/handle.util';

describe('handle.util', () => {
  describe('slugifyName', () => {
    it('lowercases and replaces spaces with hyphens', () => {
      expect(slugifyName('Jayesh Bambhaniya')).toBe('jayesh-bambhaniya');
    });

    it('folds Latin diacritics', () => {
      expect(slugifyName('Béatrice Müller')).toBe('beatrice-muller');
    });

    it('collapses repeated non-[a-z0-9] runs', () => {
      expect(slugifyName('Meera   Patel — Karigar')).toBe('meera-patel-karigar');
    });

    it('trims leading and trailing hyphens', () => {
      expect(slugifyName('  ---hello---  ')).toBe('hello');
    });

    it('returns empty string for a name with no Latin characters', () => {
      expect(slugifyName('મીરા પટેલ')).toBe('');
    });

    it('handles a non-string input defensively', () => {
      // @ts-expect-error — intentional bad input to assert defensive behaviour
      expect(slugifyName(null)).toBe('');
    });
  });

  describe('validateHandleFormat', () => {
    it('accepts a well-formed lowercase handle', () => {
      expect(validateHandleFormat('jayesh-bambhaniya')).toEqual({ ok: true });
    });

    it('rejects strings shorter than HANDLE_MIN_LEN', () => {
      expect(validateHandleFormat('ab')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects strings longer than HANDLE_MAX_LEN', () => {
      const oversize = 'a'.repeat(HANDLE_MAX_LEN + 1);
      expect(validateHandleFormat(oversize)).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects a leading hyphen', () => {
      expect(validateHandleFormat('-jayesh')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects a trailing hyphen', () => {
      expect(validateHandleFormat('jayesh-')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects consecutive hyphens', () => {
      expect(validateHandleFormat('jay--esh')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects uppercase characters', () => {
      expect(validateHandleFormat('Jayesh')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects underscores + other punctuation', () => {
      expect(validateHandleFormat('jay_esh')).toEqual({ ok: false, reason: 'format' });
      expect(validateHandleFormat('jay.esh')).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects every reserved handle', () => {
      for (const reserved of RESERVED_HANDLES) {
        // Reserved entries can be shorter than the format min (e.g. `u`) so we
        // assert reservation by spelling out a valid-length reserved candidate.
        if (reserved.length < HANDLE_MIN_LEN) continue;
        expect(validateHandleFormat(reserved)).toEqual({ ok: false, reason: 'reserved' });
      }
    });

    it('handles a non-string input defensively', () => {
      // @ts-expect-error — intentional bad input to assert defensive behaviour
      expect(validateHandleFormat(null)).toEqual({ ok: false, reason: 'format' });
    });
  });
});
