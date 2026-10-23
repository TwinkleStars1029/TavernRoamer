import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/drive/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves result order while respecting the active-operation limit', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async value => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maximumActive).toBe(3);
  });

  it('rejects invalid limits before running work', async () => {
    await expect(mapWithConcurrency([1], 0, async value => value)).rejects.toThrow(/positive integer/);
  });

  it('processes undefined when it is an intentional array value', async () => {
    const seen: Array<number | undefined> = [];

    const results = await mapWithConcurrency<number | undefined, number>([1, undefined, 3], 2, async value => {
      seen.push(value);
      return value ?? 0;
    });

    expect(seen).toContain(undefined);
    expect(results).toEqual([1, 0, 3]);
  });
});
