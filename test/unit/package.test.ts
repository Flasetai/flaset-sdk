import { describe, expect, it } from 'vitest';
import * as root from '../../src/index.js';
import * as deals from '../../src/deals/index.js';

describe('the package', () => {
  it('has Flash Deals as its deals part, also at the root', () => {
    expect(root.deals).toBeDefined();
    for (const [name, value] of Object.entries(deals)) {
      expect(root.deals[name as keyof typeof deals]).toBe(value);
      expect(root[name as keyof typeof root]).toBe(value);
    }
  });

  it('throws one FlasetError, under its earlier name too', () => {
    expect(root.FlashDealsError).toBe(root.FlasetError);
    expect(() => root.chainOf(10)).toThrow(root.FlasetError);
    expect(() => deals.decodeDealLink('#d=***')).toThrow(root.FlashDealsError);
  });
});
