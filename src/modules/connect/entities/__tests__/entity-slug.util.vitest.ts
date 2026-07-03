import { describe, it, expect } from 'vitest';
import { generateUniqueEntitySlug } from '../entity-slug.util';

/** A taken-set existence checker. */
function taken(set: Set<string>) {
  return (slug: string) => Promise.resolve(set.has(slug));
}

describe('generateUniqueEntitySlug', () => {
  it('slugifies the name and returns it when free', async () => {
    const slug = await generateUniqueEntitySlug('Rajesh Textiles', taken(new Set()));
    expect(slug).toBe('rajesh-textiles');
  });

  it('appends -2, -3 on collision', async () => {
    const slug = await generateUniqueEntitySlug(
      'Rajesh Textiles',
      taken(new Set(['rajesh-textiles', 'rajesh-textiles-2'])),
    );
    expect(slug).toBe('rajesh-textiles-3');
  });

  it('falls back to the given base when the name slugifies to empty', async () => {
    // Pure Gujarati name -> slugifyName returns '' -> fallback base used.
    const slug = await generateUniqueEntitySlug('જરી', taken(new Set()), 'company');
    expect(slug).toBe('company');
  });

  it('keeps the slug within the max length even after a suffix', async () => {
    const long = 'a'.repeat(200);
    const slug = await generateUniqueEntitySlug(long, taken(new Set(['a'.repeat(80)])));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-2')).toBe(true);
  });
});
